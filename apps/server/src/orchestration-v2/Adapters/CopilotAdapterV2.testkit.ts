import * as NodeServices from "@effect/platform-node/NodeServices";
import { CopilotSettings } from "@t3tools/provider-copilot/settings";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { ProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import {
  type AcpReplayTranscript,
  AcpReplayTranscriptDecodeError,
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";
import {
  COPILOT_DEFAULT_INSTANCE_ID,
  COPILOT_PROVIDER,
  makeCopilotAdapterV2,
} from "@t3tools/provider-copilot/testing";

const DEFAULT_COPILOT_SETTINGS = Schema.decodeUnknownSync(CopilotSettings)({});

/** Recordings normalize COPILOT_HOME to this path. */
export const COPILOT_REPLAY_HOME = "/home/copilot-replay/.copilot";

function layerCopilotProviderAdapterRegistryReplay(
  transcript: AcpReplayTranscript,
  options: { readonly replayGate?: ProviderReplayGate } = {},
) {
  const layerHost = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));

  return ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const replayGate = options.replayGate;
      const replayDir = yield* fileSystem
        .makeTempDirectory({
          prefix: `t3-orchestration-v2-copilot-replay-${transcript.scenario}-`,
        })
        .pipe(Effect.orDie);
      const statusPath = path.join(replayDir, "status.json");
      const scriptPath = yield* path
        .fromFileUrl(new URL("../../../scripts/acp-replay-agent.ts", import.meta.url))
        .pipe(Effect.orDie);
      const adapter = yield* makeCopilotAdapterV2({
        instanceId: COPILOT_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_COPILOT_SETTINGS,
        environment: { COPILOT_HOME: COPILOT_REPLAY_HOME },
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: makeAcpReplayRuntime({
          transcript,
          statusPath,
          scriptPath,
          childProcessSpawner,
          fileSystem,
          ...(replayGate === undefined ? {} : { replayGate }),
        }),
        continuationRequests,
        assertComplete: makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript),
      });
      return [adapter];
    }),
  ).pipe(
    Layer.provide(Layer.mergeAll(layerHost, NodeServices.layer, IdAllocator.layer)),
    Layer.merge(
      Layer.effectDiscard(
        Effect.addFinalizer(() => Effect.sync(() => options.replayGate?.releaseAll())),
      ),
    ),
  );
}

export const CopilotOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  AcpReplayTranscript,
  AcpReplayTranscriptDecodeError
> = {
  driver: COPILOT_PROVIDER,
  decodeTranscript: (transcript) => decodeAcpReplayTranscript(transcript, COPILOT_PROVIDER),
  makeProviderAdapterRegistryLayer: layerCopilotProviderAdapterRegistryReplay,
};
