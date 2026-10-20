import type { UsageTokenTotals } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";

import { resolveCopilotHome } from "./acpSupport.ts";
import type { CopilotSettings } from "../settings.ts";

export const CopilotUsageScanState = Schema.Struct({
  sessionId: Schema.mutableKey(Schema.String),
});
export type CopilotUsageScanState = typeof CopilotUsageScanState.Type;

const initialCopilotUsageScanState = (): CopilotUsageScanState => ({ sessionId: "" });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// GitHub bills 1 AI credit as $0.01, and the log records billions of a credit.
const USD_PER_NANO_AI_CREDIT = 0.01 / 1e9;

/**
 * Copilot's `cost` is a premium-request multiplier, not dollars. Its billed
 * charge is `copilotUsage.totalNanoAiu`, absent for BYOK requests GitHub does
 * not bill.
 */
function copilotReportedCostUsd(usage: Record<string, unknown>): number | null {
  if (usage.isByok === true || !isRecord(usage.copilotUsage)) return null;
  const nanoAiu = usage.copilotUsage.totalNanoAiu;
  return typeof nanoAiu === "number" && Number.isFinite(nanoAiu) && nanoAiu >= 0
    ? nanoAiu * USD_PER_NANO_AI_CREDIT
    : null;
}

/**
 * `session.start` names the session; each `session.usage_record` is one model
 * request.
 */
function parseCopilotUsageRecord(
  parsed: unknown,
  state: CopilotUsageScanState,
): readonly UsageRecord[] {
  if (!isRecord(parsed) || !isRecord(parsed.data)) return [];
  if (parsed.type === "session.start") {
    if (typeof parsed.data.sessionId === "string") state.sessionId = parsed.data.sessionId;
    return [];
  }
  if (parsed.type !== "session.usage_record") return [];
  const usage = parsed.data.usage;
  if (!isRecord(usage)) return [];
  const timestampMs = parseTimestampMs(parsed.timestamp);
  const model = typeof usage.model === "string" ? usage.model.trim() : "";
  if (timestampMs === null || !model) return [];
  const inputTokens = tokenCount(usage.inputTokens);
  const cachedInputTokens = tokenCount(usage.cacheReadTokens);
  const cacheCreationTokens = tokenCount(usage.cacheWriteTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  const totals: UsageTokenTotals = {
    // Copilot reports input inclusive of cache reads and writes.
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoningTokens)),
  };
  if (totalTokens(totals) === 0) return [];
  const apiCallId = typeof usage.apiCallId === "string" ? usage.apiCallId : "";
  const recordId = typeof parsed.id === "string" ? parsed.id : "";
  return [
    {
      provider: "copilot",
      timestampMs,
      model,
      sessionId: state.sessionId,
      totals,
      reportedCostUsd: copilotReportedCostUsd(usage),
      speed: "standard",
      dedupeKey: apiCallId || recordId ? `copilot:${apiCallId || recordId}` : null,
    },
  ];
}

export function parseCopilotUsageLine(
  line: string,
  state: CopilotUsageScanState,
): readonly UsageRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  return parseCopilotUsageRecord(parsed, state);
}

const copilotUsageFormat: TranscriptUsageFormat<CopilotUsageScanState> = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    data: {
      sessionId: true,
      usage: {
        model: true,
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        reasoningTokens: true,
        apiCallId: true,
        isByok: true,
        copilotUsage: { totalNanoAiu: true },
      },
    },
  },
  usageMarkers: ['"session.usage_record"', '"session.start"'],
  parseLine: parseCopilotUsageLine,
  parseProjected: parseCopilotUsageRecord,
  state: { initial: initialCopilotUsageScanState, schema: CopilotUsageScanState },
};

export const copilotUsageReader: ProviderUsageReader<CopilotSettings, Path.Path> = {
  kind: "transcripts",
  provider: "copilot",
  format: copilotUsageFormat,
  directories: Effect.fn("copilotUsageReader.directories")(function* ({ config, environment }) {
    const path = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const homePath = config?.homePath.trim();
    const home = resolveCopilotHome(
      homePath ? { ...environment, COPILOT_HOME: homePath } : environment,
      homeDirectory,
      path.join,
    );
    // Session folders also hold checkpoints and file snapshots; only the
    // event log carries usage.
    return [{ dir: path.resolve(home, "session-state"), fileName: "events.jsonl" }];
  }),
};
