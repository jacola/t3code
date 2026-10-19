/**
 * Records GitHub Copilot ACP replay fixtures from the real `copilot --acp`.
 *
 *   T3_COPILOT_TOKEN="$(gh auth token)" node apps/server/scripts/record-copilot-acp-replay-fixture.ts \
 *     --scenario simple,multi_turn
 *
 * Copilot runs with a throwaway COPILOT_HOME so the recording carries no
 * personal skills, agents, MCP servers, hooks, or plugins. The token is passed
 * through the environment and never written to the transcript.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ProviderReplayEntry } from "@t3tools/contracts";
import { CopilotSettings } from "@t3tools/provider-copilot/settings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import {
  COPILOT_DEFAULT_INSTANCE_ID,
  COPILOT_PROVIDER,
  copilotLaunchRuntimeMode,
  makeCopilotAcpRuntime,
  makeCopilotAdapterV2,
  makeCopilotEnvironment,
} from "@t3tools/provider-copilot/testing";
import { ACP_PROTOCOL } from "@t3tools/provider-acp/server/adapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapterRegistry from "../src/orchestration-v2/ProviderAdapterRegistry.ts";
import { COPILOT_REPLAY_HOME } from "../src/orchestration-v2/Adapters/CopilotAdapterV2.testkit.ts";
import { provideDeterministicTestRuntime } from "../src/orchestration-v2/testkit/DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "../src/orchestration-v2/testkit/fixtures/index.ts";
import { materializeFixtureInput } from "../src/orchestration-v2/testkit/fixtures/shared.ts";
import { runOrchestratorV2Scenario } from "../src/orchestration-v2/testkit/OrchestratorScenario.ts";
import * as ProviderReplayHarness from "../src/orchestration-v2/testkit/ProviderReplayHarness.ts";

const wallClock = Clock.Clock.defaultValue();
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const HOME_PLACEHOLDER = "/home/copilot-replay";

interface JsonRpcMessage {
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface WireMessage {
  readonly direction: "incoming" | "outgoing";
  readonly message: JsonRpcMessage;
}

function readArgValues(name: string): ReadonlyArray<string> {
  const args = process.argv.slice(2);
  return args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1]!] : []));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, map));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, mapStrings(entry, map)]),
  );
}

function makeWireTee() {
  const wire: Array<WireMessage> = [];
  const attachRuntime = () => {
    let incomingBuffer = "";
    const push = (direction: WireMessage["direction"], line: string) => {
      if (line.trim().length === 0) return;
      wire.push({ direction, message: decodeJson(line) as JsonRpcMessage });
    };
    return {
      logIncoming: true,
      logOutgoing: true,
      logger: (event: EffectAcpProtocol.AcpProtocolLogEvent) =>
        Effect.sync(() => {
          if (event.stage !== "raw" || typeof event.payload !== "string") return;
          if (event.direction === "outgoing") {
            for (const line of event.payload.split("\n")) push("outgoing", line);
            return;
          }
          incomingBuffer += event.payload;
          const lines = incomingBuffer.split("\n");
          incomingBuffer = lines.pop() ?? "";
          for (const line of lines) push("incoming", line);
        }),
    };
  };
  return { wire, attachRuntime };
}

function frameLabel(kind: string, method: string, params: unknown): string {
  const update = isRecord(params) && isRecord(params.update) ? params.update : undefined;
  const updateType = typeof update?.sessionUpdate === "string" ? `:${update.sessionUpdate}` : "";
  const eventType =
    method === "github.com/copilot/sessionEvent" &&
    isRecord(params) &&
    typeof params.type === "string"
      ? `:${params.type}`
      : "";
  return `${kind}:${method}${updateType}${eventType}`;
}

function wireToEntries(wire: ReadonlyArray<WireMessage>): Array<ProviderReplayEntry> {
  const entries: Array<ProviderReplayEntry> = [];
  const t3Requests = new Map<string, string>();
  const agentRequests = new Map<string, string>();
  for (const { direction, message } of wire) {
    const type = direction === "outgoing" ? "expect_outbound" : "emit_inbound";
    if (typeof message.method === "string") {
      const isRequest = message.id !== undefined && message.id !== null;
      if (isRequest) {
        (direction === "outgoing" ? t3Requests : agentRequests).set(
          String(message.id),
          message.method,
        );
      }
      const kind = isRequest ? "request" : "notification";
      entries.push({
        type,
        label: frameLabel(kind, message.method, message.params),
        frame: {
          kind,
          method: message.method,
          ...(message.params === undefined ? {} : { params: message.params }),
        },
      });
      continue;
    }
    const pending = direction === "outgoing" ? agentRequests : t3Requests;
    const method = pending.get(String(message.id));
    if (method === undefined) continue;
    pending.delete(String(message.id));
    entries.push({
      type,
      label: `response:${method}`,
      frame: {
        kind: "response",
        method,
        ...(message.result === undefined ? {} : { result: message.result }),
        ...(message.error === undefined ? {} : { error: message.error }),
      },
    });
  }
  return entries;
}

const T3_INSTRUCTIONS_BODY = /<t3_code_instructions>\n[\s\S]*?\n<\/t3_code_instructions>/u;

function normalizeOutboundFrame(frame: Record<string, unknown>, runtimeInstructions: string) {
  const params = isRecord(frame.params) ? frame.params : undefined;
  if (params === undefined) return frame;
  switch (frame.method) {
    case "initialize":
      return {
        ...frame,
        params: Object.fromEntries(
          Object.keys(params).map((key) => [
            key,
            key === "protocolVersion" || key === "clientCapabilities" || key === "_meta"
              ? params[key]
              : "<any>",
          ]),
        ),
      };
    case "session/new":
    case "session/load":
    case "session/resume":
      return { ...frame, params: { ...params, mcpServers: "<any>" } };
    case "session/prompt": {
      if (!Array.isArray(params.prompt)) return frame;
      const prompt = params.prompt.filter(
        (part) => !(isRecord(part) && part.type === "text" && part.text === runtimeInstructions),
      );
      return {
        ...frame,
        params: {
          ...params,
          prompt: prompt.map((part) =>
            isRecord(part) && typeof part.text === "string"
              ? {
                  ...part,
                  text: part.text.replace(
                    T3_INSTRUCTIONS_BODY,
                    "<t3_code_instructions>\n<any>\n</t3_code_instructions>",
                  ),
                }
              : part,
          ),
        },
      };
    }
    default:
      return frame;
  }
}

/**
 * The account's model list names its organizations' private models, so only
 * Auto and the recorded model are kept.
 */
