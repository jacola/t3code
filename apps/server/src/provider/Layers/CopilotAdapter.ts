// @effect-diagnostics globalDate:off
// @effect-diagnostics globalDateInEffect:off
import { randomUUID } from "node:crypto";

import {
  CopilotClient,
  type CopilotClientOptions,
  type CopilotSession,
  type MessageOptions,
  type ModelInfo,
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionEvent,
  type UserToolSessionApproval,
} from "@github/copilot-sdk";
import {
  ApprovalRequestId,
  EventId,
  type ModelSelection,
  ProviderApprovalDecision,
  ProviderInstanceId,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type CopilotSettings,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  GITHUB_COPILOT_DRIVER_KIND,
  makeCopilotClientOptions,
  resolveCopilotHomePath,
} from "../Drivers/CopilotRuntimeConfig.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { loadCopilotMcpServers } from "./CopilotMcpServers.ts";
import {
  assistantUsageFields,
  beginCopilotTurn,
  clearTurnTracking,
  completionTurnRefs,
  isCopilotTurnTerminalEvent,
  markTurnAwaitingCompletion,
  normalizeCopilotAssistantUsage,
  recordTurnUsage,
  type CopilotTurnTrackingState,
} from "./CopilotTurnTracking.ts";

const PROVIDER = GITHUB_COPILOT_DRIVER_KIND;
const USER_INPUT_QUESTION_ID = "answer";
const USER_INPUT_QUESTION_HEADER = "Question";
type CopilotReasoningEffort = "low" | "medium" | "high" | "xhigh";
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface CopilotAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly clientFactory?: (options: CopilotClientOptions) => CopilotClientHandle;
}

interface PendingApprovalRequest {
  readonly requestType:
    | "command_execution_approval"
    | "file_change_approval"
    | "file_read_approval"
    | "dynamic_tool_call"
    | "unknown";
  readonly request: PermissionRequest;
  readonly turnId: TurnId | undefined;
  readonly resolve: (result: PermissionRequestResult) => void;
}

interface PendingUserInputRequest {
  readonly request: {
    readonly question: string;
    readonly choices?: ReadonlyArray<string> | undefined;
    readonly allowFreeform?: boolean | undefined;
  };
  readonly turnId: TurnId | undefined;
  readonly resolve: (result: { readonly answer: string; readonly wasFreeform: boolean }) => void;
}

interface CopilotSessionConfiguration {
  readonly model: string | undefined;
  readonly reasoningEffort: CopilotReasoningEffort | undefined;
}

interface CopilotSlashCommandInfo {
  readonly name: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly kind?: "builtin" | "skill" | "client" | string;
}

interface CopilotSlashCommandList {
  readonly commands: ReadonlyArray<CopilotSlashCommandInfo>;
}

interface CopilotSlashCommandTextResult {
  readonly kind: "text";
  readonly text: string;
  readonly markdown?: boolean;
  readonly preserveAnsi?: boolean;
  readonly runtimeSettingsChanged?: boolean;
}

interface CopilotSlashCommandAgentPromptResult {
  readonly kind: "agent-prompt";
  readonly prompt: string;
  readonly displayPrompt: string;
  readonly mode?: string;
  readonly runtimeSettingsChanged?: boolean;
}

interface CopilotSlashCommandCompletedResult {
  readonly kind: "completed";
  readonly message?: string;
  readonly runtimeSettingsChanged?: boolean;
}

interface CopilotSlashCommandSelectSubcommandResult {
  readonly kind: "select-subcommand";
  readonly command: string;
  readonly title: string;
  readonly options: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly group?: string;
  }>;
  readonly runtimeSettingsChanged?: boolean;
}

type CopilotSlashCommandInvocationResult =
  | CopilotSlashCommandTextResult
  | CopilotSlashCommandAgentPromptResult
  | CopilotSlashCommandCompletedResult
  | CopilotSlashCommandSelectSubcommandResult;

interface ParsedCopilotSlashCommand {
  readonly name: string;
  readonly input: string | undefined;
  readonly originalPrompt: string;
}

type CopilotSendAgentMode = NonNullable<MessageOptions["agentMode"]>;

interface CopilotSessionHandle {
  readonly sessionId: string;
  readonly rpc: {
    readonly mode: {
      readonly set: (input: {
        readonly mode: "interactive" | "plan" | "autopilot";
      }) => Promise<unknown>;
    };
    readonly plan: {
      readonly read: () => Promise<{
        readonly exists: boolean;
        readonly content: string | null;
        readonly path: string | null;
      }>;
    };
    readonly commands: {
      readonly list: (input?: {
        readonly includeBuiltins?: boolean;
        readonly includeSkills?: boolean;
        readonly includeClientCommands?: boolean;
      }) => Promise<CopilotSlashCommandList>;
      readonly invoke: (input: {
        readonly name: string;
        readonly input?: string;
      }) => Promise<CopilotSlashCommandInvocationResult>;
    };
  };
  readonly on: (handler: (event: SessionEvent) => void) => () => void;
  readonly send: (options: MessageOptions) => Promise<string>;
  readonly abort: CopilotSession["abort"];
  readonly disconnect: CopilotSession["disconnect"];
  readonly setModel: CopilotSession["setModel"];
  readonly getEvents: CopilotSession["getEvents"];
}

interface CopilotClientHandle {
  readonly start: () => Promise<void>;
  readonly listModels: () => Promise<ModelInfo[]>;
  readonly createSession: (
    config: Parameters<CopilotClient["createSession"]>[0],
  ) => Promise<CopilotSessionHandle>;
  readonly resumeSession: (
    sessionId: string,
    config: Parameters<CopilotClient["resumeSession"]>[1],
  ) => Promise<CopilotSessionHandle>;
  readonly stop: () => Promise<Error[]>;
}

interface ActiveCopilotSession extends CopilotTurnTrackingState {
  readonly client: CopilotClientHandle;
  session: CopilotSessionHandle;
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly semaphore: Semaphore.Semaphore;
  cwd: string | undefined;
  configDir: string | undefined;
  model: string | undefined;
  reasoningEffort: CopilotReasoningEffort | undefined;
  interactionMode: "default" | "plan" | undefined;
  updatedAt: string;
  lastError: string | undefined;
  toolTitlesByCallId: Map<string, string>;
  pendingApprovalResolvers: Map<ApprovalRequestId, PendingApprovalRequest>;
  pendingUserInputResolvers: Map<ApprovalRequestId, PendingUserInputRequest>;
  unsubscribe: () => void;
}

function toMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

function makeEventId(prefix: string): EventId {
  return EventId.make(`${prefix}-${randomUUID()}`);
}

function toTurnId(value: string | undefined): TurnId | undefined {
  return value && value.trim().length > 0 ? TurnId.make(value) : undefined;
}

function toRuntimeItemId(value: string | undefined): RuntimeItemId | undefined {
  return value && value.trim().length > 0 ? RuntimeItemId.make(value) : undefined;
}

function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return value && value.trim().length > 0 ? ProviderItemId.make(value) : undefined;
}

