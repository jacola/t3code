import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "vitest";
import type { MessageOptions, ModelInfo, SessionEvent } from "@github/copilot-sdk";
import { CopilotSettings, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import { makeCopilotAdapter, type CopilotAdapterLiveOptions } from "./CopilotAdapter.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);
const THREAD_ID = ThreadId.make("thread-copilot-1");

type CopilotClientFactory = NonNullable<CopilotAdapterLiveOptions["clientFactory"]>;
type TestCopilotClientHandle = ReturnType<CopilotClientFactory>;
type TestCopilotSessionHandle = Awaited<ReturnType<TestCopilotClientHandle["createSession"]>>;
type TestCopilotCommandList = Awaited<
  ReturnType<TestCopilotSessionHandle["rpc"]["commands"]["list"]>
>;
type TestCopilotCommandInvocationResult = Awaited<
  ReturnType<TestCopilotSessionHandle["rpc"]["commands"]["invoke"]>
>;

class FakeCopilotSession implements TestCopilotSessionHandle {
  readonly sessionId = "copilot-session-1";
  readonly commandListCalls: Array<
    Parameters<TestCopilotSessionHandle["rpc"]["commands"]["list"]>[0]
  > = [];
  readonly commandInvokeCalls: Array<
    Parameters<TestCopilotSessionHandle["rpc"]["commands"]["invoke"]>[0]
  > = [];
  readonly modeSetCalls: Array<Parameters<TestCopilotSessionHandle["rpc"]["mode"]["set"]>[0]> = [];
  readonly sendCalls: MessageOptions[] = [];
  readonly handlers = new Set<(event: SessionEvent) => void>();
  commandList: TestCopilotCommandList = { commands: [] };
  commandInvocationResult: TestCopilotCommandInvocationResult = { kind: "completed" };

  readonly rpc: TestCopilotSessionHandle["rpc"] = {
    mode: {
      set: async (input) => {
        this.modeSetCalls.push(input);
      },
    },
    plan: {
      read: async () => ({
        exists: false,
        content: null,
        path: null,
      }),
    },
    commands: {
      list: async (input) => {
        this.commandListCalls.push(input);
        return this.commandList;
      },
      invoke: async (input) => {
        this.commandInvokeCalls.push(input);
        return this.commandInvocationResult;
      },
    },
  };

  readonly on: TestCopilotSessionHandle["on"] = (handler) => {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  };

  readonly send: TestCopilotSessionHandle["send"] = async (options) => {
    this.sendCalls.push(options);
    return "copilot-message-1";
  };

  readonly abort: TestCopilotSessionHandle["abort"] = async () => undefined;
  readonly disconnect: TestCopilotSessionHandle["disconnect"] = async () => undefined;
  readonly setModel: TestCopilotSessionHandle["setModel"] = async () => undefined;
  readonly getEvents: TestCopilotSessionHandle["getEvents"] = async () => [];
}

class FakeCopilotClient implements TestCopilotClientHandle {
  readonly session = new FakeCopilotSession();
  readonly createSessionCalls: Array<Parameters<TestCopilotClientHandle["createSession"]>[0]> = [];
  readonly resumeSessionCalls: Array<Parameters<TestCopilotClientHandle["resumeSession"]>[1]> = [];

  readonly start: TestCopilotClientHandle["start"] = async () => undefined;
  readonly listModels: TestCopilotClientHandle["listModels"] = async (): Promise<ModelInfo[]> => [];
  readonly createSession: TestCopilotClientHandle["createSession"] = async (config) => {
    this.createSessionCalls.push(config);
    return this.session;
  };
  readonly resumeSession: TestCopilotClientHandle["resumeSession"] = async (_sessionId, config) => {
    this.resumeSessionCalls.push(config);
    return this.session;
  };
  readonly stop: TestCopilotClientHandle["stop"] = async () => [];
}

function makeHarness() {
  const client = new FakeCopilotClient();
  const settings = decodeCopilotSettings({
    enabled: true,
    homePath: "/tmp/t3-copilot-adapter-empty-home",
  });
  const layer = ServerConfig.layerTest("/tmp/copilot-adapter-test", {
    prefix: "t3-copilot-adapter-",
  }).pipe(Layer.provideMerge(NodeServices.layer));

  const makeAdapter = makeCopilotAdapter(settings, {
    clientFactory: () => client,
  });

  return { client, layer, makeAdapter };
}

describe("CopilotAdapter", () => {
  it("invokes skill-backed slash commands and sends the returned agent prompt", async () => {
    const harness = makeHarness();
    harness.client.session.commandList = {
      commands: [
        {
          name: "review",
          kind: "skill",
        },
      ],
    };
    harness.client.session.commandInvocationResult = {
      kind: "agent-prompt",
      prompt: "Run the review skill for src/server.ts",
      displayPrompt: "/review src/server.ts",
      mode: "plan",
    };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* harness.makeAdapter;
          yield* adapter.startSession({
            threadId: THREAD_ID,
            provider: ProviderDriverKind.make("githubCopilot"),
            runtimeMode: "approval-required",
          });
          yield* adapter.sendTurn({
            threadId: THREAD_ID,
            input: "/review src/server.ts",
            interactionMode: "default",
          });
        }).pipe(Effect.provide(harness.layer)),
      ),
    );

    expect(harness.client.createSessionCalls[0]).toMatchObject({
      enableConfigDiscovery: true,
      streaming: true,
    });
    expect(harness.client.session.commandListCalls).toEqual([
      {
        includeBuiltins: false,
        includeSkills: true,
        includeClientCommands: false,
      },
    ]);
    expect(harness.client.session.commandInvokeCalls).toEqual([
      {
        name: "review",
        input: "src/server.ts",
      },
    ]);
    expect(harness.client.session.sendCalls).toEqual([
      {
        prompt: "Run the review skill for src/server.ts",
        mode: "immediate",
        agentMode: "plan",
      },
    ]);
  });

  it("leaves non-skill slash prompts as normal Copilot messages", async () => {
    const harness = makeHarness();
    harness.client.session.commandList = {
      commands: [
        {
          name: "review",
          kind: "builtin",
        },
      ],
    };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* harness.makeAdapter;
          yield* adapter.startSession({
            threadId: THREAD_ID,
            provider: ProviderDriverKind.make("githubCopilot"),
            runtimeMode: "approval-required",
          });
          yield* adapter.sendTurn({
            threadId: THREAD_ID,
            input: "/review src/server.ts",
            interactionMode: "default",
          });
        }).pipe(Effect.provide(harness.layer)),
      ),
    );

    expect(harness.client.session.commandInvokeCalls).toEqual([]);
    expect(harness.client.session.sendCalls).toEqual([
      {
        prompt: "/review src/server.ts",
        mode: "immediate",
        agentMode: "interactive",
      },
    ]);
  });
});
