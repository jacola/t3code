import { describe, expect, it } from "@effect/vitest";

import { isCopilotPlanPath } from "./planMarkdown.ts";

describe("isCopilotPlanPath", () => {
  const home = "/Users/me/.copilot";

  it("matches the session plan file", () => {
    expect(isCopilotPlanPath(`${home}/session-state/abc-123/plan.md`, home, "linux")).toBe(true);
  });

  it("rejects other files and other locations", () => {
    expect(isCopilotPlanPath(`${home}/session-state/abc/notes.md`, home, "linux")).toBe(false);
    expect(isCopilotPlanPath(`${home}/session-state/abc/files/plan.md`, home, "linux")).toBe(false);
    expect(isCopilotPlanPath(`${home}/session-state/plan.md`, home, "linux")).toBe(false);
    expect(isCopilotPlanPath(`${home}/session-state/../plan.md`, home, "linux")).toBe(false);
    expect(isCopilotPlanPath("/repo/plan.md", home, "linux")).toBe(false);
    expect(isCopilotPlanPath(undefined, home, "linux")).toBe(false);
  });

  it("compares case-insensitively where the filesystem does", () => {
    expect(isCopilotPlanPath("/users/me/.COPILOT/session-state/a/plan.md", home, "darwin")).toBe(
      true,
    );
    expect(isCopilotPlanPath("/users/me/.COPILOT/session-state/a/plan.md", home, "linux")).toBe(
      false,
    );
    expect(
      isCopilotPlanPath(
        "C:\\Users\\Me\\.copilot\\session-state\\a\\plan.md",
        "C:\\Users\\Me\\.copilot",
        "win32",
      ),
    ).toBe(true);
  });
});
