import { describe, expect, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";

import {
  copilotModelsFromConfigOptions,
  copilotSlashCommands,
  markCopilotDefaultModel,
} from "./catalog.ts";

const AGENT_OPTION = {
  type: "select",
  id: "agent",
  name: "Agent",
  category: "_agent",
  currentValue: "",
  options: [
    { value: "", name: "Copilot" },
    { value: "reviewer", name: "Reviewer" },
  ],
} as const;

function configOptions(input: {
  readonly currentModel: string;
  readonly effort?: ReadonlyArray<string>;
}): ReadonlyArray<EffectAcpSchema.SessionConfigOption> {
  return [
    {
      type: "select",
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: "https://agentclientprotocol.com/protocol/session-modes#agent",
      options: [
        { value: "https://agentclientprotocol.com/protocol/session-modes#agent", name: "Agent" },
        { value: "https://agentclientprotocol.com/protocol/session-modes#plan", name: "Plan" },
      ],
    },
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: input.currentModel,
      options: [
        { value: "auto", name: "Auto" },
        { value: "auto", name: "Auto" },
        { value: "model-a", name: "Model A" },
        { value: "model-b", name: "Model B" },
      ],
    },
    ...(input.effort
      ? [
          {
            type: "select" as const,
            id: "reasoning_effort",
            name: "Reasoning effort",
            category: "thought_level",
            currentValue: "medium",
            options: input.effort.map((value) => ({ value, name: value })),
          },
        ]
      : []),
    AGENT_OPTION,
    {
      type: "select",
      id: "allow_all",
      name: "Allow all",
      category: "permissions",
      currentValue: "off",
      options: [
        { value: "on", name: "On" },
        { value: "off", name: "Off" },
      ],
    },
  ] as ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
}

const descriptorIds = (model: { readonly capabilities: unknown } | undefined) =>
  (
    (model?.capabilities as { optionDescriptors?: ReadonlyArray<{ id: string }> } | null)
      ?.optionDescriptors ?? []
  ).map((descriptor) => descriptor.id);

describe("copilotModelsFromConfigOptions", () => {
  it("lists each model once and exposes only effort and agent as model options", () => {
    const models = copilotModelsFromConfigOptions(
      configOptions({ currentModel: "model-a", effort: ["low", "medium", "high"] }),
      [],
      "session",
    );
    expect(models?.map((model) => model.slug)).toEqual(["auto", "model-a", "model-b"]);
    expect(descriptorIds(models?.find((model) => model.slug === "model-a"))).toEqual([
      "reasoning_effort",
      "agent",
    ]);
    // Effort levels are per model, so models not yet seen offer only the agent.
    expect(descriptorIds(models?.find((model) => model.slug === "model-b"))).toEqual(["agent"]);
    expect(models?.find((model) => model.isDefault)?.slug).toBe("model-a");
  });

  it("keeps effort learned for other models and the account default across live updates", () => {
    const first = copilotModelsFromConfigOptions(
      configOptions({ currentModel: "model-a", effort: ["low", "high"] }),
      [],
      "session",
    );
    const second = copilotModelsFromConfigOptions(
      configOptions({ currentModel: "model-b" }),
      first ?? [],
    );
    expect(descriptorIds(second?.find((model) => model.slug === "model-a"))).toEqual([
      "reasoning_effort",
      "agent",
    ]);
    expect(descriptorIds(second?.find((model) => model.slug === "model-b"))).toEqual(["agent"]);
    expect(second?.find((model) => model.isDefault)?.slug).toBe("model-a");
  });

  it("ignores sessions without a model option", () => {
    expect(copilotModelsFromConfigOptions([AGENT_OPTION], [])).toBeUndefined();
  });
});

describe("markCopilotDefaultModel", () => {
  const model = (slug: string) => ({ slug, name: slug, isCustom: false, capabilities: null });

  it("falls back to auto when the default is unknown", () => {
    const models = markCopilotDefaultModel([model("auto"), model("model-a")], "missing");
    expect(models.find((entry) => entry.isDefault)?.slug).toBe("auto");
  });
});

describe("copilotSlashCommands", () => {
  it("drops commands that would change state T3 owns and de-duplicates", () => {
    const commands = copilotSlashCommands([
      { name: "compact", description: "Summarize", input: { type: "text", hint: "focus" } },
      { name: "model", description: "Select model" },
      { name: "allow-all", description: "Enable all permissions" },
      { name: "permissions", description: "Switch modes" },
      { name: "autopilot", description: "Autopilot" },
      { name: "cwd", description: "Change directory" },
      { name: "commit", description: "Create commits" },
      { name: "commit", description: "Duplicate" },
    ]);
    expect(commands).toEqual([
      { name: "compact", description: "Summarize", input: { hint: "focus" } },
      { name: "commit", description: "Create commits" },
    ]);
  });
});
