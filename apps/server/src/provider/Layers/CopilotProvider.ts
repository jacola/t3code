import { CopilotClient, type CopilotClientOptions, type ModelInfo } from "@github/copilot-sdk";
import {
  type CopilotSettings,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import {
  AUTH_PROBE_TIMEOUT_MS,
  buildSelectOptionDescriptor,
  buildServerProvider,
  providerModelsFromSettings,
} from "../providerSnapshot.ts";
import {
  GITHUB_COPILOT_DRIVER_KIND,
  GITHUB_COPILOT_PRESENTATION,
  isCopilotCliPathOverrideMissing,
  makeCopilotClientOptions,
  normalizeCopilotCliPathOverride,
} from "../Drivers/CopilotRuntimeConfig.ts";

interface CopilotProbeSnapshot {
  readonly version: string | null;
  readonly auth: {
    readonly isAuthenticated: boolean;
    readonly authType?: string | undefined;
    readonly login?: string | undefined;
    readonly statusMessage?: string | undefined;
  };
  readonly models: ReadonlyArray<ModelInfo>;
}

class CopilotProbeError extends Data.TaggedError("CopilotProbeError")<{
  readonly detail: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.detail;
  }
}

export interface CopilotClientProbeHandle {
  readonly start: () => Promise<void>;
  readonly getStatus: () => Promise<{ readonly version: string }>;
  readonly getAuthStatus: () => Promise<CopilotProbeSnapshot["auth"]>;
  readonly listModels: () => Promise<ModelInfo[]>;
  readonly stop: () => Promise<Error[]>;
}

export type CopilotClientProbeFactory = (options: CopilotClientOptions) => CopilotClientProbeHandle;

const DEFAULT_COPILOT_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const REASONING_EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

const FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5",
    name: "GPT-5",
    isCustom: false,
    capabilities: createCopilotModelCapabilities(["low", "medium", "high", "xhigh"], "high"),
  },
  {
    slug: "gpt-5-mini",
    name: "GPT-5 Mini",
    isCustom: false,
    capabilities: createCopilotModelCapabilities(["low", "medium", "high", "xhigh"], "high"),
  },
  {
    slug: "gpt-4.1",
    name: "GPT-4.1",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "claude-opus-4.7",
    name: "Claude Opus 4.7",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
  {
    slug: "claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: DEFAULT_COPILOT_MODEL_CAPABILITIES,
  },
];

function trimText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function toMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

function createCopilotModelCapabilities(
  supportedReasoningEfforts: ReadonlyArray<string> | undefined,
  defaultReasoningEffort: string | undefined,
): ModelCapabilities {
  const efforts = supportedReasoningEfforts ?? [];
  if (efforts.length === 0) {
    return DEFAULT_COPILOT_MODEL_CAPABILITIES;
  }
  const defaultEffort =
    defaultReasoningEffort && efforts.includes(defaultReasoningEffort)
      ? defaultReasoningEffort
      : efforts.includes("high")
        ? "high"
        : efforts[0];
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "reasoningEffort",
        label: "Reasoning",
        options: efforts.map((value) => {
          const option: { value: string; label: string; isDefault?: true } = {
            value,
            label: REASONING_EFFORT_LABELS[value] ?? value,
          };
          if (value === defaultEffort) {
            option.isDefault = true;
          }
          return option;
        }),
      }),
    ],
  });
}

function modelFromInfo(model: ModelInfo): ServerProviderModel {
  return {
    slug: model.id,
    name: trimText(model.name) ?? model.id,
    isCustom: false,
    capabilities: createCopilotModelCapabilities(
      model.supportedReasoningEfforts,
      model.defaultReasoningEffort,
    ),
  };
}

function fallbackModels(settings: CopilotSettings): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    FALLBACK_MODELS,
    GITHUB_COPILOT_DRIVER_KIND,
    settings.customModels,
    DEFAULT_COPILOT_MODEL_CAPABILITIES,
  );
}

function resolveRuntimeModels(
  models: ReadonlyArray<ModelInfo>,
  settings: CopilotSettings,
): ReadonlyArray<ServerProviderModel> {
  const runtimeModels = models.map(modelFromInfo);
  return providerModelsFromSettings(
    runtimeModels.length > 0 ? runtimeModels : FALLBACK_MODELS,
    GITHUB_COPILOT_DRIVER_KIND,
    settings.customModels,
    DEFAULT_COPILOT_MODEL_CAPABILITIES,
  );
}

