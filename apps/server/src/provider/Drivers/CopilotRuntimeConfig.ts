// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { RuntimeConnection, type CopilotClientOptions } from "@github/copilot-sdk";
import { ProviderDriverKind, type CopilotSettings } from "@t3tools/contracts";

import { expandHomePath } from "../../pathExpansion.ts";

export const GITHUB_COPILOT_DRIVER_KIND = ProviderDriverKind.make("githubCopilot");

export const GITHUB_COPILOT_PRESENTATION = {
  displayName: "GitHub Copilot",
  showInteractionModeToggle: true,
} as const;

const COPILOT_PATHLESS_COMMAND_PATTERN = /^copilot(?:\.(?:exe|cmd|bat))?$/i;

function trimmedNonEmpty(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeCopilotCliPathOverride(
  value: string | undefined | null,
): string | undefined {
  const trimmed = trimmedNonEmpty(value);
  if (!trimmed) return undefined;
  if (
    !trimmed.includes("/") &&
    !trimmed.includes("\\") &&
    COPILOT_PATHLESS_COMMAND_PATTERN.test(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

export function resolveCopilotHomePath(
  settings: Pick<CopilotSettings, "homePath">,
): string | undefined {
  const homePath = trimmedNonEmpty(settings.homePath);
  return homePath ? expandHomePath(homePath) : undefined;
}

export function isCopilotCliPathOverrideMissing(
  settings: Pick<CopilotSettings, "binaryPath">,
): boolean {
  const cliPath = normalizeCopilotCliPathOverride(settings.binaryPath);
  return cliPath !== undefined && !NodeFS.existsSync(cliPath);
}

export function makeCopilotClientOptions(input: {
  readonly settings: Pick<CopilotSettings, "binaryPath" | "homePath">;
  readonly cwd?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}): CopilotClientOptions {
  const cliPath = normalizeCopilotCliPathOverride(input.settings.binaryPath);
  const homePath = resolveCopilotHomePath(input.settings);
  return {
    ...(cliPath ? { connection: RuntimeConnection.forStdio({ path: cliPath }) } : {}),
    ...(input.cwd ? { workingDirectory: input.cwd } : {}),
    ...(homePath ? { baseDirectory: homePath } : {}),
    ...(input.environment ? { env: input.environment } : {}),
    logLevel: "error",
  };
}
