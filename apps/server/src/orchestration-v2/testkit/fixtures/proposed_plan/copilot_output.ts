import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertRunOrdinals,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  PROPOSED_PLAN_PROMPT,
} from "../shared.ts";

/**
 * Copilot's plan mode saves the plan to its session `plan.md` with an ordinary
 * file tool; the adapter turns that write into the proposed plan.
 */
export function assertProposedPlanCopilotOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertRunOrdinals(projection, [1]);
  assertUserMessagesInclude(projection, [PROPOSED_PLAN_PROMPT]);

  const proposedPlans = projection.plans.filter((plan) => plan.kind === "proposed_plan");
  assert.lengthOf(proposedPlans, 1);
  assert.match(proposedPlans[0]?.markdown ?? "", /replay fixtures/i);

  const proposedPlanItems = projection.turnItems.filter((item) => item.type === "proposed_plan");
  assert.lengthOf(proposedPlanItems, 1);
  assert.equal(proposedPlanItems[0]?.streaming, false);
}