function keepRecordedModels(value: unknown, keep: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((entry) => keepRecordedModels(entry, keep));
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "availableModels" && Array.isArray(entry)) {
      next[key] = entry.filter((model) => isRecord(model) && keep.has(String(model.modelId)));
    } else if (key === "configOptions" && Array.isArray(entry)) {
      next[key] = entry.map((option) =>
        isRecord(option) && option.category === "model" && Array.isArray(option.options)
          ? {
              ...option,
              options: option.options.filter(
                (choice) => isRecord(choice) && keep.has(String(choice.value)),
              ),
            }
          : option,
      );
    } else {
      next[key] = keepRecordedModels(entry, keep);
    }
  }
  return next;
}

function normalizeInboundFrame(
  frame: Record<string, unknown>,
  keepModels: ReadonlySet<string>,
): Record<string, unknown> {
  const normalized = keepRecordedModels(frame, keepModels) as Record<string, unknown>;
  const result = isRecord(normalized.result) ? normalized.result : undefined;
  if (normalized.method === "initialize" && Array.isArray(result?.authMethods)) {
    return {
      ...normalized,
      result: {
        ...result,
        authMethods: result.authMethods.map((method) =>
          isRecord(method) && isRecord(method._meta) && isRecord(method._meta["terminal-auth"])
            ? {
                ...method,
                _meta: {
                  ...method._meta,
                  "terminal-auth": { ...method._meta["terminal-auth"], command: "copilot" },
                },
              }
            : method,
        ),
      },
    };
  }
  return normalized;
}

function collectSessionIds(entries: ReadonlyArray<ProviderReplayEntry>): ReadonlyArray<string> {
  const ids: Array<string> = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.length > 0 && !ids.includes(value)) ids.push(value);
  };
  for (const entry of entries) {
    if (entry.type === "runtime_exit" || !isRecord(entry.frame)) continue;
    const frame = entry.frame;
    if (frame.kind === "response" && frame.method === "session/new" && isRecord(frame.result)) {
      add(frame.result.sessionId);
    }
    if (entry.type === "emit_inbound" && isRecord(frame.params)) add(frame.params.sessionId);
  }
  return ids;
}