function toRuntimeRequestId(value: string | undefined): RuntimeRequestId | undefined {
  return value && value.trim().length > 0 ? RuntimeRequestId.make(value) : undefined;
}

function toRuntimeTaskId(value: string | undefined): RuntimeTaskId | undefined {
  return value && value.trim().length > 0 ? RuntimeTaskId.make(value) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function trimToUndefined(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function toNonNegativeInt(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value)
    ? undefined
    : Math.max(0, Math.floor(value));
}

function toPositiveInt(value: number | undefined): number | undefined {
  const normalized = toNonNegativeInt(value);
  return normalized !== undefined && normalized > 0 ? normalized : undefined;
}

function mapSessionUsageInfo(usage: Extract<SessionEvent, { type: "session.usage_info" }>["data"]) {
  const currentTokens = toNonNegativeInt(usage.currentTokens);
  const maxTokens = toPositiveInt(usage.tokenLimit);
  return {
    usedTokens: currentTokens ?? 0,
    ...(currentTokens !== undefined ? { totalProcessedTokens: currentTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

function getCopilotReasoningEffortFromSelection(
  input: ModelSelection | undefined,
  boundInstanceId: ProviderInstanceId,
): CopilotReasoningEffort | undefined {
  if (!input || input.instanceId !== boundInstanceId) return undefined;
  const reasoningEffort = getModelSelectionStringOptionValue(input, "reasoningEffort");
  return reasoningEffort === "low" ||
    reasoningEffort === "medium" ||
    reasoningEffort === "high" ||
    reasoningEffort === "xhigh"
    ? reasoningEffort
    : undefined;
}

function extractResumeSessionId(resumeCursor: unknown): string | undefined {
  if (typeof resumeCursor === "string" && resumeCursor.trim().length > 0) {
    return resumeCursor.trim();
  }
  const record = asRecord(resumeCursor);
  return normalizeString(record?.sessionId);
}

function toCopilotSessionMode(interactionMode: "default" | "plan"): "interactive" | "plan" {
  return interactionMode === "plan" ? "plan" : "interactive";
}

function toInteractionMode(mode: string): "default" | "plan" {
  return mode === "plan" ? "plan" : "default";
}

function parseCopilotSlashCommand(
  input: string | undefined,
): ParsedCopilotSlashCommand | undefined {
  const prompt = input?.trimStart();
  if (!prompt?.startsWith("/") || prompt.startsWith("//")) return undefined;
  const withoutSlash = prompt.slice(1);
  const separatorIndex = withoutSlash.search(/\s/);
  const rawName = separatorIndex >= 0 ? withoutSlash.slice(0, separatorIndex) : withoutSlash;
  const name = trimToUndefined(rawName);
  if (!name) return undefined;
  const rawInput = separatorIndex >= 0 ? withoutSlash.slice(separatorIndex).trimStart() : undefined;
  return {
    name,
    input: trimToUndefined(rawInput),
    originalPrompt: input ?? "",
  };
}

function copilotCommandMatchesName(command: CopilotSlashCommandInfo, name: string): boolean {
  const normalizedName = name.toLowerCase();
  if (command.name.toLowerCase() === normalizedName) return true;
  return (command.aliases ?? []).some((alias) => alias.toLowerCase() === normalizedName);
}

function toCopilotSendAgentMode(mode: string | undefined, fallback: CopilotSendAgentMode) {
  switch (mode) {
    case "interactive":
    case "plan":
    case "autopilot":
    case "shell":
      return mode;
    default:
      return fallback;
  }
}

function approvalDecisionToPermissionResult(
  decision: ProviderApprovalDecision,
  request: PermissionRequest,
): PermissionRequestResult {
  switch (decision) {
    case "accept":
      return { kind: "approve-once" };
    case "acceptForSession": {
      const approval = sessionApprovalFromPermissionRequest(request);
      return approval ? { kind: "approve-for-session", approval } : { kind: "approve-once" };
    }
    case "cancel":
      return { kind: "user-not-available" };
    case "decline":
    default:
      return { kind: "reject" };
  }
}

function sessionApprovalFromPermissionRequest(
  request: PermissionRequest,
): UserToolSessionApproval | undefined {
  switch (request.kind) {
    case "shell": {
      const commandIdentifiers = request.commands
        .map((command) => command.identifier.trim())
        .filter((identifier) => identifier.length > 0);
      return commandIdentifiers.length > 0 ? { kind: "commands", commandIdentifiers } : undefined;
    }
    case "read":
      return request.path ? undefined : { kind: "read" };
    case "write":
      return { kind: "write" };
    case "mcp":
      return { kind: "mcp", serverName: request.serverName, toolName: request.toolName };
    case "memory":
      return { kind: "memory" };
    case "custom-tool":
      return { kind: "custom-tool", toolName: request.toolName };
    case "extension-management":
      return {
        kind: "extension-management",
        ...(request.operation ? { operation: request.operation } : {}),
      };
    case "extension-permission-access":
      return { kind: "extension-permission-access", extensionName: request.extensionName };
    default:
      return undefined;
  }
}

function requestTypeFromPermissionRequest(request: PermissionRequest) {
  switch (request.kind) {
    case "shell":
      return "command_execution_approval" as const;
    case "write":
      return "file_change_approval" as const;
    case "read":
      return "file_read_approval" as const;
    case "mcp":
    case "custom-tool":
      return "dynamic_tool_call" as const;
    default:
      return "unknown" as const;
  }
}

function requestDetailFromPermissionRequest(request: PermissionRequest): string | undefined {
  switch (request.kind) {
    case "shell":
      return trimToUndefined(request.fullCommandText ?? request.intention);
    case "write":
      return trimToUndefined(request.fileName ?? request.intention);
    case "read":
      return trimToUndefined(request.path ?? request.intention);
    case "mcp":
      return trimToUndefined(request.toolTitle ?? request.toolName);
    case "url":
      return trimToUndefined(request.url ?? request.intention);
    case "custom-tool":
      return trimToUndefined(request.toolName ?? request.toolDescription);
    default:
      return undefined;
  }
}

function itemTypeFromToolEvent(event: Extract<SessionEvent, { type: "tool.execution_start" }>) {
  return event.data.mcpToolName ? "mcp_tool_call" : "dynamic_tool_call";
}

function toolDetailFromEvent(data: {
  readonly toolName?: string | undefined;
  readonly mcpToolName?: string | undefined;
  readonly mcpServerName?: string | undefined;
}): string | undefined {
  return trimToUndefined(
    [data.mcpServerName, data.mcpToolName ?? data.toolName].filter(Boolean).join(" / "),
  );
}

function withRefs(input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly eventId: EventId;
  readonly createdAt: string;
  readonly turnId: TurnId | undefined;
  readonly providerTurnId?: TurnId | undefined;
  readonly itemId: string | undefined;
  readonly requestId: string | undefined;
  readonly rawMethod: string | undefined;
  readonly rawPayload: unknown;
}): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const providerTurnId = input.providerTurnId ?? input.turnId;
  const providerItemId = toProviderItemId(input.itemId);
  const providerRequestId = trimToUndefined(input.requestId);
  return {
    eventId: input.eventId,
    provider: PROVIDER,
    providerInstanceId: input.providerInstanceId,
    threadId: input.threadId,
    createdAt: input.createdAt,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: toRuntimeItemId(input.itemId) } : {}),
    ...(input.requestId ? { requestId: toRuntimeRequestId(input.requestId) } : {}),
    ...(providerTurnId || providerItemId || providerRequestId
      ? {
          providerRefs: {
            ...(providerTurnId ? { providerTurnId } : {}),
            ...(providerItemId ? { providerItemId } : {}),
            ...(providerRequestId ? { providerRequestId } : {}),
          },
        }
      : {}),
    raw: {
      source: input.rawMethod ? "copilot.sdk.session-event" : "copilot.sdk.synthetic",
      ...(input.rawMethod ? { method: input.rawMethod } : {}),
      payload: input.rawPayload,
    },
  };
}

function mapHistoryToTurns(
  threadId: ThreadId,
  events: ReadonlyArray<SessionEvent>,
): ProviderThreadSnapshot {
  const turns: Array<ProviderThreadTurnSnapshot> = [];
  let current: { id: TurnId; items: Array<unknown> } | undefined;

  for (const event of events) {
    if (event.type === "assistant.turn_start") {
      current = {
        id: TurnId.make(event.data.turnId),
        items: [event],
      };
      turns.push(current);
      continue;
    }

    if (!current) continue;
    current.items.push(event);
    if (isCopilotTurnTerminalEvent(event)) {
      current = undefined;
    }
  }

  return {
    threadId,
    turns: turns.map((turn) => ({ id: turn.id, items: turn.items })),
  };
}

function makeSyntheticEvent(
  providerInstanceId: ProviderInstanceId,
  threadId: ThreadId,
  type: ProviderRuntimeEvent["type"],
  payload: ProviderRuntimeEvent["payload"],
  extra?: {
    readonly turnId?: TurnId | undefined;
    readonly itemId?: string | undefined;
    readonly requestId?: string | undefined;
  },
): ProviderRuntimeEvent {
  return {
    ...withRefs({
      providerInstanceId,
      threadId,
      eventId: makeEventId("copilot-synthetic"),
      createdAt: new Date().toISOString(),
      turnId: extra?.turnId,
      itemId: extra?.itemId,
      requestId: extra?.requestId,
      rawMethod: undefined,
      rawPayload: payload,
    }),
    type,
    payload,
  } as ProviderRuntimeEvent;
}

function resolveUserInputAnswer(
  pending: PendingUserInputRequest,
  answers: ProviderUserInputAnswers,
): { readonly answer: string; readonly wasFreeform: boolean } {
  const direct = answers[USER_INPUT_QUESTION_ID];
  const candidate =
    typeof direct === "string"
      ? direct
      : Object.values(answers).find((value): value is string => typeof value === "string");
  const answer = trimToUndefined(candidate) ?? "";
  return {
    answer,
    wasFreeform: !pending.request.choices?.includes(answer),
  };
}

const defaultClientFactory = (options: CopilotClientOptions): CopilotClientHandle =>
  new CopilotClient(options);

export const makeCopilotAdapter = Effect.fn("makeCopilotAdapter")(function* (
  copilotSettings: CopilotSettings,
  options?: CopilotAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("githubCopilot");
  const serverConfig = yield* ServerConfig;
  const nativeEventLogger = options?.nativeEventLogger;
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, ActiveCopilotSession>();
  const services = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(services);

  const emitRuntimeEvents = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
    runPromise(Queue.offerAll(runtimeEventQueue, events).pipe(Effect.asVoid)).catch(
      () => undefined,
    );

  const writeNativeEvent = (threadId: ThreadId, event: SessionEvent) => {
    if (!nativeEventLogger) return Promise.resolve();
    return runPromise(nativeEventLogger.write(event, threadId)).catch(() => undefined);
  };

  const currentSyntheticTurnId = (record: ActiveCopilotSession) =>
    completionTurnRefs(record).turnId ?? record.currentTurnId;

  const syncInteractionMode = (
    record: ActiveCopilotSession,
    interactionMode: "default" | "plan",
  ) => {
    if (record.interactionMode === interactionMode) return Effect.void;
    return Effect.tryPromise({
      try: async () => {
        await record.session.rpc.mode.set({ mode: toCopilotSessionMode(interactionMode) });
        record.interactionMode = interactionMode;
      },
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.mode.set",
          detail: toMessage(cause, "Failed to switch GitHub Copilot interaction mode."),
          cause,
        }),
    });
  };

  const emitLatestProposedPlan = (record: ActiveCopilotSession) =>
    Effect.tryPromise({
      try: () => record.session.rpc.plan.read(),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.plan.read",
          detail: toMessage(cause, "Failed to read the GitHub Copilot plan."),
          cause,
        }),
    }).pipe(
      Effect.flatMap((plan) => {
        const planMarkdown = trimToUndefined(plan.content ?? undefined);
        if (!plan.exists || !planMarkdown) return Effect.void;
        return Queue.offer(
          runtimeEventQueue,
          makeSyntheticEvent(
            boundInstanceId,
            record.threadId,
            "turn.proposed.completed",
            { planMarkdown },
            { turnId: currentSyntheticTurnId(record) },
          ),
        ).pipe(Effect.asVoid);
      }),
    );

  const emitCompletedSlashCommandTurn = (
    record: ActiveCopilotSession,
    turnId: TurnId,
    result: CopilotSlashCommandTextResult | CopilotSlashCommandCompletedResult,
  ) => {
    const message =
      result.kind === "text" ? trimToUndefined(result.text) : trimToUndefined(result.message);
    const itemId = message ? `copilot-command-${randomUUID()}` : undefined;
    const events: ProviderRuntimeEvent[] = [
      makeSyntheticEvent(
        boundInstanceId,
        record.threadId,
        "turn.started",
        record.model ? { model: record.model } : {},
        { turnId },
      ),
      makeSyntheticEvent(boundInstanceId, record.threadId, "session.state.changed", {
        state: "running",
        reason: "slash-command.invoked",
      }),
      ...(message && itemId
        ? [
            makeSyntheticEvent(
              boundInstanceId,
              record.threadId,
              "content.delta",
              { streamKind: "assistant_text", delta: message },
              { turnId, itemId },
            ),
            makeSyntheticEvent(
              boundInstanceId,
              record.threadId,
              "item.completed",
              {
                itemType: "assistant_message",
                status: "completed",
                title: "GitHub Copilot command",
                detail: message,
                data: result,
              },
              { turnId, itemId },
            ),
          ]
        : []),
      makeSyntheticEvent(
        boundInstanceId,
        record.threadId,
        "turn.completed",
        { state: "completed" },
        { turnId },
      ),
      makeSyntheticEvent(boundInstanceId, record.threadId, "session.state.changed", {
        state: "ready",
        reason: "slash-command.completed",
      }),
      makeSyntheticEvent(boundInstanceId, record.threadId, "thread.state.changed", {
        state: "idle",
        detail: result,
      }),
    ];
    record.pendingTurnIds = record.pendingTurnIds.filter((candidate) => candidate !== turnId);
    clearTurnTracking(record);
    return Queue.offerAll(runtimeEventQueue, events).pipe(Effect.asVoid);
  };

  const dispatchCopilotSkillSlashCommand = (input: {
    readonly record: ActiveCopilotSession;
    readonly command: ParsedCopilotSlashCommand;
    readonly turnId: TurnId;
    readonly fallbackAgentMode: CopilotSendAgentMode;
  }): Effect.Effect<
    | { readonly kind: "send"; readonly prompt: string; readonly agentMode: CopilotSendAgentMode }
    | { readonly kind: "completed" },
    ProviderAdapterRequestError
  > =>
    Effect.gen(function* () {
      const commandList = yield* Effect.tryPromise({
        try: () =>
          input.record.session.rpc.commands.list({
            includeBuiltins: false,
            includeSkills: true,
            includeClientCommands: false,
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.commands.list",
            detail: toMessage(cause, "Failed to list GitHub Copilot slash commands."),
            cause,
          }),
      });
      const skillCommand = commandList.commands.find(
        (command) =>
          command.kind === "skill" && copilotCommandMatchesName(command, input.command.name),
      );
      if (!skillCommand) {
        return {
          kind: "send" as const,
          prompt: input.command.originalPrompt,
          agentMode: input.fallbackAgentMode,
        };
      }

      const invocationResult = yield* Effect.tryPromise({
        try: () =>
          input.record.session.rpc.commands.invoke({
            name: skillCommand.name,
            ...(input.command.input ? { input: input.command.input } : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.commands.invoke",
            detail: toMessage(cause, "Failed to invoke GitHub Copilot slash command."),
            cause,
          }),
      });

      switch (invocationResult.kind) {
        case "agent-prompt":
          return {
            kind: "send" as const,
            prompt: invocationResult.prompt,
            agentMode: toCopilotSendAgentMode(invocationResult.mode, input.fallbackAgentMode),
          };
        case "text":
        case "completed":
          yield* emitCompletedSlashCommandTurn(input.record, input.turnId, invocationResult);
          return { kind: "completed" as const };
        case "select-subcommand": {
          const options = invocationResult.options.map((option) => option.name).join(", ");
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.commands.invoke",
            detail: `GitHub Copilot slash command '/${invocationResult.command}' requires subcommand selection, which T3 Code does not support yet.${options ? ` Available subcommands: ${options}.` : ""}`,
          });
        }
      }
    });

  const mapSessionEvent = (
    record: ActiveCopilotSession,
    event: SessionEvent,
  ): ReadonlyArray<ProviderRuntimeEvent> => {
    const currentTurnId = record.currentTurnId;
    const currentProviderTurnId = record.currentProviderTurnId;
    const resolveOrchestrationTurnId = (providerTurnId: TurnId | undefined): TurnId | undefined => {
      if (providerTurnId && currentProviderTurnId && providerTurnId === currentProviderTurnId) {
        return currentTurnId ?? providerTurnId;
      }
      return currentTurnId ?? providerTurnId;
    };
    const base = (input?: {
      readonly turnId?: TurnId | undefined;
      readonly providerTurnId?: TurnId | undefined;
      readonly itemId?: string | undefined;
      readonly requestId?: string | undefined;
    }) =>
      withRefs({
        providerInstanceId: boundInstanceId,
        threadId: record.threadId,
        eventId: EventId.make(event.id),
        createdAt: event.timestamp,
        turnId: resolveOrchestrationTurnId(input?.providerTurnId ?? input?.turnId),
        providerTurnId: input?.providerTurnId ?? input?.turnId,
        itemId: input?.itemId,
        requestId: input?.requestId,
        rawMethod: event.type,
        rawPayload: event,
      });

    switch (event.type) {
      case "session.start":
      case "session.resume":
        return [
          {
            ...base(),
            type: "session.started",
            payload: {
              message:
                event.type === "session.resume"
                  ? "Resumed GitHub Copilot session"
                  : "Started GitHub Copilot session",
              resume: event.data,
            },
          },
          {
            ...base(),
            type: "thread.started",
            payload: {
              providerThreadId:
                event.type === "session.start" ? event.data.sessionId : record.session.sessionId,
            },
          },
        ];
      case "session.info":
      case "session.warning":
        return [
          {
            ...base(),
            type: "runtime.warning",
            payload: {
              message: event.data.message,
              detail: event.data,
            },
          },
        ];
      case "session.error":
        return [
          {
            ...base(),
            type: "runtime.error",
            payload: {
              message: event.data.message,
              class: "provider_error",
              detail: event.data,
            },
          },
          {
            ...base(),
            type: "session.state.changed",
            payload: { state: "error", reason: "session.error", detail: event.data },
          },
        ];
      case "session.idle": {
        const idleCompletionRefs = completionTurnRefs(record);
        const usage = normalizeCopilotAssistantUsage(record.pendingTurnUsage);
        const idleCompletionEvents: ProviderRuntimeEvent[] =
          idleCompletionRefs.turnId || idleCompletionRefs.providerTurnId
            ? [
                {
                  ...base(idleCompletionRefs),
                  type: "turn.completed",
                  payload: {
                    state: event.data.aborted ? "cancelled" : "completed",
                    ...(usage ? { usage } : {}),
                    ...assistantUsageFields(record.pendingTurnUsage),
                  },
                } satisfies ProviderRuntimeEvent,
              ]
            : [];
        return [
          ...idleCompletionEvents,
          {
            ...base(),
            type: "session.state.changed",
            payload: { state: "ready", reason: "session.idle" },
          },
          {
            ...base(),
            type: "thread.state.changed",
            payload: { state: "idle", detail: event.data },
          },
        ];
      }
      case "session.title_changed":
        return [
          {
            ...base(),
            type: "thread.metadata.updated",
            payload: { name: event.data.title, metadata: { ...event.data } },
          },
        ];
      case "session.model_change":
        return [
          {
            ...base(),
            type: "model.rerouted",
            payload: {
              fromModel: event.data.previousModel ?? "unknown",
              toModel: event.data.newModel,
              reason: event.data.cause ?? "session.model_change",
            },
          },
        ];
      case "session.plan_changed":
        return [
          {
            ...base(),
            type: "turn.plan.updated",
            payload: { explanation: `Plan ${event.data.operation}d`, plan: [] },
          },
        ];
      case "session.workspace_file_changed":
        return [
          {
            ...base(),
            type: "files.persisted",
            payload: {
              files: [{ filename: event.data.path, fileId: event.data.path }],
            },
          },
        ];
      case "session.context_changed":
        return [
          {
            ...base(),
            type: "thread.metadata.updated",
            payload: { metadata: { ...event.data } },
          },
        ];
      case "session.usage_info":
        return [
          {
            ...base(),
            type: "thread.token-usage.updated",
            payload: { usage: mapSessionUsageInfo(event.data) },
          },
        ];
      case "session.task_complete":
        return [
          {
            ...base(),
            type: "task.completed",
            payload: {
              taskId: toRuntimeTaskId(record.threadId) ?? RuntimeTaskId.make(record.threadId),
              status: "completed",
              ...(trimToUndefined(event.data.summary) ? { summary: event.data.summary } : {}),
            },
          },
        ];
      case "assistant.turn_start":
        return [
          {
            ...base({ providerTurnId: TurnId.make(event.data.turnId) }),
            type: "turn.started",
            payload: record.model ? { model: record.model } : {},
          },
          {
            ...base({ providerTurnId: TurnId.make(event.data.turnId) }),
            type: "session.state.changed",
            payload: { state: "running", reason: "assistant.turn_start" },
          },
        ];
      case "assistant.intent":
        return [
          {
            ...base(),
            type: "task.progress",
            payload: {
              taskId: RuntimeTaskId.make(record.threadId),
              description: event.data.intent,
            },
          },
        ];
      case "assistant.reasoning":
        return [
          {
            ...base({ itemId: event.data.reasoningId }),
            type: "item.completed",
            payload: {
              itemType: "reasoning",
              status: "completed",
              title: "Reasoning",
              detail: trimToUndefined(event.data.content),
              data: event.data,
            },
          },
        ];
      case "assistant.reasoning_delta":
        return [
          {
            ...base({ itemId: event.data.reasoningId }),
            type: "content.delta",
            payload: { streamKind: "reasoning_text", delta: event.data.deltaContent },
          },
        ];
      case "assistant.message":
        return [
          {
            ...base({ itemId: event.data.messageId, providerTurnId: toTurnId(event.data.turnId) }),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
              detail: trimToUndefined(event.data.content),
              data: event.data,
            },
          },
        ];
      case "assistant.message_delta":
        return [
          {
            ...base({ itemId: event.data.messageId }),
            type: "content.delta",
            payload: { streamKind: "assistant_text", delta: event.data.deltaContent },
          },
        ];
      case "assistant.turn_end":
        return [];
      case "assistant.usage": {
        const completionRefs = completionTurnRefs(record);
        const completionBase =
          completionRefs.turnId || completionRefs.providerTurnId ? base(completionRefs) : base();
        const usage = normalizeCopilotAssistantUsage(event.data);
        return usage
          ? [
              {
                ...completionBase,
                type: "thread.token-usage.updated",
                payload: { usage },
              },
            ]
          : [];
      }
      case "abort": {
        const abortedTurnRefs = completionTurnRefs(record);
        const abortedBase =
          abortedTurnRefs.turnId || abortedTurnRefs.providerTurnId ? base(abortedTurnRefs) : base();
        return [
          {
            ...abortedBase,
            type: "turn.aborted",
            payload: { reason: event.data.reason },
          },
        ];
      }
      case "tool.execution_start":
        return [
          {
            ...base({ itemId: event.data.toolCallId, providerTurnId: toTurnId(event.data.turnId) }),
            type: "item.started",
            payload: {
              itemType: itemTypeFromToolEvent(event),
              status: "inProgress",
              title: event.data.toolName ?? "Tool call",
              ...(toolDetailFromEvent(event.data)
                ? { detail: toolDetailFromEvent(event.data) }
                : {}),
              data: event.data,
            },
          },
        ];
      case "tool.execution_progress":
        return [
          {
            ...base({ itemId: event.data.toolCallId }),
            type: "tool.progress",
            payload: { toolUseId: event.data.toolCallId, summary: event.data.progressMessage },
          },
        ];
      case "tool.execution_partial_result":
        return [
          {
            ...base({ itemId: event.data.toolCallId }),
            type: "tool.progress",
            payload: { toolUseId: event.data.toolCallId, summary: event.data.partialOutput },
          },
        ];
      case "tool.execution_complete":
        return [
          {
            ...base({ itemId: event.data.toolCallId, providerTurnId: toTurnId(event.data.turnId) }),
            type: "item.completed",
            payload: {
              itemType: event.data.result?.contents?.some((content) => content.type === "terminal")
                ? "command_execution"
                : "dynamic_tool_call",
              status: event.data.success ? "completed" : "failed",
              title: record.toolTitlesByCallId.get(event.data.toolCallId) ?? "Tool call",
              ...(trimToUndefined(event.data.result?.content ?? event.data.error?.message)
                ? {
                    detail: trimToUndefined(
                      event.data.result?.content ?? event.data.error?.message,
                    ),
                  }
                : {}),
              data: event.data,
            },
          },
          ...(trimToUndefined(event.data.result?.content)
            ? [
                {
                  ...base({ itemId: event.data.toolCallId }),
                  type: "tool.summary" as const,
                  payload: {
                    summary: event.data.result?.content ?? "",
                    precedingToolUseIds: [event.data.toolCallId],
                  },
                },
              ]
            : []),
        ];
      case "skill.invoked":
        return [
          {
            ...base(),
            type: "task.progress",
            payload: {
              taskId: RuntimeTaskId.make(event.data.name),
              description: `Invoked skill ${event.data.name}`,
            },
          },
        ];
      case "subagent.started":
        return [
          {
            ...base(),
            type: "task.started",
            payload: {
              taskId: RuntimeTaskId.make(event.data.toolCallId),
              description: trimToUndefined(event.data.agentDescription),
              taskType: "subagent",
            },
          },
        ];
      case "subagent.completed":
        return [
          {
            ...base(),
            type: "task.completed",
            payload: {
              taskId: RuntimeTaskId.make(event.data.toolCallId),
              status: "completed",
              ...(trimToUndefined(event.data.agentDisplayName)
                ? { summary: event.data.agentDisplayName }
                : {}),
            },
          },
        ];
      case "subagent.failed":
        return [
          {
            ...base(),
            type: "task.completed",
            payload: {
              taskId: RuntimeTaskId.make(event.data.toolCallId),
              status: "failed",
              ...(trimToUndefined(event.data.error) ? { summary: event.data.error } : {}),
            },
          },
        ];
      default:
        return [];
    }
  };

  const createInteractionHandlers = (
    threadId: ThreadId,
    getCurrentTurnId: () => TurnId | undefined,
    getRuntimeMode: () => ProviderSession["runtimeMode"],
    pendingApprovalResolvers: Map<ApprovalRequestId, PendingApprovalRequest>,
    pendingUserInputResolvers: Map<ApprovalRequestId, PendingUserInputRequest>,
  ) => {
    const onPermissionRequest = (request: PermissionRequest) =>
      getRuntimeMode() === "full-access"
        ? Promise.resolve<PermissionRequestResult>({ kind: "approve-once" })
        : new Promise<PermissionRequestResult>((resolve) => {
            const requestId = ApprovalRequestId.make(`copilot-approval-${randomUUID()}`);
            const turnId = getCurrentTurnId();
            pendingApprovalResolvers.set(requestId, {
              requestType: requestTypeFromPermissionRequest(request),
              request,
              turnId,
              resolve,
            });
            void emitRuntimeEvents([
              makeSyntheticEvent(
                boundInstanceId,
                threadId,
                "request.opened",
                {
                  requestType: requestTypeFromPermissionRequest(request),
                  ...(requestDetailFromPermissionRequest(request)
                    ? { detail: requestDetailFromPermissionRequest(request) }
                    : {}),
                  args: request,
                },
                { requestId, turnId },
              ),
            ]);
          });

    const onUserInputRequest = (request: {
      readonly question: string;
      readonly choices?: ReadonlyArray<string>;
      readonly allowFreeform?: boolean;
    }) =>
      new Promise<{ readonly answer: string; readonly wasFreeform: boolean }>((resolve) => {
        const requestId = ApprovalRequestId.make(`copilot-user-input-${randomUUID()}`);
        const turnId = getCurrentTurnId();
        pendingUserInputResolvers.set(requestId, { request, turnId, resolve });
        void emitRuntimeEvents([
          makeSyntheticEvent(
            boundInstanceId,
            threadId,
            "user-input.requested",
            {
              questions: [
                {
                  id: USER_INPUT_QUESTION_ID,
                  header: USER_INPUT_QUESTION_HEADER,
                  question: request.question,
                  options: (request.choices ?? []).map((choice) => ({
                    label: choice,
                    description: choice,
                  })),
                  multiSelect: false,
                },
              ],
            },
            { requestId, turnId },
          ),
        ]);
      });

    return { onPermissionRequest, onUserInputRequest };
  };

  const validateSessionConfiguration = (input: {
    readonly client: CopilotClientHandle;
    readonly threadId: ThreadId;
    readonly model: string | undefined;
    readonly reasoningEffort: CopilotReasoningEffort | undefined;
  }) =>
    Effect.gen(function* () {
      if (!input.model && !input.reasoningEffort) return;

      yield* Effect.tryPromise({
        try: () => input.client.start(),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to start GitHub Copilot client."),
            cause,
          }),
      });

      const supportedModels = new Map(
        (yield* Effect.tryPromise({
          try: () => input.client.listModels(),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: toMessage(cause, "Failed to load GitHub Copilot model metadata."),
              cause,
            }),
        })).map((model) => [model.id, model] as const),
      );
      const selectedModel = input.model ? supportedModels.get(input.model) : undefined;

      if (input.model && !selectedModel) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "session.model",
          issue: `GitHub Copilot model '${input.model}' is not available in the current Copilot runtime.`,
        });
      }

      if (!input.reasoningEffort) return;
      if (!selectedModel) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "session.reasoningEffort",
          issue: "GitHub Copilot reasoning effort requires an explicit supported model selection.",
        });
      }

      const supportedReasoningEfforts = selectedModel.supportedReasoningEfforts ?? [];
      if (!supportedReasoningEfforts.includes(input.reasoningEffort)) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "session.reasoningEffort",
          issue: `GitHub Copilot model '${selectedModel.id}' does not support reasoning effort '${input.reasoningEffort}'.`,
        });
      }
    });

  const handleSessionEvent = (record: ActiveCopilotSession, event: SessionEvent) => {
    record.updatedAt = event.timestamp;
    if (event.type === "assistant.turn_start") {
      beginCopilotTurn(record, TurnId.make(event.data.turnId));
    }
    if (event.type === "assistant.usage") {
      recordTurnUsage(record, event.data);
    }
    if (event.type === "session.error") {
      record.lastError = event.data.message;
    }
    if (event.type === "session.model_change") {
      record.model = event.data.newModel;
      record.reasoningEffort =
        event.data.reasoningEffort === "low" ||
        event.data.reasoningEffort === "medium" ||
        event.data.reasoningEffort === "high" ||
        event.data.reasoningEffort === "xhigh"
          ? event.data.reasoningEffort
          : undefined;
    }
    if (event.type === "session.mode_changed") {
      record.interactionMode = toInteractionMode(event.data.newMode);
    }
    if (event.type === "tool.execution_start" && trimToUndefined(event.data.toolName)) {
      record.toolTitlesByCallId.set(event.data.toolCallId, trimToUndefined(event.data.toolName)!);
    }

    void writeNativeEvent(record.threadId, event);
    const runtimeEvents = mapSessionEvent(record, event);
    if (runtimeEvents.length > 0) {
      void emitRuntimeEvents(runtimeEvents);
    }
    if (event.type === "session.plan_changed" && event.data.operation !== "delete") {
      void runPromise(emitLatestProposedPlan(record)).catch((cause) => {
        void emitRuntimeEvents([
          makeSyntheticEvent(
            boundInstanceId,
            record.threadId,
            "runtime.warning",
            {
              message: "Failed to read GitHub Copilot plan.",
              detail: toMessage(cause, "Failed to read GitHub Copilot plan."),
            },
            { turnId: currentSyntheticTurnId(record) },
          ),
        ]);
      });
    }
    if (event.type === "tool.execution_complete") {
      record.toolTitlesByCallId.delete(event.data.toolCallId);
    }
    if (event.type === "assistant.turn_end") {
      markTurnAwaitingCompletion(record);
    }
    if (event.type === "abort" || event.type === "session.idle") {
      clearTurnTracking(record);
    }
  };

  const getSessionRecord = (
    threadId: ThreadId,
  ): Effect.Effect<ActiveCopilotSession, ProviderAdapterSessionNotFoundError> => {
    const record = sessions.get(threadId);
    if (!record) {
      return Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    }
    return Effect.succeed(record);
  };

  const stopRecord = async (record: ActiveCopilotSession) => {
    record.unsubscribe();
    for (const pending of record.pendingApprovalResolvers.values()) {
      pending.resolve({ kind: "user-not-available" });
    }
    record.pendingApprovalResolvers.clear();
    for (const pending of record.pendingUserInputResolvers.values()) {
      pending.resolve({ answer: "", wasFreeform: true });
    }
    record.pendingUserInputResolvers.clear();
    await record.session.disconnect();
    const stopErrors = await record.client.stop();
    if (stopErrors.length > 0) {
      throw stopErrors[0];
    }
    sessions.delete(record.threadId);
  };

  const createSessionRecord = Effect.fn("createSessionRecord")(function* (input: {
    readonly threadId: ThreadId;
    readonly client: CopilotClientHandle;
    readonly session: CopilotSessionHandle;
    readonly runtimeMode: ProviderSession["runtimeMode"];
    readonly pendingApprovalResolvers: Map<ApprovalRequestId, PendingApprovalRequest>;
    readonly pendingUserInputResolvers: Map<ApprovalRequestId, PendingUserInputRequest>;
    readonly cwd: string | undefined;
    readonly configDir: string | undefined;
    readonly model: string | undefined;
    readonly reasoningEffort: CopilotReasoningEffort | undefined;
  }) {
    const semaphore = yield* Semaphore.make(1);
    const record: ActiveCopilotSession = {
      client: input.client,
      session: input.session,
      threadId: input.threadId,
      createdAt: new Date().toISOString(),
      runtimeMode: input.runtimeMode,
      semaphore,
      cwd: input.cwd,
      configDir: input.configDir,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      interactionMode: undefined,
      updatedAt: new Date().toISOString(),
      lastError: undefined,
      currentTurnId: undefined,
      currentProviderTurnId: undefined,
      pendingCompletionTurnId: undefined,
      pendingCompletionProviderTurnId: undefined,
      pendingTurnIds: [],
      pendingTurnUsage: undefined,
      toolTitlesByCallId: new Map(),
      pendingApprovalResolvers: input.pendingApprovalResolvers,
      pendingUserInputResolvers: input.pendingUserInputResolvers,
      unsubscribe: () => undefined,
    };
    return record;
  });

  const startSession: ProviderAdapterShape<
    ProviderAdapterProcessError | ProviderAdapterValidationError
  >["startSession"] = (input) =>
    Effect.gen(function* () {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}', received '${input.provider}'.`,
        });
      }

      const existing = sessions.get(input.threadId);
      if (existing) {
        return {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: existing.currentTurnId ? "running" : "ready",
          runtimeMode: existing.runtimeMode,
          ...(existing.cwd ? { cwd: existing.cwd } : {}),
          ...(existing.model ? { model: existing.model } : {}),
          threadId: input.threadId,
          resumeCursor: { sessionId: existing.session.sessionId },
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt,
          ...(existing.currentTurnId ? { activeTurnId: existing.currentTurnId } : {}),
          ...(existing.lastError ? { lastError: existing.lastError } : {}),
        } satisfies ProviderSession;
      }

      const requestedModelSelection =
        input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
      const sessionConfiguration: CopilotSessionConfiguration = {
        model: requestedModelSelection?.model,
        reasoningEffort: getCopilotReasoningEffortFromSelection(
          requestedModelSelection,
          boundInstanceId,
        ),
      };
      const configDir = resolveCopilotHomePath(copilotSettings);
      const mcpServers = yield* Effect.tryPromise({
        try: () => loadCopilotMcpServers(configDir),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to load GitHub Copilot MCP configuration."),
            cause,
          }),
      });
      const resumeSessionId = extractResumeSessionId(input.resumeCursor);
      const clientOptions = makeCopilotClientOptions({
        settings: copilotSettings,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(options?.environment ? { environment: options.environment } : {}),
      });
      const client = options?.clientFactory?.(clientOptions) ?? defaultClientFactory(clientOptions);
      const pendingApprovalResolvers = new Map<ApprovalRequestId, PendingApprovalRequest>();
      const pendingUserInputResolvers = new Map<ApprovalRequestId, PendingUserInputRequest>();
      let sessionRecord: ActiveCopilotSession | undefined;
      const handlers = createInteractionHandlers(
        input.threadId,
        () => sessionRecord?.currentTurnId,
        () => sessionRecord?.runtimeMode ?? input.runtimeMode,
        pendingApprovalResolvers,
        pendingUserInputResolvers,
      );

      yield* validateSessionConfiguration({
        client,
        threadId: input.threadId,
        ...sessionConfiguration,
      });

      const session = yield* Effect.tryPromise({
        try: async () => {
          const sessionConfig = {
            ...handlers,
            ...(sessionConfiguration.model ? { model: sessionConfiguration.model } : {}),
            ...(sessionConfiguration.reasoningEffort
              ? { reasoningEffort: sessionConfiguration.reasoningEffort }
              : {}),
            ...(input.cwd ? { workingDirectory: input.cwd } : {}),
            ...(configDir ? { configDir } : {}),
            ...(mcpServers ? { mcpServers } : {}),
            enableConfigDiscovery: true,
            streaming: true,
          };
          return resumeSessionId
            ? client.resumeSession(resumeSessionId, sessionConfig)
            : client.createSession(sessionConfig);
        },
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to start GitHub Copilot session."),
            cause,
          }),
      });

      const record = yield* createSessionRecord({
        threadId: input.threadId,
        client,
        session,
        runtimeMode: input.runtimeMode,
        pendingApprovalResolvers,
        pendingUserInputResolvers,
        cwd: input.cwd,
        configDir,
        ...sessionConfiguration,
      });
      record.unsubscribe = session.on((event) => {
        handleSessionEvent(record, event);
      });
      sessionRecord = record;
      sessions.set(input.threadId, record);

      yield* Queue.offerAll(runtimeEventQueue, [
        makeSyntheticEvent(boundInstanceId, input.threadId, "session.started", {
          message: resumeSessionId
            ? "Resumed GitHub Copilot session"
            : "Started GitHub Copilot session",
          resume: { sessionId: session.sessionId },
        }),
        makeSyntheticEvent(boundInstanceId, input.threadId, "session.configured", {
          config: {
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(sessionConfiguration.model ? { model: sessionConfiguration.model } : {}),
            ...(sessionConfiguration.reasoningEffort
              ? { reasoningEffort: sessionConfiguration.reasoningEffort }
              : {}),
            ...(configDir ? { configDir } : {}),
            enableConfigDiscovery: true,
            streaming: true,
          },
        }),
        makeSyntheticEvent(boundInstanceId, input.threadId, "thread.started", {
          providerThreadId: session.sessionId,
        }),
        makeSyntheticEvent(boundInstanceId, input.threadId, "session.state.changed", {
          state: "ready",
          reason: "session.started",
        }),
      ]);

      return {
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(sessionConfiguration.model ? { model: sessionConfiguration.model } : {}),
        threadId: input.threadId,
        resumeCursor: { sessionId: session.sessionId },
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      } satisfies ProviderSession;
    });

  const sendTurn: ProviderAdapterShape<
    | ProviderAdapterProcessError
    | ProviderAdapterRequestError
    | ProviderAdapterSessionNotFoundError
    | ProviderAdapterValidationError
  >["sendTurn"] = (input) =>
    getSessionRecord(input.threadId).pipe(
      Effect.flatMap((record) =>
        record.semaphore.withPermit(
          Effect.gen(function* () {
            const requestedModelSelection =
              input.modelSelection?.instanceId === boundInstanceId
                ? input.modelSelection
                : undefined;
            const explicitReasoningEffort = getCopilotReasoningEffortFromSelection(
              requestedModelSelection,
              boundInstanceId,
            );
            const nextModel = requestedModelSelection?.model ?? record.model;
            const nextReasoningEffort =
              explicitReasoningEffort !== undefined
                ? explicitReasoningEffort
                : requestedModelSelection?.model !== undefined &&
                    requestedModelSelection.model !== record.model
                  ? undefined
                  : record.reasoningEffort;
            const attachments = (input.attachments ?? []).map((attachment) => {
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!attachmentPath) {
                throw new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session.send",
                  detail: `Invalid attachment id '${attachment.id}'.`,
                });
              }
              return {
                type: "file" as const,
                path: attachmentPath,
                displayName: attachment.name,
              };
            }) satisfies MessageOptions["attachments"];

            yield* validateSessionConfiguration({
              client: record.client,
              threadId: input.threadId,
              model: nextModel,
              reasoningEffort: nextReasoningEffort,
            });

            if (
              nextModel &&
              (nextModel !== record.model || nextReasoningEffort !== record.reasoningEffort)
            ) {
              yield* Effect.tryPromise({
                try: () =>
                  record.session.setModel(
                    nextModel,
                    nextReasoningEffort ? { reasoningEffort: nextReasoningEffort } : undefined,
                  ),
                catch: (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session.setModel",
                    detail: toMessage(cause, "Failed to switch GitHub Copilot model."),
                    cause,
                  }),
              });
              record.model = nextModel;
              record.reasoningEffort = nextReasoningEffort;
            }

            const interactionMode = input.interactionMode ?? record.interactionMode ?? "default";
            yield* syncInteractionMode(record, interactionMode);
            const agentMode = toCopilotSessionMode(interactionMode);

            const turnId = TurnId.make(`copilot-turn-${randomUUID()}`);
            record.pendingTurnIds.push(turnId);
            record.currentTurnId = turnId;
            record.currentProviderTurnId = undefined;

            yield* Effect.gen(function* () {
              const parsedSlashCommand =
                attachments && attachments.length > 0
                  ? undefined
                  : parseCopilotSlashCommand(input.input);
              const dispatch = parsedSlashCommand
                ? yield* dispatchCopilotSkillSlashCommand({
                    record,
                    command: parsedSlashCommand,
                    turnId,
                    fallbackAgentMode: agentMode,
                  })
                : { kind: "send" as const, prompt: input.input ?? "", agentMode };
              if (dispatch.kind === "completed") return;

              yield* Effect.tryPromise({
                try: () =>
                  record.session.send({
                    prompt: dispatch.prompt,
                    ...(attachments && attachments.length > 0 ? { attachments } : {}),
                    mode: "immediate",
                    agentMode: dispatch.agentMode,
                  }),
                catch: (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session.send",
                    detail: toMessage(cause, "Failed to send GitHub Copilot turn."),
                    cause,
                  }),
              });
            }).pipe(
              Effect.tapError(() =>
                Effect.sync(() => {
                  record.pendingTurnIds = record.pendingTurnIds.filter(
                    (candidate) => candidate !== turnId,
                  );
                  if (record.currentTurnId === turnId) {
                    record.currentTurnId = undefined;
                  }
                }),
              ),
            );

            record.updatedAt = new Date().toISOString();
            return {
              threadId: input.threadId,
              turnId,
              resumeCursor: { sessionId: record.session.sessionId },
            } satisfies ProviderTurnStartResult;
          }),
        ),
      ),
    );

  const interruptTurn: ProviderAdapterShape<
    ProviderAdapterRequestError | ProviderAdapterSessionNotFoundError
  >["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const record = yield* getSessionRecord(threadId);
      yield* Effect.tryPromise({
        try: () => record.session.abort(),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.abort",
            detail: toMessage(cause, "Failed to interrupt GitHub Copilot turn."),
            cause,
          }),
      });
    });

  const respondToRequest: ProviderAdapterShape<
    ProviderAdapterRequestError | ProviderAdapterSessionNotFoundError
  >["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.gen(function* () {
      const record = yield* getSessionRecord(threadId);
      const pending = record.pendingApprovalResolvers.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.permission.respond",
          detail: `Unknown pending GitHub Copilot approval request '${requestId}'.`,
        });
      }
      record.pendingApprovalResolvers.delete(requestId);
      const resolution = approvalDecisionToPermissionResult(decision, pending.request);
      pending.resolve(resolution);
      yield* Queue.offer(
        runtimeEventQueue,
        makeSyntheticEvent(
          boundInstanceId,
          threadId,
          "request.resolved",
          { requestType: pending.requestType, decision, resolution },
          { requestId, turnId: pending.turnId },
        ),
      );
    });

  const respondToUserInput: ProviderAdapterShape<
    ProviderAdapterRequestError | ProviderAdapterSessionNotFoundError
  >["respondToUserInput"] = (threadId, requestId, answers) =>
    Effect.gen(function* () {
      const record = yield* getSessionRecord(threadId);
      const pending = record.pendingUserInputResolvers.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.userInput.respond",
          detail: `Unknown pending GitHub Copilot user-input request '${requestId}'.`,
        });
      }
      record.pendingUserInputResolvers.delete(requestId);
      pending.resolve(resolveUserInputAnswer(pending, answers));
      yield* Queue.offer(
        runtimeEventQueue,
        makeSyntheticEvent(
          boundInstanceId,
          threadId,
          "user-input.resolved",
          { answers },
          { requestId, turnId: pending.turnId },
        ),
      );
    });

  const stopSession: ProviderAdapterShape<
    ProviderAdapterProcessError | ProviderAdapterSessionNotFoundError
  >["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const record = yield* getSessionRecord(threadId);
      yield* Effect.tryPromise({
        try: () => stopRecord(record),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: toMessage(cause, "Failed to stop GitHub Copilot session."),
            cause,
          }),
      });
    });

  const listSessions: ProviderAdapterShape<never>["listSessions"] = () =>
    Effect.sync(() =>
      Array.from(sessions.values()).map((record) => {
        const session: Mutable<ProviderSession> = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: record.currentTurnId ? "running" : "ready",
          runtimeMode: record.runtimeMode,
          threadId: record.threadId,
          resumeCursor: { sessionId: record.session.sessionId },
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        };
        if (record.cwd) session.cwd = record.cwd;
        if (record.model) session.model = record.model;
        if (record.currentTurnId) session.activeTurnId = record.currentTurnId;
        if (record.lastError) session.lastError = record.lastError;
        return session;
      }),
    );

  const hasSession: ProviderAdapterShape<never>["hasSession"] = (threadId) =>
    Effect.sync(() => sessions.has(threadId));

  const readThread: ProviderAdapterShape<
    ProviderAdapterRequestError | ProviderAdapterSessionNotFoundError
  >["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const record = yield* getSessionRecord(threadId);
      return yield* Effect.tryPromise({
        try: async () => mapHistoryToTurns(threadId, await record.session.getEvents()),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.getEvents",
            detail: toMessage(cause, "Failed to read GitHub Copilot thread history."),
            cause,
          }),
      });
    });

  const rollbackThread: ProviderAdapterShape<ProviderAdapterRequestError>["rollbackThread"] = () =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread.rollback",
        detail:
          "GitHub Copilot SDK does not expose a supported conversation rollback API for existing sessions.",
      }),
    );

  const stopAll: ProviderAdapterShape<ProviderAdapterProcessError>["stopAll"] = () =>
    Effect.tryPromise({
      try: async () => {
        await Promise.all(Array.from(sessions.values()).map((record) => stopRecord(record)));
      },
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: ThreadId.make("_all"),
          detail: toMessage(cause, "Failed to stop GitHub Copilot sessions."),
          cause,
        }),
    });

  yield* Effect.addFinalizer(() =>
    stopAll().pipe(Effect.ignore, Effect.andThen(Queue.shutdown(runtimeEventQueue))),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies ProviderAdapterShape<
    | ProviderAdapterProcessError
    | ProviderAdapterRequestError
    | ProviderAdapterSessionNotFoundError
    | ProviderAdapterValidationError
  >;
});
