import { describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "@github/copilot-sdk";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CopilotSettings } from "@t3tools/contracts";

import { checkCopilotProviderStatus } from "./CopilotProvider.ts";
import type { CopilotClientProbeHandle } from "./CopilotProvider.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);

function makeProbe(overrides?: Partial<CopilotClientProbeHandle>): CopilotClientProbeHandle {
  return {
    start: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => ({ version: "1.2.3" })),
    getAuthStatus: vi.fn(async () => ({
      isAuthenticated: true,
      authType: "gh-cli",
      login: "octocat",
    })),
    listModels: vi.fn(
      async (): Promise<ModelInfo[]> => [
        {
          id: "gpt-5",
          name: "GPT-5",
          capabilities: {
            supports: { vision: true, reasoningEffort: true },
            limits: { max_context_window_tokens: 128_000 },
          },
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
          defaultReasoningEffort: "high",
        },
      ],
    ),
    discoverSkills: vi.fn(async () => []),
    stop: vi.fn(async () => []),
    ...overrides,
  };
}

describe("checkCopilotProviderStatus", () => {
  it("short-circuits disabled settings without starting the SDK client", async () => {
    const probe = makeProbe();
    const snapshot = await Effect.runPromise(
      checkCopilotProviderStatus(decodeCopilotSettings({ enabled: false }), {}, () => probe),
    );

    expect(probe.start).not.toHaveBeenCalled();
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.status).toBe("disabled");
  });

  it("maps authenticated SDK model metadata to provider models", async () => {
    const probe = makeProbe();
    const snapshot = await Effect.runPromise(
      checkCopilotProviderStatus(decodeCopilotSettings({ enabled: true }), {}, () => probe),
    );

    expect(snapshot.status).toBe("ready");
    expect(snapshot.auth).toEqual({
      status: "authenticated",
      type: "gh-cli",
      label: "GitHub Copilot (octocat)",
    });
    expect(snapshot.version).toBe("1.2.3");
    expect(snapshot.models[0]?.slug).toBe("gpt-5");
    expect(snapshot.models[0]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      id: "reasoningEffort",
      type: "select",
      currentValue: "high",
    });
    expect(snapshot.slashCommands).toEqual([]);
    expect(probe.stop).toHaveBeenCalledTimes(1);
  });

  it("maps enabled user-invocable Copilot skills to provider slash commands", async () => {
    const discoverSkills = vi.fn(async () => [
      {
        name: "review",
        description: "Review the current change",
        source: "project",
        userInvocable: true,
        enabled: true,
      },
      {
        name: "disabled-skill",
        description: "Disabled",
        source: "project",
        userInvocable: true,
        enabled: false,
      },
      {
        name: "internal-skill",
        description: "Internal",
        source: "project",
        userInvocable: false,
        enabled: true,
      },
      {
        name: " review ",
        description: "Duplicate",
        source: "project",
        userInvocable: true,
        enabled: true,
      },
    ]);
    const probe = makeProbe({ discoverSkills });
    const snapshot = await Effect.runPromise(
      checkCopilotProviderStatus(
        decodeCopilotSettings({ enabled: true }),
        {},
        () => probe,
        "/repo/project",
      ),
    );

    expect(discoverSkills).toHaveBeenCalledWith({ projectPaths: ["/repo/project"] });
    expect(snapshot.slashCommands).toEqual([
      {
        name: "review",
        description: "Review the current change",
      },
    ]);
  });
});
