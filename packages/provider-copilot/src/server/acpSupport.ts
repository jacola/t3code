import type { RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

import type { CopilotSettings } from "../settings.ts";

const COPILOT_HOME_ENV = "COPILOT_HOME";

/**
 * Copilot reads these in order, and each one outranks the saved `copilot login`
 * credential (`copilot help environment`).
 */
export const COPILOT_TOKEN_ENV_NAMES = [
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
] as const;

/**
 * Copilot reads these as standing grants (`--allow-all-tools` and its
 * assisted-approval judge). Permissions come only from the thread's mode, so
 * they are always removed, even when set on the instance.
 */
const COPILOT_PERMISSION_ENV_NAMES = ["COPILOT_ALLOW_ALL", "COPILOT_ASSISTED_APPROVAL"] as const;

/**
 * Copilot's native permission modes: it asks by default, `--allow-tool=write`
 * approves file writes without approving shell commands, and `--allow-all`
 * approves tools, paths, and URLs. Its assisted-approval judge is
 * experimental, so Auto is not offered.
 */
export const COPILOT_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

/** `auto` is a real Copilot model id: Copilot picks the model per request. */
export const COPILOT_AUTO_MODEL_SLUG = "auto";

/** Launch-time flags win over the user's saved Copilot permissions. */
function copilotRuntimeModeArgs(runtimeMode: RuntimeMode | undefined): ReadonlyArray<string> {
  switch (runtimeMode) {
    case "full-access":
      return ["--allow-all"];
    case "auto-accept-edits":
      return ["--allow-tool=write"];
    default:
      return [];
  }
}

export interface CopilotSpawnOptions {
  readonly runtimeMode?: RuntimeMode | undefined;
  /** Skips the built-in GitHub MCP servers, which helper sessions never use. */
  readonly disableBuiltinMcps?: boolean | undefined;
  /** Removes every tool, for text generation. */
  readonly toolless?: boolean | undefined;
}

export function copilotAcpSpawnArgs(input: CopilotSpawnOptions): ReadonlyArray<string> {
  return [
    "--acp",
    ...copilotRuntimeModeArgs(input.runtimeMode),
    ...(input.disableBuiltinMcps || input.toolless ? ["--disable-builtin-mcps"] : []),
    // An allowlist naming no real tool leaves the model without tools.
    ...(input.toolless ? ["--available-tools=t3code-no-tools"] : []),
  ];
}

export function resolveCopilotCommand(settings: Pick<CopilotSettings, "binaryPath">): string {
  return settings.binaryPath.trim() || "copilot";
}

/**
 * The instance's home path wins over an inherited `COPILOT_HOME`, so two
 * instances never share sign-in or session state. Inherited GitHub tokens
 * would silently replace the instance's own sign-in (and billing), so only a
 * token configured on the instance itself is kept. Standing permission grants
 * would bypass the thread's permission mode, so they never pass through.
 */
export function makeCopilotEnvironment(input: {
  readonly settings: Pick<CopilotSettings, "homePath">;
  readonly environment: NodeJS.ProcessEnv;
  readonly configuredVariableNames: ReadonlySet<string>;
  readonly homeDirectory: string;
}): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...input.environment };
  for (const name of COPILOT_TOKEN_ENV_NAMES) {
    if (!input.configuredVariableNames.has(name)) {
      delete next[name];
    }
  }
  for (const name of COPILOT_PERMISSION_ENV_NAMES) {
    delete next[name];
  }
  const homePath = input.settings.homePath.trim();
  if (homePath) {
    next[COPILOT_HOME_ENV] = expandHomePath(homePath, input.homeDirectory);
  } else if (next[COPILOT_HOME_ENV]?.trim()) {
    next[COPILOT_HOME_ENV] = expandHomePath(next[COPILOT_HOME_ENV].trim(), input.homeDirectory);
  }
  return next;
}

export function resolveCopilotHome(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
  join: (...segments: ReadonlyArray<string>) => string,
): string {
  const configured = environment[COPILOT_HOME_ENV]?.trim();
  return configured ? expandHomePath(configured, homeDirectory) : join(homeDirectory, ".copilot");
}

export interface CopilotAcpRuntimeInput
  extends Omit<AcpSessionRuntime.AcpSessionRuntimeOptions, "spawn">, CopilotSpawnOptions {
  readonly settings: Pick<CopilotSettings, "binaryPath">;
  readonly environment: NodeJS.ProcessEnv;
}

export const makeCopilotAcpRuntime = Effect.fn("CopilotAcpSupport.makeCopilotAcpRuntime")(
  function* (
    input: CopilotAcpRuntimeInput,
  ): Effect.fn.Return<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
  > {
    const { settings, environment, runtimeMode, disableBuiltinMcps, toolless, ...options } = input;
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...options,
        spawn: {
          command: resolveCopilotCommand(settings),
          args: [...copilotAcpSpawnArgs({ runtimeMode, disableBuiltinMcps, toolless })],
          cwd: options.cwd,
          // The environment is already complete; extending would re-add the
          // inherited tokens removed above.
          env: environment,
          extendEnv: false,
        },
      }),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  },
);
