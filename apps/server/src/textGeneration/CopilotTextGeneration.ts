import { CopilotClient, type MessageOptions } from "@github/copilot-sdk";
import {
  TextGenerationError,
  type ChatAttachment,
  type CopilotSettings,
  type ModelSelection,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import {
  makeCopilotClientOptions,
  resolveCopilotHomePath,
} from "../provider/Drivers/CopilotRuntimeConfig.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";
import type {
  BranchNameGenerationInput,
  TextGenerationShape,
  ThreadTitleGenerationResult,
} from "./TextGeneration.ts";

const COPILOT_TEXT_GENERATION_TIMEOUT_MS = 180_000;
type CopilotReasoningEffort = "low" | "medium" | "high" | "xhigh";

function toMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

function getReasoningEffort(modelSelection: ModelSelection): CopilotReasoningEffort | undefined {
  const reasoningEffort = getModelSelectionStringOptionValue(modelSelection, "reasoningEffort");
  return reasoningEffort === "low" ||
    reasoningEffort === "medium" ||
    reasoningEffort === "high" ||
    reasoningEffort === "xhigh"
    ? reasoningEffort
    : undefined;
}

function promptWithJsonSchema(prompt: string, outputSchema: Schema.Top): string {
  return [
    prompt,
    "",
    "Return only valid JSON. Do not wrap it in markdown fences.",
    "JSON schema:",
    JSON.stringify(toJsonSchemaObject(outputSchema)),
  ].join("\n");
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1].trim());
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error("No JSON object found in Copilot response.");
}

export const makeCopilotTextGeneration = Effect.fn("makeCopilotTextGeneration")(function* (
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const serverConfig = yield* ServerConfig;

  const resolveAttachments = (
    attachments: ReadonlyArray<ChatAttachment> | undefined,
  ): MessageOptions["attachments"] => {
    const resolved: NonNullable<MessageOptions["attachments"]> = [];
    for (const attachment of attachments ?? []) {
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) continue;
      resolved.push({
        type: "file",
        path: attachmentPath,
        displayName: attachment.name,
      });
    }
    return resolved.length > 0 ? resolved : undefined;
  };

  const runCopilotJson = Effect.fn("runCopilotJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
    attachments,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
    attachments?: ReadonlyArray<ChatAttachment> | undefined;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const rawOutput = yield* Effect.tryPromise({
      try: async () => {
        const client = new CopilotClient(
          makeCopilotClientOptions({
            settings: copilotSettings,
            cwd,
            environment,
          }),
        );
        let session: Awaited<ReturnType<CopilotClient["createSession"]>> | undefined;
        try {
          const configDir = resolveCopilotHomePath(copilotSettings);
          const reasoningEffort = getReasoningEffort(modelSelection);
          session = await client.createSession({
            model: modelSelection.model,
            ...(reasoningEffort ? { reasoningEffort } : {}),
            workingDirectory: cwd,
            ...(configDir ? { configDir } : {}),
            streaming: false,
            enableConfigDiscovery: false,
            skipCustomInstructions: true,
            availableTools: [],
          });
          const resolvedAttachments = resolveAttachments(attachments);
          const messageOptions: MessageOptions = {
            prompt: promptWithJsonSchema(prompt, outputSchemaJson),
            ...(resolvedAttachments ? { attachments: resolvedAttachments } : {}),
            mode: "immediate",
          };
          const response = await session.sendAndWait(
            messageOptions,
            COPILOT_TEXT_GENERATION_TIMEOUT_MS,
          );
          return response?.data.content ?? "";
        } finally {
          await session?.disconnect().catch(() => undefined);
          await client.stop().catch(() => []);
        }
      },
      catch: (cause) =>
        new TextGenerationError({
          operation,
          detail: toMessage(cause, "GitHub Copilot text generation failed."),
          cause,
        }),
    });

    const parsed = yield* Effect.try({
      try: () => extractJsonObject(rawOutput),
      catch: (cause) =>
        new TextGenerationError({
          operation,
          detail: "GitHub Copilot returned invalid JSON.",
          cause,
        }),
    });

    const decodeOutput = Schema.decodeUnknownEffect(outputSchemaJson);
    return yield* decodeOutput(parsed).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "GitHub Copilot returned invalid structured output.",
            cause,
          }),
        ),
      ),
    );
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "CopilotTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });
    const generated = yield* runCopilotJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "CopilotTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });
    const generated = yield* runCopilotJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "CopilotTextGeneration.generateBranchName",
  )(function* (input: BranchNameGenerationInput) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });
    const generated = yield* runCopilotJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      attachments: input.attachments,
      modelSelection: input.modelSelection,
    });
    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "CopilotTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });
    const generated = yield* runCopilotJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      attachments: input.attachments,
      modelSelection: input.modelSelection,
    });
    return {
      title: sanitizeThreadTitle(generated.title),
    } satisfies ThreadTitleGenerationResult;
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});