function toAuthStatus(message: string): "unauthenticated" | "unknown" {
  const normalized = message.toLowerCase();
  return normalized.includes("not authenticated") ||
    normalized.includes("login required") ||
    normalized.includes("sign in") ||
    normalized.includes("sign-in") ||
    normalized.includes("authentication required")
    ? "unauthenticated"
    : "unknown";
}

function isInstalledFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return !normalized.includes("enoent") && !normalized.includes("not found");
}

const defaultProbeFactory: CopilotClientProbeFactory = (options) => new CopilotClient(options);

export const makePendingCopilotProvider = Effect.fn("makePendingCopilotProvider")(function* (
  settings: CopilotSettings,
) {
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  return buildServerProvider({
    presentation: GITHUB_COPILOT_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: fallbackModels(settings),
    skills: [],
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "GitHub Copilot provider status has not been checked in this session yet."
        : "GitHub Copilot is disabled in T3 Code settings.",
    },
  });
});

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  settings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
  clientFactory: CopilotClientProbeFactory = defaultProbeFactory,
) {
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const emptyModels = fallbackModels(settings);

  if (!settings.enabled) {
    return buildServerProvider({
      presentation: GITHUB_COPILOT_PRESENTATION,
      enabled: false,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot is disabled in T3 Code settings.",
      },
    });
  }

  const configuredBinaryPath = normalizeCopilotCliPathOverride(settings.binaryPath);
  if (isCopilotCliPathOverrideMissing(settings)) {
    return buildServerProvider({
      presentation: GITHUB_COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `GitHub Copilot CLI override was not found at '${configuredBinaryPath}'.`,
      },
    });
  }

  const client = clientFactory(makeCopilotClientOptions({ settings, environment }));
  const probeResult = yield* Effect.tryPromise({
    try: async (): Promise<CopilotProbeSnapshot> => {
      await client.start();
      const [status, auth] = await Promise.all([client.getStatus(), client.getAuthStatus()]);
      const models = auth.isAuthenticated ? await client.listModels() : [];
      return { version: status.version ?? null, auth, models };
    },
    catch: (cause) =>
      new CopilotProbeError({
        detail: toMessage(cause, "Failed to start GitHub Copilot."),
        cause,
      }),
  }).pipe(
    Effect.ensuring(Effect.promise(() => client.stop().catch(() => []))),
    Effect.timeoutOption(Duration.millis(AUTH_PROBE_TIMEOUT_MS)),
    Effect.result,
  );

  if (Result.isFailure(probeResult)) {
    const message = toMessage(probeResult.failure, "Failed to start GitHub Copilot.");
    const authStatus = toAuthStatus(message);
    return buildServerProvider({
      presentation: GITHUB_COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed: isInstalledFailure(message),
        version: null,
        status: authStatus === "unauthenticated" ? "error" : "warning",
        auth: { status: authStatus },
        message:
          authStatus === "unauthenticated"
            ? "GitHub Copilot is not authenticated. Sign in with the Copilot CLI and try again."
            : message,
      },
    });
  }

  if (Option.isNone(probeResult.success)) {
    return buildServerProvider({
      presentation: GITHUB_COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Timed out while checking GitHub Copilot provider status.",
      },
    });
  }

  const snapshot = probeResult.success.value;
  if (!snapshot.auth.isAuthenticated) {
    return buildServerProvider({
      presentation: GITHUB_COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed: true,
        version: snapshot.version,
        status: "error",
        auth: {
          status: "unauthenticated",
          ...(snapshot.auth.authType ? { type: snapshot.auth.authType } : {}),
          label: snapshot.auth.statusMessage ?? "GitHub Copilot",
        },
        message: "GitHub Copilot is not authenticated. Sign in with the Copilot CLI and try again.",
      },
    });
  }

  return buildServerProvider({
    presentation: GITHUB_COPILOT_PRESENTATION,
    enabled: true,
    checkedAt,
    models: resolveRuntimeModels(snapshot.models, settings),
    skills: [],
    probe: {
      installed: true,
      version: snapshot.version,
      status: "ready",
      auth: {
        status: "authenticated",
        type: snapshot.auth.authType ?? "github",
        label: snapshot.auth.login ? `GitHub Copilot (${snapshot.auth.login})` : "GitHub Copilot",
      },
    },
  });
});
