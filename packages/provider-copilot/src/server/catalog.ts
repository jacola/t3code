import {
  ServerProviderModel,
  ServerProviderSlashCommand,
  type ProviderOptionDescriptor,
  type ServerProviderModel as ServerProviderModelType,
  type ServerProviderSlashCommand as ServerProviderSlashCommandType,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as EffectAcpSchema from "effect-acp/compat";

import { acpProviderOptionDescriptors } from "@t3tools/provider-acp/server/sessionConfig";

import { COPILOT_AUTO_MODEL_SLUG } from "./acpSupport.ts";

/**
 * Copilot only lists models, per-model reasoning levels, custom agents, and
 * commands inside a session, so the catalog is learned from live sessions and
 * explicit refreshes and kept on disk across restarts.
 */
export const CopilotCatalog = Schema.Struct({
  models: Schema.Array(ServerProviderModel),
  slashCommands: Schema.Array(ServerProviderSlashCommand),
});
export type CopilotCatalog = typeof CopilotCatalog.Type;

const EMPTY_CATALOG: CopilotCatalog = { models: [], slashCommands: [] };

/**
 * These commands change state T3 owns: the model, the permission mode, the
 * plan/autopilot mode, or the working directory. Running them natively would
 * leave T3's thread settings out of sync with the session.
 */
const T3_OWNED_COMMANDS: ReadonlySet<string> = new Set([
  "allow-all",
  "autopilot",
  "cwd",
  "model",
  "permissions",
  "plan",
  "reset-allowed-tools",
]);

const MAX_COMMANDS = 256;

type SelectConfigOption = Extract<EffectAcpSchema.SessionConfigOption, { readonly type: "select" }>;

function selectChoices(option: SelectConfigOption) {
  return option.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
}

export function findCopilotModelOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): SelectConfigOption | undefined {
  const option = configOptions.find(
    (candidate) => candidate.category === "model" && candidate.type === "select",
  );
  return option?.type === "select" ? option : undefined;
}

/**
 * Only reasoning effort and the custom agent are model options. Mode and
 * permission options are driven by T3's interaction and runtime modes.
 */
export function copilotModelOptionDescriptors(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ReadonlyArray<ProviderOptionDescriptor> {
  return acpProviderOptionDescriptors({
    configOptions: configOptions.filter(
      (option) => option.category === "thought_level" || option.id === "agent",
    ),
    modeState: undefined,
  });
}

function modelEntry(input: {
  readonly slug: string;
  readonly name: string;
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor>;
}): ServerProviderModelType {
  return {
    slug: input.slug,
    name: input.name,
    isCustom: false,
    capabilities: createModelCapabilities({ optionDescriptors: input.descriptors }),
  };
}

/**
 * Builds the model list a session advertises. Options are per model, so only
 * the session's current model gets the live descriptors; the others keep what
 * an earlier session or refresh learned.
 */
export function copilotModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  previous: ReadonlyArray<ServerProviderModelType>,
  defaultSource: "session" | "previous" = "previous",
): ReadonlyArray<ServerProviderModelType> | undefined {
  const modelOption = findCopilotModelOption(configOptions);
  if (modelOption === undefined) return undefined;
  const liveDescriptors = copilotModelOptionDescriptors(configOptions);
  const sharedDescriptors = liveDescriptors.filter((descriptor) => descriptor.id === "agent");
  const previousBySlug = new Map(previous.map((model) => [model.slug, model]));
  const seen = new Set<string>();
  const models: Array<ServerProviderModelType> = [];
  for (const choice of selectChoices(modelOption)) {
    const slug = choice.value.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const descriptors =
      slug === modelOption.currentValue
        ? liveDescriptors
        : [
            ...(previousBySlug
              .get(slug)
              ?.capabilities?.optionDescriptors?.filter(
                (descriptor) => descriptor.id !== "agent",
              ) ?? []),
            ...sharedDescriptors,
          ];
    models.push(modelEntry({ slug, name: choice.name.trim() || slug, descriptors }));
  }
  // A live thread's current model is that thread's pick; only a fresh session
  // shows the account's configured default.
  const previousDefault = previous.find((model) => model.isDefault)?.slug;
  return markCopilotDefaultModel(
    models,
    defaultSource === "session" || previousDefault === undefined
      ? modelOption.currentValue
      : previousDefault,
  );
}

