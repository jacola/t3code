// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { MCPServerConfig } from "@github/copilot-sdk";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.flatMap((item) => {
    const normalized = asNonEmptyString(item);
    return normalized ? [normalized] : [];
  });
  return strings.length > 0 ? strings : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const entries = Object.entries(record).flatMap(([key, item]) => {
    const normalized = asNonEmptyString(item);
    return normalized ? [[key, normalized] as const] : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function asTimeout(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeTools(value: unknown): string[] {
  return asStringArray(value) ?? ["*"];
}

function toMcpServerConfig(entry: unknown): MCPServerConfig | undefined {
  const record = asRecord(entry);
  if (!record) return undefined;

  const type = asNonEmptyString(record.type);
  const command = asNonEmptyString(record.command);
  const args = asStringArray(record.args) ?? [];
  const url = asNonEmptyString(record.url);
  const tools = normalizeTools(record.tools);
  const timeout = asTimeout(record.timeout);
  const env = asStringRecord(record.env);
  const workingDirectory =
    asNonEmptyString(record.workingDirectory) ?? asNonEmptyString(record.cwd);
  const headers = asStringRecord(record.headers);

  if (command && (type === undefined || type === "local" || type === "stdio")) {
    return {
      type: "local",
      command,
      args,
      tools,
      ...(env ? { env } : {}),
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    };
  }

  if (url && (type === undefined || type === "http" || type === "sse")) {
    return {
      type: type === "sse" ? "sse" : "http",
      url,
      tools,
      ...(headers ? { headers } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    };
  }

  return undefined;
}

export async function loadCopilotMcpServers(
  configDir: string | undefined,
): Promise<Record<string, MCPServerConfig> | undefined> {
  const baseDir =
    configDir && configDir.trim().length > 0
      ? configDir
      : NodePath.join(NodeOS.homedir(), ".copilot");
  const configPath = NodePath.join(baseDir, "mcp-config.json");

  let raw: string;
  try {
    raw = await NodeFSP.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const parsed = asRecord(JSON.parse(raw));
  const servers = asRecord(parsed?.mcpServers);
  if (!servers) return undefined;

  const normalizedEntries = Object.entries(servers).flatMap(([name, value]) => {
    const normalized = toMcpServerConfig(value);
    return normalized ? [[name, normalized] as const] : [];
  });

  return normalizedEntries.length > 0 ? Object.fromEntries(normalizedEntries) : undefined;
}
