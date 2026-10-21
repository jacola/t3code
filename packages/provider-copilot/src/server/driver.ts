import { ProviderDriverKind } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import {
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilitiesResolver,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";

import { resolveCopilotHome } from "./acpSupport.ts";
import { makeCopilotAdapterV2ForInstance, type CopilotAdapterV2DriverEnv } from "./adapter.ts";
import { makeCopilotCatalogStore } from "./catalog.ts";
import { makeCopilotLaunchEnvironment } from "./environment.ts";
import { probeCopilotCatalog } from "./refresh.ts";
import {
  buildInitialCopilotProviderSnapshot,
  checkCopilotProviderStatus,
  discoverCopilotSkillCommands,
  enrichCopilotSnapshot,
  mergeCopilotSlashCommands,
  withCopilotCatalog,
} from "./status.ts";
import { makeCopilotTextGeneration } from "./textGeneration.ts";
import { copilotUsageReader } from "./usage.ts";
import { CopilotSettings } from "../settings.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);

const DRIVER_KIND = ProviderDriverKind.make("githubCopilot");
// npm's `latest` is the stable channel `copilot update` installs.
const COPILOT_NPM_PACKAGE = "@github/copilot";
const MODEL_REFRESH_TIMEOUT = "90 seconds";

// `copilot update` detects the installer that owns the binary itself, and it
// writes under COPILOT_HOME, so it runs with the instance's environment.
const UPDATE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: (context) =>
    Effect.succeed(
      context
        ? makeProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: COPILOT_NPM_PACKAGE,
            updateExecutable: context.resolvedCommandPath,
            updateArgs: ["update"],
            updateLockKey: "copilot",
            platform: context.platform,
            env: context.env,
          })
        : makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: COPILOT_NPM_PACKAGE,
          }),
    ),
};

export type CopilotDriverEnv =
  | CopilotAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers;

export const CopilotDriver: ProviderDriver<CopilotSettings, CopilotDriverEnv, Path.Path> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "GitHub Copilot",
    supportsMultipleInstances: true,
  },
  configSchema: CopilotSettings,
  defaultConfig: (): CopilotSettings => decodeCopilotSettings({}),
  usage: copilotUsageReader,
  create: Effect.fn("CopilotDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const host = yield* ProviderHost.ProviderHost;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const settings = { ...config, enabled } satisfies CopilotSettings;
    const processEnv = yield* makeCopilotLaunchEnvironment(settings, environment);
    const copilotHome = resolveCopilotHome(processEnv, homeDirectory, path.join);
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const driverError = (detail: string) => (cause: unknown) =>
      new ProviderDriverError({ driver: DRIVER_KIND, instanceId, detail, cause });

    const catalog = yield* makeCopilotCatalogStore(
      path.join(
        host.paths.providerStatusCacheDir,
        `${DRIVER_KIND}-catalog-${encodeURIComponent(instanceId)}.json`,
      ),
    );
    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: settings.binaryPath,
        env: processEnv,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    );
    const orchestrationAdapter = yield* makeCopilotAdapterV2ForInstance({
      instanceId,
      displayName,
      accentColor,
      environment,
      enabled,
      config,
      onSessionConfigurationUpdate: catalog.onConfigOptions,
      onAvailableCommandsUpdate: catalog.onAvailableCommands,
    }).pipe(Effect.mapError(driverError("Failed to build GitHub Copilot orchestration adapter.")));
    const textGeneration = yield* makeCopilotTextGeneration(settings, processEnv);

    const checkProvider = catalog.get.pipe(
      Effect.flatMap((current) =>
        checkCopilotProviderStatus({
          settings,
          environment: processEnv,
          configPath: path.join(copilotHome, "config.json"),
          catalog: current,
        }),
      ),
      Effect.map(stampIdentity),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(settings);
    const initialCatalog = yield* catalog.get;
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CopilotSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (current) =>
        buildInitialCopilotProviderSnapshot(current.provider, initialCatalog).pipe(
          Effect.map(stampIdentity),
        ),
      checkProvider,
      enrichSnapshot: ({ settings: current, snapshot: probed, getSnapshot, publishSnapshot }) =>
        resolveMaintenance().pipe(
          Effect.flatMap((maintenanceCapabilities) =>
            enrichCopilotSnapshot({
              snapshot: probed,
              maintenanceCapabilities,
              enableProviderUpdateChecks: current.enableProviderUpdateChecks,
              publishSnapshot,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
          // Sessions and refreshes keep teaching the catalog between checks.
          Effect.andThen(
            SubscriptionRef.changes(catalog.changes).pipe(
              Stream.runForEach((learned) =>
                getSnapshot.pipe(
                  Effect.flatMap((latest) =>
                    publishSnapshot(
                      withCopilotCatalog(latest, learned, current.provider.customModels),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
    }).pipe(Effect.mapError(driverError("Failed to build GitHub Copilot snapshot.")));

    const snapshotForCwd = (workspaceCwd: string) =>
      !settings.enabled
        ? snapshot.getSnapshot
        : Effect.all([
            snapshot.getSnapshot,
            discoverCopilotSkillCommands(settings, processEnv, workspaceCwd).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            ),
          ]).pipe(
            Effect.map(([machineSnapshot, skillCommands]) => ({
              ...machineSnapshot,
              slashCommands: mergeCopilotSlashCommands(
                machineSnapshot.slashCommands,
                skillCommands,
              ),
            })),
          );

    const refreshModels = () =>
      probeCopilotCatalog({ settings, environment: processEnv, cwd: host.paths.cwd }).pipe(
        Effect.flatMap(catalog.replace),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.timeoutOrElse({
          duration: MODEL_REFRESH_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: "GitHub Copilot model refresh timed out.",
              }),
            ),
        }),
        Effect.mapError((cause) =>
          cause._tag === "ProviderDriverError"
            ? cause
            : new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail:
                  cause._tag === "AcpRequestError" && cause.code === -32000
                    ? "Sign in with `copilot login` before refreshing GitHub Copilot models."
                    : "Could not refresh GitHub Copilot models. The previous model list is unchanged.",
                cause,
              }),
        ),
      );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      snapshotForCwd,
      refreshModels,
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