function normalizeEntries(input: {
  readonly entries: ReadonlyArray<ProviderReplayEntry>;
  readonly workspace: string;
  readonly copilotHome: string;
  readonly home: string;
  readonly user: string;
  readonly runtimeInstructions: string;
  readonly keepModels: ReadonlySet<string>;
}): Array<ProviderReplayEntry> {
  const replacements: Array<readonly [string, string]> = [
    ...collectSessionIds(input.entries).map(
      (id, index) =>
        [id, `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`] as const,
    ),
    [input.workspace, "<workspace>"],
    [encodeURIComponent(input.workspace), "%3Cworkspace%3E"],
    [input.copilotHome, COPILOT_REPLAY_HOME],
    [input.home, HOME_PLACEHOLDER],
  ];
  const user = /^[a-z_][a-z0-9_-]*$/iu.test(input.user) ? input.user : "";
  const userPattern = user.length === 0 ? undefined : new RegExp(`\\b${user}\\b`, "gu");
  const replaceAll = (text: string) => {
    const replaced = replacements.reduce(
      (current, [from, to]) => (from.length === 0 ? current : current.replaceAll(from, to)),
      text,
    );
    return userPattern === undefined ? replaced : replaced.replace(userPattern, "copilot-replay");
  };
  return input.entries.map((entry) => {
    if (entry.type === "runtime_exit" || !isRecord(entry.frame)) return entry;
    const frame =
      entry.type === "expect_outbound"
        ? normalizeOutboundFrame(entry.frame, input.runtimeInstructions)
        : normalizeInboundFrame(entry.frame, input.keepModels);
    return {
      ...entry,
      ...(entry.label === undefined ? {} : { label: replaceAll(entry.label) }),
      frame: mapStrings(frame, replaceAll),
    };
  });
}

const DEFAULT_COPILOT_SETTINGS = Schema.decodeUnknownSync(CopilotSettings)({});

