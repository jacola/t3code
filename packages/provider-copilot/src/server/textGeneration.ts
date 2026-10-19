import { TextGenerationError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import { ACP_EMPTY_OPTION_VALUE } from "@t3tools/provider-acp/server/sessionConfig";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";

import { COPILOT_AUTO_MODEL_SLUG, makeCopilotAcpRuntime } from "./acpSupport.ts";
import type { CopilotSettings } from "../settings.ts";

const COPILOT_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

/**
 * Each request runs in a throwaway session with every tool removed, so a
 * prompt built from a diff cannot make the agent edit files or run commands.
 */
export const makeCopilotTextGeneration = Effect.fn("makeCopilotTextGeneration")(function* (
  settings: CopilotSettings,
  environment: NodeJS.ProcessEnv,
) {
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runCopilotJson: TextGenerationOperations.Runner = (request) => {
    const { operation, cwd, prompt, modelSelection } = request;
    return Effect.gen(function* () {
      const output = yield* Ref.make("");
      const runtime = yield* makeCopilotAcpRuntime({
        settings,
        environment,
        cwd,
        toolless: true,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        mcpServers: [],
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk") return Effect.void;
        const content = update.content;
        return content.type === "text"
          ? Ref.update(output, (current) => current + content.text)
          : Effect.void;
      });

      const result = yield* Effect.gen(function* () {
        yield* runtime.start();
        const model = modelSelection.model.trim() || COPILOT_AUTO_MODEL_SLUG;
        const configOptions = yield* runtime.getConfigOptions;
        if (configOptions.find((option) => option.category === "model")?.currentValue !== model) {
          yield* runtime.setModel(model);
        }
        const advertised = yield* runtime.getConfigOptions;
        for (const selection of modelSelection.options ?? []) {
          const option = advertised.find((candidate) => candidate.id === selection.id);
          if (option?.type !== "select" || typeof selection.value !== "string") continue;
          const value = selection.value === ACP_EMPTY_OPTION_VALUE ? "" : selection.value;
          const choices = option.options.flatMap((entry) =>
            "value" in entry ? [entry.value] : entry.options.map((choice) => choice.value),
          );
          if (choices.includes(value) && option.currentValue !== value) {
            yield* runtime.setConfigOption(option.id, value);
          }
        }
        return yield* runtime.prompt({ prompt: [{ type: "text", text: prompt }] });
      }).pipe(
        Effect.timeoutOption(COPILOT_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "GitHub Copilot request timed out." }),
              ),
            onSome: Effect.succeed,
          }),
        ),
        Effect.mapError((cause: EffectAcpErrors.AcpError | TextGenerationError) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "GitHub Copilot request failed.",
                cause,
              }),
        ),
      );

      const text = (yield* Ref.get(output)).trim();
      if (!text) {
        return yield* new TextGenerationError({
          operation,
          detail:
            result.stopReason === "cancelled"
              ? "GitHub Copilot request was cancelled."
              : "GitHub Copilot returned empty output.",
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "GitHub Copilot", text);
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "GitHub Copilot text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );
  };

  return TextGenerationOperations.fromRunner(
    "CopilotTextGeneration",
    TextGenerationOperations.withoutInvestigation("GitHub Copilot", runCopilotJson),
  );
});
