import type { ServerProviderModel } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";
import type * as EffectAcpErrors from "effect-acp/errors";

import { makeCopilotAcpRuntime } from "./acpSupport.ts";
import {
  copilotModelOptionDescriptors,
  copilotSlashCommands,
  findCopilotModelOption,
  markCopilotDefaultModel,
  type CopilotCatalog,
} from "./catalog.ts";
import type { CopilotSettings } from "../settings.ts";

const COMMAND_ADVERTISEMENT_GRACE = Duration.seconds(3);

/**
 * Opens one throwaway session (which loads the user's configured MCP servers,
 * so this only runs on an explicit refresh) and switches it through every
 * model, because Copilot advertises reasoning levels only for the current
 * model. Switching models in a session does not change the saved default.
 */
export const probeCopilotCatalog = Effect.fn("probeCopilotCatalog")(function* (input: {
  readonly settings: CopilotSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}): Effect.fn.Return<
  CopilotCatalog,
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  return yield* Effect.gen(function* () {
    const runtime = yield* makeCopilotAcpRuntime({
      settings: input.settings,
      environment: input.environment,
      cwd: input.cwd,
      disableBuiltinMcps: true,
      clientInfo: { name: "t3-code-provider-refresh", version: "0.0.0" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      authenticateOnAuthRequired: false,
      mcpServers: [],
    });
    const commands = yield* Ref.make<ReadonlyArray<EffectAcpSchema.AvailableCommand>>([]);
    const commandsAdvertised = yield* Deferred.make<void>();
    yield* runtime.handleSessionUpdate((notification) =>
      notification.update.sessionUpdate === "available_commands_update"
        ? Ref.set(commands, notification.update.availableCommands).pipe(
            Effect.andThen(Deferred.succeed(commandsAdvertised, undefined)),
            Effect.asVoid,
          )
        : Effect.void,
    );
    const started = yield* runtime.start();
    const initialOptions = started.sessionSetupResult.configOptions ?? [];
    const modelOption = findCopilotModelOption(initialOptions);
    const models: Array<ServerProviderModel> = [];
    if (modelOption !== undefined) {
      const seen = new Set<string>();
      const choices = modelOption.options.flatMap((entry) =>
        "value" in entry ? [entry] : entry.options,
      );
      for (const choice of choices) {
        const slug = choice.value.trim();
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        const configOptions =
          slug === modelOption.currentValue
            ? initialOptions
            : Option.getOrUndefined(
                yield* runtime.setConfigOption(modelOption.id, slug).pipe(
                  Effect.map((response) => Option.some(response.configOptions ?? [])),
                  // A model the account cannot switch to stays out of the list.
                  Effect.catchTags({ AcpRequestError: () => Effect.succeedNone }),
                ),
              );
        if (configOptions === undefined) continue;
        models.push({
          slug,
          name: choice.name.trim() || slug,
          isCustom: false,
          capabilities: { optionDescriptors: [...copilotModelOptionDescriptors(configOptions)] },
        });
      }
    }
    yield* Deferred.await(commandsAdvertised).pipe(
      Effect.timeoutOption(COMMAND_ADVERTISEMENT_GRACE),
    );
    yield* runtime.closeSession().pipe(Effect.ignore);
    return {
      models: markCopilotDefaultModel(models, modelOption?.currentValue),
      slashCommands: copilotSlashCommands(yield* Ref.get(commands)),
    } satisfies CopilotCatalog;
  }).pipe(Effect.scoped);
});
