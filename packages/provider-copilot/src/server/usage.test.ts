import { describe, expect, it } from "@effect/vitest";

import { parseCopilotUsageLine } from "./usage.ts";

describe("parseCopilotUsageLine", () => {
  const start = JSON.stringify({
    type: "session.start",
    data: { sessionId: "session-1", producer: "copilot-agent" },
    id: "event-0",
    timestamp: "2026-10-19T03:55:34.199Z",
  });
  const usageRecord = (usage: Record<string, unknown>, id = "event-1") =>
    JSON.stringify({
      type: "session.usage_record",
      data: { usage },
      id,
      timestamp: "2026-10-19T03:55:42.062Z",
    });

  it("attributes each model request to the session that started the log", () => {
    const state = { sessionId: "" };
    expect(parseCopilotUsageLine(start, state)).toEqual([]);
    expect(state.sessionId).toBe("session-1");
    expect(
      parseCopilotUsageLine(
        usageRecord({
          model: "model-a",
          inputTokens: 20_982,
          outputTokens: 375,
          cacheReadTokens: 20_736,
          cacheWriteTokens: 0,
          reasoningTokens: 320,
          cost: 1,
          apiCallId: "call-1",
        }),
        state,
      ),
    ).toEqual([
      {
        provider: "copilot",
        timestampMs: Date.parse("2026-10-19T03:55:42.062Z"),
        model: "model-a",
        sessionId: "session-1",
        totals: {
          // Input is reported inclusive of cache reads.
          uncachedInputTokens: 246,
          cachedInputTokens: 20_736,
          cacheCreationTokens: 0,
          outputTokens: 375,
          reasoningTokens: 320,
        },
        // `cost` is a premium-request multiplier, not dollars.
        reportedCostUsd: null,
        speed: "standard",
        dedupeKey: "copilot:call-1",
      },
    ]);
  });

  it("skips other events, empty usage, and malformed lines", () => {
    const state = { sessionId: "session-1" };
    expect(
      parseCopilotUsageLine(JSON.stringify({ type: "assistant.message", data: {} }), state),
    ).toEqual([]);
    expect(parseCopilotUsageLine(usageRecord({ model: "model-a" }), state)).toEqual([]);
    expect(parseCopilotUsageLine("{", state)).toEqual([]);
  });

  it("falls back to the event id when the request id is missing", () => {
    const [record] = parseCopilotUsageLine(
      usageRecord({ model: "model-a", inputTokens: 10, outputTokens: 5 }, "event-9"),
      { sessionId: "" },
    );
    expect(record?.dedupeKey).toBe("copilot:event-9");
  });

  it("reports Copilot's billed AI credits as dollars, except for BYOK", () => {
    const billed = {
      model: "model-a",
      inputTokens: 10,
      outputTokens: 5,
      // 371.328 AI credits at $0.01 each.
      copilotUsage: { totalNanoAiu: 371_328_000_000 },
    };
    const [record] = parseCopilotUsageLine(usageRecord(billed), { sessionId: "" });
    expect(record?.reportedCostUsd).toBeCloseTo(3.71328, 10);
    const [byok] = parseCopilotUsageLine(usageRecord({ ...billed, isByok: true }), {
      sessionId: "",
    });
    expect(byok?.reportedCostUsd).toBeNull();
  });
});
