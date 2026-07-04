// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { loadCopilotMcpServers } from "./CopilotMcpServers.ts";

describe("loadCopilotMcpServers", () => {
  it("normalizes local and remote MCP server configs", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-copilot-mcp-"));
    try {
      NodeFS.writeFileSync(
        NodePath.join(dir, "mcp-config.json"),
        JSON.stringify({
          mcpServers: {
            local: {
              command: "node",
              args: ["server.js"],
              cwd: "/tmp/local-mcp",
              env: { TOKEN: "abc" },
            },
            remote: {
              type: "sse",
              url: "https://example.com/sse",
              headers: { Authorization: "Bearer test" },
            },
          },
        }),
        "utf8",
      );

      await expect(loadCopilotMcpServers(dir)).resolves.toEqual({
        local: {
          type: "local",
          command: "node",
          args: ["server.js"],
          tools: ["*"],
          env: { TOKEN: "abc" },
          workingDirectory: "/tmp/local-mcp",
        },
        remote: {
          type: "sse",
          url: "https://example.com/sse",
          tools: ["*"],
          headers: { Authorization: "Bearer test" },
        },
      });
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
