import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
  type RuntimeMode,
} from "@t3tools/contracts";
import { readCustomModelEntries } from "@t3tools/shared/model";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";

import {
  copilotClientCapabilitiesMeta,
  extractCopilotSubagentUpdate,
  makeCopilotSubagentRouting,
} from "./acpExtension.ts";
import {
  COPILOT_AUTO_MODEL_SLUG,
  makeCopilotAcpRuntime,
  resolveCopilotHome,
} from "./acpSupport.ts";
import { makeCopilotLaunchEnvironment } from "./environment.ts";
import { registerCopilotPlanCapture } from "./planMarkdown.ts";
import { CopilotSettings } from "../settings.ts";

export const COPILOT_PROVIDER = ProviderDriverKind.make("githubCopilot");
export const COPILOT_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(COPILOT_PROVIDER);
const DEFAULT_COPILOT_SETTINGS = Schema.decodeSync(CopilotSettings)({});
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

const CopilotProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    // Permission modes are launch flags.
    supportsRuntimeModeSwitchInSession: false,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  planning: {
    ...AcpProviderCapabilitiesV2.planning,
    emitsProposedPlan: true,
    // Copilot's ask_user tool is unavailable over ACP.
    supportsStructuredQuestions: false,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

/**
 * Copilot answers quota exhaustion with an ordinary request error, so the
 * message is the only signal.
 */
const USAGE_LIMIT_PATTERN =
  /\b(?:rate[\s-]?limit|quota|premium request|usage limit|too many requests|credit limit|ai credits?)\b/i;

export function copilotPromptFailure(cause: unknown) {
  if (!isAcpRequestError(cause)) {
    return makeProviderFailure({ cause, class: "provider_error" });
  }
  return makeProviderFailure({
    cause,
    message: cause.errorMessage,
    code: String(cause.code),
    class: USAGE_LIMIT_PATTERN.test(cause.errorMessage) ? "usage_limit" : "provider_error",
  });
}

/**
 * Copilot's permission mode is fixed at launch. Explicit approval or sandbox
 * overrides launch it asking, so every request reaches T3's policy check
 * instead of being approved by `--allow-all`.
 */
export function copilotLaunchRuntimeMode(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): RuntimeMode {
  return runtimePolicy.approvalPolicy === undefined && runtimePolicy.sandboxPolicy === undefined
    ? runtimePolicy.runtimeMode
    : "approval-required";
}

export interface CopilotAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: CopilotSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  readonly onSessionConfigurationUpdate?: (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  ) => Effect.Effect<void>;
  readonly onAvailableCommandsUpdate?: (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
  ) => Effect.Effect<void>;
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

interface CopilotFlavorHost {
  readonly copilotHome: string;
  readonly platform: NodeJS.Platform;
  readonly readFile: (filePath: string) => Effect.Effect<string | undefined>;
}

function makeCopilotAcpAdapterFlavor(
  options: CopilotAdapterV2Options,
  host: CopilotFlavorHost,
): AcpAdapterV2Flavor {
  const routing = makeCopilotSubagentRouting();
  const customModels = readCustomModelEntries(options.settings.customModels).map(
    (entry) => entry.slug,
  );
  return {
    driver: COPILOT_PROVIDER,
    runtimeHarness: "GitHub Copilot",
    capabilities: CopilotProviderCapabilitiesV2,
    clientCapabilitiesMeta: copilotClientCapabilitiesMeta,
    supportsCompaction: true,
    promptFailure: copilotPromptFailure,
    makeRuntime:
      options.makeRuntime ??
      (({ runtimePolicy, processEnvironment, ...input }) =>
        makeCopilotAcpRuntime({
          ...input,
          settings: options.settings,
          environment:
            processEnvironment === undefined
              ? options.environment
              : { ...options.environment, ...processEnvironment },
          runtimeMode: copilotLaunchRuntimeMode(runtimePolicy),
          customModels,
        })),
    // `auto` is a model Copilot routes per request, not a sentinel, so it is
    // written like any other choice and switching back to it works.
    applyModelSelection: ({ runtime, modelSelection }) =>
      Effect.gen(function* () {
        const requested = modelSelection.model.trim() || COPILOT_AUTO_MODEL_SLUG;
        const configOptions = yield* runtime.getConfigOptions;
        const current = configOptions.find((option) => option.category === "model")?.currentValue;
        if (current !== requested) {
          yield* runtime.setModel(requested);
        }
        return requested;
      }),
    registerExtensions: (context) =>
      routing
        .registerExtensions(context)
        .pipe(Effect.andThen(registerCopilotPlanCapture(context, host))),
    normalizeSessionUpdate: routing.normalizeSessionUpdate,
    extractSubagentUpdate: extractCopilotSubagentUpdate,
    ...(options.onSessionConfigurationUpdate === undefined
      ? {}
      : { onSessionConfigurationUpdate: options.onSessionConfigurationUpdate }),
    ...(options.onAvailableCommandsUpdate === undefined
      ? {}
      : { onAvailableCommandsUpdate: options.onAvailableCommandsUpdate }),
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

export const makeCopilotAdapterV2 = Effect.fn("makeCopilotAdapterV2")(function* (
  options: CopilotAdapterV2Options,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeCopilotAcpAdapterFlavor(options, {
      copilotHome: resolveCopilotHome(options.environment, homeDirectory, path.join),
      platform,
      readFile: (filePath) =>
        fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => undefined)),
    }),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
  });
});

export type CopilotAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const makeCopilotAdapterV2ForInstance = Effect.fn("makeCopilotAdapterV2ForInstance")(
  function* (
    input: ProviderAdapterDriverCreateInput<CopilotSettings> &
      Pick<CopilotAdapterV2Options, "onSessionConfigurationUpdate" | "onAvailableCommandsUpdate">,
  ) {
    const selfInvocation = yield* resolveSelfInvocation();
    const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
    const settings = { ...input.config, enabled: input.enabled } satisfies CopilotSettings;
    return yield* makeCopilotAdapterV2({
      instanceId: input.instanceId,
      settings,
      environment: yield* makeCopilotLaunchEnvironment(settings, input.environment),
      selfInvocation,
      continuationRequests,
      nativeLogging: (threadId) =>
        makeNativeLogger({
          nativeEventLogger: providerEventLoggers.native,
          provider: COPILOT_PROVIDER,
          threadId,
        }),
      ...(input.onSessionConfigurationUpdate === undefined
        ? {}
        : { onSessionConfigurationUpdate: input.onSessionConfigurationUpdate }),
      ...(input.onAvailableCommandsUpdate === undefined
        ? {}
        : { onAvailableCommandsUpdate: input.onAvailableCommandsUpdate }),
    });
  },
  (effect, input) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterDriverCreateError({
            driver: COPILOT_PROVIDER,
            instanceId: input.instanceId,
            detail: "Failed to create GitHub Copilot ACP adapter.",
            cause,
          }),
      ),
    ),
);

export const CopilotAdapterV2Driver: ProviderAdapterDriver<
  CopilotSettings,
  CopilotAdapterV2DriverEnv
> = {
  driverKind: COPILOT_PROVIDER,
  configSchema: CopilotSettings,
  defaultConfig: (): CopilotSettings => DEFAULT_COPILOT_SETTINGS,
  create: (input) => makeCopilotAdapterV2ForInstance(input),
};
