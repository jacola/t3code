import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";

import { makeCopilotEnvironment } from "./acpSupport.ts";
import type { CopilotSettings } from "../settings.ts";

/** The environment every Copilot process for this instance runs with. */
export const makeCopilotLaunchEnvironment = Effect.fn("makeCopilotLaunchEnvironment")(function* (
  settings: Pick<CopilotSettings, "homePath">,
  instanceEnvironment: ProviderInstanceEnvironment | undefined,
) {
  const hostEnvironment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  return makeCopilotEnvironment({
    settings,
    environment: yield* mergeProviderInstanceEnvironment(instanceEnvironment, hostEnvironment),
    configuredVariableNames: new Set((instanceEnvironment ?? []).map((variable) => variable.name)),
    homeDirectory,
  });
});
