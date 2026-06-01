import { describe, expect, it } from "vitest";
import { TurnId } from "@t3tools/contracts";

import {
  beginCopilotTurn,
  clearTurnTracking,
  completionTurnRefs,
  markTurnAwaitingCompletion,
  type CopilotTurnTrackingState,
} from "./CopilotTurnTracking.ts";

function makeState(): CopilotTurnTrackingState {
  return {
    currentTurnId: undefined,
    currentProviderTurnId: undefined,
    pendingCompletionTurnId: undefined,
    pendingCompletionProviderTurnId: undefined,
    pendingTurnIds: [],
    pendingTurnUsage: undefined,
  };
}

describe("CopilotTurnTracking", () => {
  it("pairs provider turn ids with pending orchestration turn ids", () => {
    const state = makeState();
    const orchestrationTurnId = TurnId.make("copilot-turn-1");
    const providerTurnId = TurnId.make("1");

    state.pendingTurnIds.push(orchestrationTurnId);
    beginCopilotTurn(state, providerTurnId);

    expect(state.currentTurnId).toBe(orchestrationTurnId);
    expect(state.currentProviderTurnId).toBe(providerTurnId);

    markTurnAwaitingCompletion(state);
    expect(completionTurnRefs(state)).toEqual({
      turnId: orchestrationTurnId,
      providerTurnId,
    });
  });

  it("clears active and pending completion state after terminal events", () => {
    const state = makeState();
    beginCopilotTurn(state, TurnId.make("1"));
    markTurnAwaitingCompletion(state);

    clearTurnTracking(state);

    expect(completionTurnRefs(state)).toEqual({
      turnId: undefined,
      providerTurnId: undefined,
    });
    expect(state.pendingTurnUsage).toBeUndefined();
  });
});
