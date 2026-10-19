import type {
  CustomModelSetting,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";

import {
  COPILOT_AUTO_MODEL_SLUG,
  COPILOT_SUPPORTED_RUNTIME_MODES,
  COPILOT_TOKEN_ENV_NAMES,
  resolveCopilotCommand,
} from "./acpSupport.ts";
import type { CopilotCatalog } from "./catalog.ts";
import type { CopilotSettings } from "../settings.ts";

const COPILOT_PRESENTATION = {
  displayName: "GitHub Copilot",
  // ACP has no conversation truncation; rollback restores files only.
  supportsConversationRollback: false,
  showInteractionModeToggle: true,
  reportsContextWindow: true,
  supportedRuntimeModes: COPILOT_SUPPORTED_RUNTIME_MODES,
} as const;

const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const VERSION_PROBE_TIMEOUT_MS = 4_000;
const SKILLS_PROBE_TIMEOUT_MS = 4_000;
const MODELS_PENDING_MESSAGE =
  "Signed in. Refresh models or start a thread to load your Copilot model list.";

const AUTO_MODEL: ServerProviderModel = {
  slug: COPILOT_AUTO_MODEL_SLUG,
  name: "Auto",
  isCustom: false,
  isDefault: true,
  capabilities: EMPTY_CAPABILITIES,
};

function copilotModelsFromCatalog(
  catalog: CopilotCatalog,
  customModels: ReadonlyArray<CustomModelSetting>,
): ReadonlyArray<ServerProviderModel> {
  const builtIn = catalog.models.length > 0 ? catalog.models : [AUTO_MODEL];
  return providerModelsFromSettings(builtIn, customModels, EMPTY_CAPABILITIES);
}

/** `config.json` is JSON with `//` comment lines. */
export function parseCopilotSignedInUser(
  configText: string,
): { readonly login: string; readonly host: string | undefined } | null | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText.replace(/^\s*\/\/.*$/gm, ""));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const users = Array.isArray(record.loggedInUsers) ? record.loggedInUsers : [];
  const last =
    typeof record.lastLoggedInUser === "object" && record.lastLoggedInUser !== null
      ? (record.lastLoggedInUser as Record<string, unknown>)
      : undefined;
  const candidate =
    (last && users.length > 0 ? last : undefined) ??
    (users.find((user) => typeof user === "object" && user !== null) as
      | Record<string, unknown>
      | undefined);
  const login = typeof candidate?.login === "string" ? candidate.login.trim() : "";
  if (!login) return null;
  const host = typeof candidate?.host === "string" ? candidate.host.trim() : "";
  return { login, host: host || undefined };
}

/**
 * Read without starting Copilot: a token in the launch environment outranks
 * the saved login, `copilot login` records the account in `config.json`, and
 * without either Copilot uses the GitHub CLI's sign-in if there is one.
 * The saved credential itself lives in the system keychain, so a recorded
 * account can still have an expired token; sessions surface that.
 */
const readCopilotAuth = Effect.fn("readCopilotAuth")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly configPath: string;
}): Effect.fn.Return<ServerProviderAuth, never, FileSystem.FileSystem> {
  const tokenName = COPILOT_TOKEN_ENV_NAMES.find((name) => input.environment[name]?.trim());
  if (tokenName !== undefined) {
    return { status: "authenticated", type: "token", label: tokenName };
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const text = yield* fileSystem
    .readFileString(input.configPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  const user = text === undefined ? null : parseCopilotSignedInUser(text);
  // Without its own login Copilot falls back to the GitHub CLI's sign-in,
  // which cannot be checked without starting a session.
  if (user === undefined || user === null) return { status: "unknown" };
  return {
    status: "authenticated",
    type: "oauth",
    label:
      user.host && user.host !== "https://github.com" && user.host !== "github.com"
        ? `${user.login} (${user.host.replace(/^https?:\/\//, "")})`
        : user.login,
  };
});

const runCopilotCommand = (
  settings: Pick<CopilotSettings, "binaryPath">,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
) =>
  Effect.gen(function* () {
    const command = resolveCopilotCommand(settings);
    const spawnCommand = yield* resolveSpawnCommand(command, args, {
      env: environment,
      extendEnv: false,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(cwd ? { cwd } : {}),
        env: environment,
        extendEnv: false,
        shell: spawnCommand.shell,
      }),
    );
  });

/**
 * Copilot runs a skill as the `/name` slash command it advertises, so skills
 * are offered as slash commands rather than as `$skill` mentions.
 */
export function copilotSkillSlashCommands(
  stdout: string,
): ReadonlyArray<ServerProviderSlashCommand> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const commands = new Map<string, ServerProviderSlashCommand>();
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name || record.enabled === false || commands.has(name.toLowerCase())) continue;
    const description = typeof record.description === "string" ? record.description.trim() : "";
    commands.set(name.toLowerCase(), { name, ...(description ? { description } : {}) });
  }
  return [...commands.values()];
}