/** Copilot's own default (its configured model) is the thread default. */
export function markCopilotDefaultModel(
  models: ReadonlyArray<ServerProviderModelType>,
  defaultSlug: string | undefined,
): ReadonlyArray<ServerProviderModelType> {
  const target = models.some((model) => model.slug === defaultSlug)
    ? defaultSlug
    : models.some((model) => model.slug === COPILOT_AUTO_MODEL_SLUG)
      ? COPILOT_AUTO_MODEL_SLUG
      : undefined;
  return models.map((model) => {
    const { isDefault: _isDefault, ...rest } = model;
    return model.slug === target ? { ...rest, isDefault: true } : rest;
  });
}

export function copilotSlashCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProviderSlashCommandType> {
  const seen = new Set<string>();
  const result: Array<ServerProviderSlashCommandType> = [];
  for (const command of commands) {
    const name = command.name.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key) || T3_OWNED_COMMANDS.has(key)) continue;
    seen.add(key);
    const description = command.description.trim();
    const hint = command.input?.hint.trim();
    result.push({
      name,
      ...(description ? { description } : {}),
      ...(hint ? { input: { hint } } : {}),
    });
    if (result.length === MAX_COMMANDS) break;
  }
  return result;
}

const decodeCatalog = Schema.decodeUnknownEffect(Schema.fromJsonString(CopilotCatalog));
const encodeCatalog = Schema.encodeEffect(Schema.fromJsonString(CopilotCatalog));

export interface CopilotCatalogStore {
  readonly get: Effect.Effect<CopilotCatalog>;
  readonly changes: SubscriptionRef.SubscriptionRef<CopilotCatalog>;
  readonly replace: (catalog: CopilotCatalog) => Effect.Effect<void>;
  readonly onConfigOptions: (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  ) => Effect.Effect<void>;
  readonly onAvailableCommands: (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
  ) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
}

export const makeCopilotCatalogStore = Effect.fn("makeCopilotCatalogStore")(function* (
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const initial = yield* fileSystem.readFileString(filePath).pipe(
    Effect.flatMap(decodeCatalog),
    Effect.orElseSucceed(() => EMPTY_CATALOG),
  );
  const ref = yield* SubscriptionRef.make<CopilotCatalog>(initial);

  const persist = (catalog: CopilotCatalog) =>
    encodeCatalog(catalog).pipe(
      Effect.flatMap((contents) =>
        fileSystem
          .makeDirectory(path.dirname(filePath), { recursive: true })
          .pipe(Effect.andThen(writeFileStringAtomically({ filePath, contents }))),
      ),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not save the GitHub Copilot model catalog.", { cause }),
      ),
    );

  const update = (f: (catalog: CopilotCatalog) => CopilotCatalog) =>
    SubscriptionRef.modify(ref, (current) => {
      const next = f(current);
      return [next === current ? undefined : next, next] as const;
    }).pipe(Effect.flatMap((next) => (next === undefined ? Effect.void : persist(next))));

  return {
    get: SubscriptionRef.get(ref),
    changes: ref,
    replace: (catalog) => update(() => catalog),
    onConfigOptions: (configOptions) =>
      update((current) => {
        const models = copilotModelsFromConfigOptions(configOptions, current.models);
        return models === undefined ? current : { ...current, models };
      }),
    onAvailableCommands: (commands) =>
      update((current) => ({ ...current, slashCommands: copilotSlashCommands(commands) })),
    clear: update(() => EMPTY_CATALOG),
  } satisfies CopilotCatalogStore;
});