const recordScenario = Effect.fn("recordCopilotScenario")(function* (fixtureName: string) {
  const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((candidate) => candidate.name === fixtureName);
  const variant = fixture?.providers.find((provider) => provider.driver === COPILOT_PROVIDER);
  if (fixture === undefined || variant === undefined) {
    return yield* Effect.die(new Error(`No GitHub Copilot replay fixture named '${fixtureName}'.`));
  }
  const token = process.env.T3_COPILOT_TOKEN?.trim();
  if (!token) {
    return yield* Effect.die(new Error('Set T3_COPILOT_TOKEN, for example "$(gh auth token)".'));
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fixtureInput = fixture.buildInput();
  const workspace = yield* checkpointWorkspace(fixtureName, fixtureInput.workspaceFiles);
  const realWorkspace = yield* fs.realPath(workspace);
  const copilotHome = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "t3-copilot-record-home-" }),
  );
  const materialized = yield* materializeFixtureInput({
    scenario: fixtureName,
    fixtureInput,
    driver: COPILOT_PROVIDER,
    modelSelection: variant.modelSelection,
  }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
  const scenario = {
    name: `${fixtureName}/copilot-record`,
    commands: materialized.commands,
    steps: materialized.steps.some(
      (step) =>
        step.type === "release_replay_gate" || step.type === "release_replay_gate_after_waiting",
    )
      ? materialized.steps.filter((step) => step.type === "dispatch")
      : materialized.steps.map((step) =>
          step.type === "finish_held_run" ? { ...step, type: "await_run_status" as const } : step,
        ),
    projectionThreadIds: materialized.projectionThreadIds,
    runtimePolicyOverride: { ...variant.runtimePolicyOverride, cwd: realWorkspace },
  };

  const tee = makeWireTee();
  const settings = {
    ...DEFAULT_COPILOT_SETTINGS,
    binaryPath: process.env.T3_COPILOT_BIN ?? "copilot",
  };
  const layerRegistry = ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      const environment = makeCopilotEnvironment({
        settings: { homePath: copilotHome },
        environment: { ...(yield* HostProcess.Environment), COPILOT_GITHUB_TOKEN: token },
        configuredVariableNames: new Set(["COPILOT_GITHUB_TOKEN"]),
        homeDirectory: yield* HostProcess.HomeDirectory,
      });
      const adapter = yield* makeCopilotAdapterV2({
        instanceId: COPILOT_DEFAULT_INSTANCE_ID,
        settings,
        environment,
        selfInvocation: yield* resolveSelfInvocation(),
        continuationRequests: yield* ProviderContinuationRequests.ProviderContinuationRequests,
        makeRuntime: ({ runtimePolicy, processEnvironment, ...input }) =>
          makeCopilotAcpRuntime({
            ...input,
            protocolLogging: tee.attachRuntime(),
            settings,
            environment: { ...environment, ...processEnvironment },
            runtimeMode: copilotLaunchRuntimeMode(runtimePolicy),
          }),
      });
      // The scenario runs on the replay TestClock; Copilot runs on wall time.
      const onWallClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.provideService(effect, Clock.Clock, wallClock);
      return [
        {
          ...adapter,
          openSession: (input) =>
            adapter.openSession(input).pipe(
              Effect.map((session): ProviderAdapter.ProviderAdapterV2SessionRuntime => ({
                ...session,
                startTurn: (turnInput) => onWallClock(session.startTurn(turnInput)),
                steerTurn: (turnInput) => onWallClock(session.steerTurn(turnInput)),
                interruptTurn: (turnInput) => onWallClock(session.interruptTurn(turnInput)),
                respondToRuntimeRequest: (turnInput) =>
                  onWallClock(session.respondToRuntimeRequest(turnInput)),
              })),
              onWallClock,
            ),
        },
      ];
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
        NodeServices.layer,
        IdAllocator.layer,
      ),
    ),
  );

  let quietPolls = 0;
  let seenFrames = -1;
  const waitForCopilotIdle = Effect.sleep("1 second").pipe(
    Effect.andThen(
      Effect.sync(() => {
        quietPolls = seenFrames === tee.wire.length ? quietPolls + 1 : 0;
        seenFrames = tee.wire.length;
        return quietPolls >= 3;
      }),
    ),
    Effect.repeat({ until: (idle) => idle }),
    Effect.timeout("5 minutes"),
    Effect.orDie,
    Effect.asVoid,
    Effect.provideService(Clock.Clock, wallClock),
  );
  const result = yield* runOrchestratorV2Scenario(scenario, {
    afterSteps: waitForCopilotIdle,
  }).pipe(
    Effect.provide(
      ProviderReplayHarness.layerWithRegistry(
        scenario,
        layerRegistry,
        variant.runContinuationWorker === true ? { runContinuationWorker: true } : {},
      ),
    ),
    provideDeterministicTestRuntime,
    Effect.scoped,
  );

  const entries = wireToEntries(tee.wire);
  const closedCleanly = entries.some(
    (entry) =>
      entry.type === "expect_outbound" &&
      isRecord(entry.frame) &&
      entry.frame.method === "session/close",
  );
  const initialize = entries.find(
    (entry) =>
      entry.type === "emit_inbound" && isRecord(entry.frame) && entry.frame.method === "initialize",
  );
  const agentInfo =
    initialize?.type === "emit_inbound" &&
    isRecord(initialize.frame) &&
    isRecord(initialize.frame.result) &&
    isRecord(initialize.frame.result.agentInfo)
      ? initialize.frame.result.agentInfo
      : {};
  const transcript = {
    provider: COPILOT_PROVIDER,
    protocol: ACP_PROTOCOL,
    version: "1",
    scenario: fixtureName,
    metadata: {
      generatedBy: "live-copilot-recorder",
      copilotVersion: agentInfo.version ?? "unknown",
      normalization:
        "Recorded with an empty COPILOT_HOME. Session ids are fixed UUIDs, the workspace is <workspace>, COPILOT_HOME is /home/copilot-replay/.copilot, HOME is /home/copilot-replay and the recording user is copilot-replay. Model lists keep only Auto and the recorded model. T3-owned prompt text, MCP servers and initialize params other than clientCapabilities and _meta are <any>. Timestamps are kept as recorded.",
    },
    entries: [
      ...normalizeEntries({
        entries,
        workspace: realWorkspace,
        copilotHome,
        home: process.env.HOME ?? "",
        user: process.env.USER ?? "",
        runtimeInstructions: buildRuntimeInstructions({
          harness: "GitHub Copilot",
          model: variant.modelSelection.model,
        }),
        keepModels: new Set(["auto", variant.modelSelection.model]),
      }),
      { type: "runtime_exit", status: closedCleanly ? "success" : "cancelled" } as const,
    ],
  };

  const outputPath = readArgValues("--out")[0] ?? (yield* path.fromFileUrl(variant.transcriptFile));
  const { entries: transcriptEntries, ...header } = transcript;
  yield* fs.writeFileString(
    outputPath,
    [
      encodeJson({ type: "transcript_start", ...header }),
      ...transcriptEntries.map((entry) => encodeJson(entry)),
      "",
    ].join("\n"),
  );
  yield* Console.log(
    `Wrote ${transcriptEntries.length} GitHub Copilot ACP replay entries to ${outputPath}`,
  );

  const liveFailure = yield* Effect.try(() => variant.assertOutput(result, transcript)).pipe(
    Effect.flip,
    Effect.option,
  );
  if (liveFailure._tag === "Some") {
    yield* Console.log(`Live orchestration failed ${fixtureName} assertions:`, liveFailure.value);
  }
});

const scenarios = readArgValues("--scenario").flatMap((value) => value.split(","));
if (scenarios.length === 0) {
  throw new Error("Pass --scenario <fixture name>[,<fixture name>...]");
}

await Effect.runPromise(
  Effect.forEach(scenarios, (name) => Effect.scoped(recordScenario(name)), {
    discard: true,
  }).pipe(Effect.provide(NodeServices.layer)),
);
