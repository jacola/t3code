import { describe, expect, it } from "@effect/vitest";

import { copilotAcpSpawnArgs, makeCopilotEnvironment, resolveCopilotHome } from "./acpSupport.ts";

describe("copilotAcpSpawnArgs", () => {
  it("maps each offered permission mode to Copilot's native launch flags", () => {
    expect(copilotAcpSpawnArgs({ runtimeMode: "approval-required" })).toEqual(["--acp"]);
    expect(copilotAcpSpawnArgs({ runtimeMode: "auto-accept-edits" })).toEqual([
      "--acp",
      "--allow-tool=write",
    ]);
    expect(copilotAcpSpawnArgs({ runtimeMode: "full-access" })).toEqual(["--acp", "--allow-all"]);
  });

  it("runs an unoffered mode as Supervised", () => {
    expect(copilotAcpSpawnArgs({ runtimeMode: "auto" })).toEqual(["--acp"]);
  });

  it("removes every tool for helper sessions", () => {
    expect(copilotAcpSpawnArgs({ toolless: true })).toEqual([
      "--acp",
      "--disable-builtin-mcps",
      "--available-tools=t3code-no-tools",
    ]);
    expect(copilotAcpSpawnArgs({ disableBuiltinMcps: true })).toEqual([
      "--acp",
      "--disable-builtin-mcps",
    ]);
  });
});

describe("makeCopilotEnvironment", () => {
  const base = {
    PATH: "/usr/bin",
    GH_TOKEN: "inherited-gh",
    GITHUB_TOKEN: "inherited-github",
    COPILOT_GITHUB_TOKEN: "inherited-copilot",
  };

  it("drops inherited GitHub tokens so the instance's own sign-in is used", () => {
    const environment = makeCopilotEnvironment({
      settings: { homePath: "" },
      environment: base,
      configuredVariableNames: new Set(),
      homeDirectory: "/home/me",
    });
    expect(environment.PATH).toBe("/usr/bin");
    expect(environment.GH_TOKEN).toBeUndefined();
    expect(environment.GITHUB_TOKEN).toBeUndefined();
    expect(environment.COPILOT_GITHUB_TOKEN).toBeUndefined();
  });

  it("keeps a token configured on the instance", () => {
    const environment = makeCopilotEnvironment({
      settings: { homePath: "" },
      environment: { ...base, COPILOT_GITHUB_TOKEN: "configured" },
      configuredVariableNames: new Set(["COPILOT_GITHUB_TOKEN"]),
      homeDirectory: "/home/me",
    });
    expect(environment.COPILOT_GITHUB_TOKEN).toBe("configured");
    expect(environment.GH_TOKEN).toBeUndefined();
  });

  it("never passes standing permission grants, even when configured", () => {
    const environment = makeCopilotEnvironment({
      settings: { homePath: "" },
      environment: { COPILOT_ALLOW_ALL: "true", COPILOT_ASSISTED_APPROVAL: "1" },
      configuredVariableNames: new Set(["COPILOT_ALLOW_ALL"]),
      homeDirectory: "/home/me",
    });
    expect(environment.COPILOT_ALLOW_ALL).toBeUndefined();
    expect(environment.COPILOT_ASSISTED_APPROVAL).toBeUndefined();
  });

  it("points COPILOT_HOME at the instance home", () => {
    const environment = makeCopilotEnvironment({
      settings: { homePath: "~/.copilot-work" },
      environment: { COPILOT_HOME: "/elsewhere" },
      configuredVariableNames: new Set(),
      homeDirectory: "/home/me",
    });
    expect(environment.COPILOT_HOME).toBe("/home/me/.copilot-work");
  });
});

describe("resolveCopilotHome", () => {
  const join = (...segments: ReadonlyArray<string>) => segments.join("/");

  it("defaults to ~/.copilot", () => {
    expect(resolveCopilotHome({}, "/home/me", join)).toBe("/home/me/.copilot");
  });

  it("follows COPILOT_HOME", () => {
    expect(resolveCopilotHome({ COPILOT_HOME: "~/work" }, "/home/me", join)).toBe("/home/me/work");
  });
});
