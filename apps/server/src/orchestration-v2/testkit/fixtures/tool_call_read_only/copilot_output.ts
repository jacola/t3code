import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TOOL_CALL_READ_ONLY_PROMPT,
} from "../shared.ts";

/**
 * Copilot asks before reading outside the workspace; the read-only policy
 * answers those prompts itself, so no request reaches the user.
 */
export function assertToolCallReadOnlyCopilotOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertTurnItemTypes(projection, ["user_message", "dynamic_tool", "assistant_message"]);
  assertUserMessagesInclude(projection, [TOOL_CALL_READ_ONLY_PROMPT]);
  assertAssistantTextIncludes(projection, "read only tool fixture complete");
  assertRuntimeRequestCounts(projection, { total: 0 });

  const assistantMessages = projection.turnItems.filter(
    (item) => item.type === "assistant_message",
  );
  const finalMessage = assistantMessages.at(-1);
  assert.include(finalMessage?.text ?? "", "read only tool fixture complete");

  const reads = projection.turnItems.filter((item) => item.type === "dynamic_tool");
  assert.lengthOf(reads, 2);
  for (const read of reads) {
    assert.isBelow(read.ordinal, finalMessage?.ordinal ?? -Infinity);
    assert.strictEqual(read.status, "completed");
  }
  assert.isTrue(
    reads.some((item) => JSON.stringify(item.output ?? []).includes("cursor-read-only-fixture")),
  );
  assert.isTrue(reads.some((item) => JSON.stringify(item.output ?? []).includes("ES2022")));
  assert.deepEqual(
    reads.map((item) => (item.input as { path: string }).path).toSorted(),
    [
      "/tmp/claude-replay-tool_call_read_only/package.json",
      "/tmp/claude-replay-tool_call_read_only/tsconfig.json",
    ],
    "Copilot read paths must match the files named in the recorded prompt",
  );
}
