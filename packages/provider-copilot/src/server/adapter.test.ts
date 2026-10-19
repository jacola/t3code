import { describe, expect, it } from "@effect/vitest";
import * as EffectAcpErrors from "effect-acp/errors";

import { copilotPromptFailure } from "./adapter.ts";

describe("copilotPromptFailure", () => {
  it("classifies quota and rate-limit errors as usage limits", () => {
    const failure = copilotPromptFailure(
      new EffectAcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "You have exceeded your premium request quota.",
      }),
    );
    expect(failure.class).toBe("usage_limit");
  });

  it("keeps other request errors as provider errors", () => {
    const failure = copilotPromptFailure(
      new EffectAcpErrors.AcpRequestError({ code: -32603, errorMessage: "Model failed." }),
    );
    expect(failure.class).toBe("provider_error");
  });
});
