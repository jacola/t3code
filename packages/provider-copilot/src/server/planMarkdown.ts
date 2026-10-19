import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/compat";

import type { AcpAdapterV2ExtensionContext } from "@t3tools/provider-acp/server/adapter";

import { isAcpPlanModeId } from "@t3tools/provider-acp/server/sessionConfig";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePath(value: string, caseInsensitive: boolean): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

/** Plan mode saves the plan as `<COPILOT_HOME>/session-state/<session>/plan.md`. */
export function isCopilotPlanPath(
  filePath: unknown,
  copilotHome: string,
  platform: NodeJS.Platform,
): filePath is string {
  if (typeof filePath !== "string" || filePath.trim().length === 0) return false;
  const caseInsensitive = platform === "win32" || platform === "darwin";
  const prefix = `${normalizePath(copilotHome, caseInsensitive)}/session-state/`;
  const candidate = normalizePath(filePath, caseInsensitive);
  if (!candidate.startsWith(prefix)) return false;
  const segments = candidate.slice(prefix.length).split("/");
  return (
    segments.length === 2 &&
    segments[1] === "plan.md" &&
    segments[0] !== "" &&
    segments[0] !== "." &&
    segments[0] !== ".."
  );
}

function planWriteFromToolCall(
  update: EffectAcpSchema.SessionNotification["update"],
): { readonly path: unknown; readonly text: string | undefined } | undefined {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return undefined;
  }
  const rawInput = update.rawInput;
  if (!isRecord(rawInput)) return undefined;
  return {
    path: rawInput.path ?? rawInput.file_path,
    text: typeof rawInput.file_text === "string" ? rawInput.file_text : undefined,
  };
}

function modeFromUpdate(update: EffectAcpSchema.SessionNotification["update"]): string | undefined {
  if (update.sessionUpdate === "current_mode_update") return update.currentModeId;
  if (update.sessionUpdate === "config_option_update") {
    const option = update.configOptions.find((candidate) => candidate.category === "mode");
    return option?.type === "select" ? option.currentValue : undefined;
  }
  return undefined;
}

/**
 * Plan mode has no exit-plan request over ACP: Copilot writes the plan with
 * its ordinary file tools and ends the turn. Agent mode also keeps a scratch
 * `plan.md`, so only writes made in Plan mode become T3's proposed plan. A
 * new plan carries its full text; an edit carries only the replaced fragment,
 * so the saved file is read once the edit completes.
 */
export function registerCopilotPlanCapture(
  context: Pick<AcpAdapterV2ExtensionContext, "runtime" | "captureProposedPlan">,
  host: {
    readonly copilotHome: string;
    readonly platform: NodeJS.Platform;
    readonly readFile: (filePath: string) => Effect.Effect<string | undefined>;
  },
) {
  const modeBySession = new Map<string, string>();
  const planWrites = new Map<
    string,
    { readonly path: string; readonly text: string | undefined }
  >();
  return context.runtime.handleSessionUpdate((notification) => {
    const update = notification.update;
    const mode = modeFromUpdate(update);
    if (mode !== undefined) {
      modeBySession.set(notification.sessionId, mode);
      return Effect.void;
    }
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
      return Effect.void;
    }
    const key = `${notification.sessionId}:${update.toolCallId}`;
    const write = planWriteFromToolCall(update);
    if (
      write !== undefined &&
      isCopilotPlanPath(write.path, host.copilotHome, host.platform) &&
      isAcpPlanModeId(modeBySession.get(notification.sessionId))
    ) {
      planWrites.set(key, { path: write.path, text: write.text });
    }
    const tracked = planWrites.get(key);
    if (tracked === undefined) return Effect.void;
    if (update.status === "failed") {
      planWrites.delete(key);
      return Effect.void;
    }
    if (update.status !== "completed") return Effect.void;
    planWrites.delete(key);
    const markdown =
      tracked.text === undefined ? host.readFile(tracked.path) : Effect.succeed(tracked.text);
    return markdown.pipe(
      Effect.flatMap((text) =>
        text?.trim() ? context.captureProposedPlan({ planMarkdown: text }) : Effect.void,
      ),
    );
  });
}