export const discoverCopilotSkillCommands = Effect.fn("discoverCopilotSkillCommands")(function* (
  settings: Pick<CopilotSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Effect.fn.Return<
  ReadonlyArray<ServerProviderSlashCommand>,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const result = yield* runCopilotCommand(
    settings,
    ["skill", "list", "--json"],
    environment,
    cwd,
  ).pipe(Effect.timeoutOption(SKILLS_PROBE_TIMEOUT_MS), Effect.result);
  if (
    Result.isFailure(result) ||
    Option.isNone(result.success) ||
    result.success.value.code !== 0
  ) {
    yield* Effect.logDebug("GitHub Copilot skill discovery failed.", { cwd });
    return [];
  }
  return copilotSkillSlashCommands(result.success.value.stdout);
});

/** Native commands win over a skill of the same name. */
export function mergeCopilotSlashCommands(
  ...lists: ReadonlyArray<ReadonlyArray<ServerProviderSlashCommand>>
): ReadonlyArray<ServerProviderSlashCommand> {
  const byName = new Map<string, ServerProviderSlashCommand>();
  for (const list of lists) {
    for (const command of list) {
      const key = command.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, command);
    }
  }
  return [...byName.values()];
}

/** Applies a catalog learned after the last health check. */
export function withCopilotCatalog<
  Snapshot extends Pick<ServerProvider, "models" | "slashCommands" | "message">,
>(
  snapshot: Snapshot,
  catalog: CopilotCatalog,
  customModels: ReadonlyArray<CustomModelSetting>,
): Snapshot {
  const { message, ...rest } = snapshot;
  const keepMessage =
    message !== undefined && !(message === MODELS_PENDING_MESSAGE && catalog.models.length > 0);
  return {
    ...rest,
    models: copilotModelsFromCatalog(catalog, customModels),
    slashCommands: mergeCopilotSlashCommands(catalog.slashCommands, [COMPACT_SLASH_COMMAND]),
    ...(keepMessage ? { message } : {}),
  } as Snapshot;
}

export function buildInitialCopilotProviderSnapshot(
  settings: CopilotSettings,
  catalog: CopilotCatalog,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: copilotModelsFromCatalog(catalog, settings.customModels),
      slashCommands: mergeCopilotSlashCommands(catalog.slashCommands, [COMPACT_SLASH_COMMAND]),
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking GitHub Copilot CLI availability..."
          : "GitHub Copilot is disabled in T3 Code settings.",
      },
    });
  });
}

/**
 * Never opens an ACP session: that would start the user's MCP servers and
 * hooks on every health check. Models come from the learned catalog.
 */
export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(
  function* (input: {
    readonly settings: CopilotSettings;
    readonly environment: NodeJS.ProcessEnv;
    readonly configPath: string;
    readonly catalog: CopilotCatalog;
  }): Effect.fn.Return<
    ServerProviderDraft,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
  > {
    const { settings, environment, catalog } = input;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = copilotModelsFromCatalog(catalog, settings.customModels);
    const slashCommands = mergeCopilotSlashCommands(catalog.slashCommands, [COMPACT_SLASH_COMMAND]);
    const build = (probe: Parameters<typeof buildServerProvider>[0]["probe"]) =>
      buildServerProvider({
        presentation: COPILOT_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models,
        slashCommands,
        probe,
      });

    if (!settings.enabled) {
      return build({
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot is disabled in T3 Code settings.",
      });
    }

    const versionResult = yield* runCopilotCommand(settings, ["--version"], environment).pipe(
      Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
      Effect.result,
    );
    if (Result.isFailure(versionResult)) {
      const missing = isCommandMissingCause(versionResult.failure);
      yield* Effect.logWarning("GitHub Copilot CLI health check failed.", {
        errorTag: versionResult.failure._tag,
      });
      return build({
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? "GitHub Copilot CLI (`copilot`) is not installed or not on PATH."
          : "Failed to execute the GitHub Copilot CLI health check.",
      });
    }
    if (Option.isNone(versionResult.success)) {
      return build({
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "GitHub Copilot CLI is installed but timed out while running `copilot --version`.",
      });
    }
    const output = versionResult.success.value;
    const version = parseGenericCliVersion(`${output.stdout}\n${output.stderr}`);
    if (output.code !== 0) {
      return build({
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "GitHub Copilot CLI is installed but failed to run.",
      });
    }

    const auth = yield* readCopilotAuth({ environment, configPath: input.configPath });
    return build({
      installed: true,
      version,
      status: auth.status === "authenticated" ? "ready" : "warning",
      auth,
      ...(auth.status === "unknown"
        ? {
            message:
              "No `copilot login` found. Copilot can use the GitHub CLI sign-in; run `copilot login` if threads fail.",
          }
        : catalog.models.length === 0
          ? { message: MODELS_PENDING_MESSAGE }
          : {}),
    });
  },
);

export const enrichCopilotSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<
  void,
  never,
  HttpClient.HttpClient | ProviderLatestVersions.ProviderLatestVersions
> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.flatMap(input.publishSnapshot),
    Effect.catchCause((cause) =>
      Effect.logWarning("GitHub Copilot version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
