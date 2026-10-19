import { describe, expect, it } from "@effect/vitest";

import type { ServerProvider } from "@t3tools/contracts";
import { COMPACT_SLASH_COMMAND } from "@t3tools/provider-core/server/snapshotProbe";

import {
  copilotSkillSlashCommands,
  mergeCopilotSlashCommands,
  parseCopilotSignedInUser,
  withCopilotCatalog,
} from "./status.ts";

describe("parseCopilotSignedInUser", () => {
  it("reads the last signed-in account from the commented config", () => {
    const config = [
      "// User settings belong in settings.json.",
      "// This file is managed automatically.",
      JSON.stringify({
        lastLoggedInUser: { host: "https://github.com", login: "octocat" },
        loggedInUsers: [{ host: "https://github.com", login: "octocat" }],
      }),
    ].join("\n");
    expect(parseCopilotSignedInUser(config)).toEqual({
      login: "octocat",
      host: "https://github.com",
    });
  });

  it("reports no account after sign-out", () => {
    expect(parseCopilotSignedInUser(JSON.stringify({ loggedInUsers: [] }))).toBeNull();
    expect(
      parseCopilotSignedInUser(
        JSON.stringify({ lastLoggedInUser: { login: "octocat" }, loggedInUsers: [] }),
      ),
    ).toBeNull();
  });

  it("treats an unreadable config as unknown", () => {
    expect(parseCopilotSignedInUser("{ not json")).toBeUndefined();
  });
});

describe("copilotSkillSlashCommands", () => {
  it("offers enabled skills as slash commands", () => {
    const stdout = JSON.stringify([
      { name: "commit", description: "Create commits", source: "personal-copilot", enabled: true },
      { name: "disabled-skill", description: "Off", enabled: false },
      { name: "Commit", description: "Duplicate by case", enabled: true },
      { description: "No name", enabled: true },
    ]);
    expect(copilotSkillSlashCommands(stdout)).toEqual([
      { name: "commit", description: "Create commits" },
    ]);
  });

  it("returns nothing for unexpected output", () => {
    expect(copilotSkillSlashCommands("Error: not logged in")).toEqual([]);
    expect(copilotSkillSlashCommands(JSON.stringify({ skills: [] }))).toEqual([]);
  });
});

describe("mergeCopilotSlashCommands", () => {
  it("keeps the first command of each name", () => {
    expect(
      mergeCopilotSlashCommands(
        [{ name: "compact", description: "Native" }],
        [COMPACT_SLASH_COMMAND, { name: "review" }],
      ),
    ).toEqual([{ name: "compact", description: "Native" }, { name: "review" }]);
  });
});

type CatalogSnapshot = Pick<ServerProvider, "models" | "slashCommands" | "message">;

describe("withCopilotCatalog", () => {
  it("replaces the placeholder model list and clears the pending-models notice", () => {
    const snapshot = withCopilotCatalog<CatalogSnapshot>(
      {
        models: [],
        slashCommands: [],
        message:
          "Signed in. Refresh provider status or start a thread to load your Copilot model list.",
      },
      {
        models: [{ slug: "model-a", name: "Model A", isCustom: false, capabilities: null }],
        slashCommands: [{ name: "review" }],
      },
      ["my-model"],
    );
    expect(snapshot.message).toBeUndefined();
    expect(snapshot.models.map((model) => model.slug)).toEqual(["model-a", "my-model"]);
    expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["review", "compact"]);
  });

  it("offers Auto until a model list is learned", () => {
    const snapshot = withCopilotCatalog<CatalogSnapshot>(
      { models: [], slashCommands: [], message: "Other notice" },
      { models: [], slashCommands: [] },
      [],
    );
    expect(snapshot.message).toBe("Other notice");
    expect(snapshot.models.map((model) => model.slug)).toEqual(["auto"]);
  });
});
