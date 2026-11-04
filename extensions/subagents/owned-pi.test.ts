import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";
import {
  ModelRegistry,
  ModelRuntime,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import subagentsExtension from "./index.ts";
import { SubagentManager } from "./src/manager.ts";
import { createSubagentRuntime, runTool } from "./src/runtime.ts";
import type { OwnedSpawnTask, SubagentSnapshot } from "./src/domain.ts";

// Real SDK/session/manager, with only the external model HTTP service controlled.
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "owned-subagent-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const requests: Array<{
    model: string;
    tools?: Array<{ function: { name: string } }>;
  }> = [];
  let response: (() => object) | undefined;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify(response?.() ?? { id: "test", object: "chat.completion.chunk", model: "approved", choices: [{ index: 0, delta: { role: "assistant", content: "complete" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        local: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "test",
          api: "openai-completions",
          models: [
            {
              id: "approved",
              reasoning: true,
              input: ["text"],
              contextWindow: 100000,
              maxTokens: 1000,
            },
            {
              id: "parent-now",
              reasoning: false,
              input: ["text"],
              contextWindow: 100000,
              maxTokens: 1000,
            },
          ],
        },
        "no-auth": {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          models: [
            {
              id: "approved",
              reasoning: true,
              input: ["text"],
              contextWindow: 100000,
              maxTokens: 1000,
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
  );
  const models = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "catalog.json"),
  });
  const registry = new ModelRegistry(models);
  const runtime = createSubagentRuntime();
  t.after(async () => {
    await runtime.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const manager = await runtime.runPromise(SubagentManager);
  const task: OwnedSpawnTask = {
    prompt: "Report complete",
    title: "owned",
    cwd,
    execution: {
      model: { provider: "local", id: "approved" },
      thinkingLevel: "high",
    },
    parent: {
      parentCwd: cwd,
      projectTrusted: false,
      inheritedModel: { provider: "local", id: "parent-now" },
      inheritedThinkingLevel: "off",
      modelRegistry: registry,
    },
  };
  const results: SubagentSnapshot[] = [];
  const owner = {
    id: "run",
    onSettled: (snapshot: SubagentSnapshot) => {
      results.push(snapshot);
    },
  };
  return {
    manager,
    runtime,
    task,
    owner,
    results,
    requests,
    agentDir,
    cwd,
    models,
    setResponse: (reply: () => object) => {
      response = reply;
    },
  };
}

test("owned execution rejects unavailable models and unsupported thinking without fallback", async (t) => {
  const { manager, runtime, task, owner, requests } = await fixture(t);
  await assert.rejects(
    runTool(
      runtime,
      manager.spawnOwned(
        {
          ...task,
          execution: {
            model: { provider: "local", id: "missing" },
            thinkingLevel: "high",
          },
        },
        owner,
      ),
    ),
    /Unknown model/,
  );
  await assert.rejects(
    runTool(
      runtime,
      manager.spawnOwned(
        {
          ...task,
          execution: {
            model: { provider: "local", id: "parent-now" },
            thinkingLevel: "high",
          },
        },
        owner,
      ),
    ),
    /thinking/i,
  );
  assert.equal(manager.view.size(), 0);
  assert.deepEqual(requests, []);
});

test("owned spawn fails preflight when the approved model has no credentials", async (t) => {
  const { manager, runtime, task, owner, requests } = await fixture(t);
  await assert.rejects(
    runTool(
      runtime,
      manager.spawnOwned(
        {
          ...task,
          execution: {
            model: { provider: "no-auth", id: "approved" },
            thinkingLevel: "high",
          },
        },
        owner,
      ),
    ),
    /auth|credential/i,
  );
  assert.equal(manager.view.size(), 0);
  assert.deepEqual(requests, []);
});

test("review workers omit edit/write while retaining bash and ordinary workers retain writes", async (t) => {
  const { manager, runtime, task, owner, requests } = await fixture(t);
  const review = await runTool(
    runtime,
    manager.spawnOwned({ ...task, readOnly: true }, owner),
  );
  await runTool(runtime, manager.waitFor([review.id]));
  const tools = requests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(tools.includes("read"));
  assert.ok(tools.includes("bash"));
  assert.ok(!tools.includes("edit"));
  assert.ok(!tools.includes("write"));
  const writer = await runTool(runtime, manager.spawn(task));
  await runTool(runtime, manager.waitFor([writer.id]));
  const writerTools =
    requests[1].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(writerTools.includes("edit"));
  assert.ok(writerTools.includes("write"));
});

test("children never load the orchestrator factory and exclude dynamically named orchestrator tools", async (t) => {
  const { manager, runtime, task, owner, requests, agentDir } =
    await fixture(t);
  const orchestrator = join(agentDir, "extensions", "orchestrator");
  await mkdir(orchestrator, { recursive: true });
  const marker = join(agentDir, "orchestrator-loaded");
  await writeFile(
    join(orchestrator, "index.ts"),
    `import { writeFileSync } from 'node:fs';
    export default function () { writeFileSync(${JSON.stringify(marker)}, 'loaded'); }`,
  );
  await writeFile(
    join(agentDir, "extensions", "other.ts"),
    `export default function (pi) {
    pi.on('session_start', () => {
      for (const name of ['workspace_probe', 'orchestrator_future']) pi.registerTool({
        name, label: name, description: name, parameters: { type: 'object', properties: {} },
        async execute() { return { content: [{ type: 'text', text: 'ok' }], details: {} }; }
      });
    });
  }`,
  );
  const snap = await runTool(runtime, manager.spawnOwned(task, owner));
  await runTool(runtime, manager.waitFor([snap.id]));
  await assert.rejects(access(marker), /ENOENT/);
  const tools = requests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(tools.includes("workspace_probe"));
  assert.ok(!tools.includes("orchestrator_future"));
});

test("child tool gates block orchestrator tools registered and activated during a run", async (t) => {
  const { manager, runtime, task, owner, agentDir, setResponse } =
    await fixture(t);
  await mkdir(join(agentDir, "extensions"));
  await writeFile(
    join(agentDir, "extensions", "nested.ts"),
    `export default function (pi) {
    const parameters = { type: 'object', properties: {} };
    pi.registerTool({ name: 'nested_probe', label: 'probe', description: 'probe', parameters,
      async execute(id, args, signal, update, ctx) {
        pi.registerTool({ name: 'orchestrator_hidden', label: 'hidden', description: 'hidden', parameters,
          async execute() { return { content: [{ type: 'text', text: 'nested orchestrator executed' }], details: {} }; }
        });
        pi.setActiveTools([...pi.getActiveTools(), 'orchestrator_hidden']);
        return { content: [{ type: 'text', text: 'activated' }], details: {} };
      }
    });
  }`,
  );
  let turn = 0;
  setResponse(() =>
    ++turn <= 2
      ? {
          id: "test",
          object: "chat.completion.chunk",
          model: "approved",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${turn}`,
                    type: "function",
                    function: {
                      name: turn === 1 ? "nested_probe" : "orchestrator_hidden",
                      arguments: "{}",
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }
      : {
          id: "test",
          object: "chat.completion.chunk",
          model: "approved",
          choices: [
            { index: 0, delta: { content: "complete" }, finish_reason: "stop" },
          ],
        },
  );
  const snap = await runTool(runtime, manager.spawnOwned(task, owner));
  await runTool(runtime, manager.waitFor([snap.id]));
  const result = manager.view
    .get(snap.id)
    ?.transcript.find(
      (item) =>
        item.kind === "toolResult" && item.name === "orchestrator_hidden",
    );
  assert.ok(result?.kind === "toolResult");
  assert.equal(result.isError, true);
  assert.match(result.outputPreview ?? "", /not allowed|excluded|blocked/i);
});

test("promise bridge uses the extension manager and becomes unavailable on shutdown", async (t) => {
  const { getSubagentManager } = await import("./index.ts");
  const { task, owner, agentDir, cwd, models, setResponse } = await fixture(t);
  let api: ExtensionAPI | undefined;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    extensionFactories: [
      subagentsExtension,
      (pi) => {
        api = pi;
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: models,
    model: models.getModel("local", "approved"),
    thinkingLevel: "high",
    resourceLoader: loader,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
    sessionManager: SessionManager.inMemory(cwd),
  });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "print" });
  assert.ok(api);
  const client = await getSubagentManager(api);
  assert.equal(await getSubagentManager(api), client);
  let parentTurn = 0;
  setResponse(() =>
    ++parentTurn === 1
      ? {
          id: "parent",
          object: "chat.completion.chunk",
          model: "approved",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "spawn-call",
                    type: "function",
                    function: {
                      name: "subagent_spawn",
                      arguments: JSON.stringify({
                        prompt: "ordinary work",
                        name: "ordinary",
                      }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }
      : {
          id: "test",
          object: "chat.completion.chunk",
          model: "approved",
          choices: [
            { index: 0, delta: { content: "complete" }, finish_reason: "stop" },
          ],
        },
  );
  await session.prompt("Spawn ordinary work");
  assert.equal(client.list().length, 1);
  assert.equal(client.list()[0].title, "ordinary");
  let changes = 0;
  const unsubscribe = client.subscribe(() => {
    changes++;
  });
  const snap = await client.spawnOwned(task, owner);
  assert.equal(client.get(snap.id)?.ownerId, "run");
  assert.equal(client.list().length, 2);
  await client.cancelOwned(owner, [snap.id]);
  assert.ok(changes > 0);
  unsubscribe();
  while (client.list().some((worker) => worker.status === "running"))
    await new Promise((resolve) => setTimeout(resolve, 5));
  await session.waitForIdle();
  let waitTurn = 0;
  setResponse(() =>
    ++waitTurn === 1
      ? {
          id: "parent",
          object: "chat.completion.chunk",
          model: "approved",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "wait-call",
                    type: "function",
                    function: {
                      name: "subagent_wait",
                      arguments: JSON.stringify({ ids: [snap.id] }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }
      : {
          id: "test",
          object: "chat.completion.chunk",
          model: "approved",
          choices: [
            { index: 0, delta: { content: "complete" }, finish_reason: "stop" },
          ],
        },
  );
  await session.prompt("Collect owned result through ordinary wait");
  const waited = session.messages.find(
    (message) =>
      message.role === "toolResult" && message.toolName === "subagent_wait",
  );
  assert.ok(waited?.role === "toolResult");
  assert.equal(
    waited.isError,
    true,
    "ordinary wait must not duplicate owner result delivery",
  );
  await session.extensionRunner.emit({
    type: "session_shutdown",
    reason: "quit",
  });
  await assert.rejects(getSubagentManager(api), /unavailable|active/i);
  await assert.rejects(client.spawnOwned(task, owner), /unavailable|active/i);
});

test("a bridge request racing shutdown cannot create a replacement runtime", async (t) => {
  const { getSubagentManager } = await import("./index.ts");
  const { agentDir, cwd, models } = await fixture(t);
  let api: ExtensionAPI | undefined;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    extensionFactories: [
      subagentsExtension,
      (pi) => {
        api = pi;
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: models,
    model: models.getModel("local", "approved"),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
  });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "print" });
  assert.ok(api);
  const pending = getSubagentManager(api);
  const shutdown = session.extensionRunner.emit({
    type: "session_shutdown",
    reason: "quit",
  });
  await assert.rejects(pending, /active|unavailable/i);
  await shutdown;
  await assert.rejects(getSubagentManager(api), /active|unavailable/i);
});

test("owned continuation refuses a child whose extension changed the approved thinking level", async (t) => {
  const { manager, runtime, task, owner, agentDir, requests } =
    await fixture(t);
  await mkdir(join(agentDir, "extensions"));
  await writeFile(
    join(agentDir, "extensions", "change-thinking.ts"),
    `export default function (pi) {
    pi.on('agent_settled', () => { pi.setThinkingLevel('off'); });
  }`,
  );
  const snap = await runTool(runtime, manager.spawnOwned(task, owner));
  await runTool(runtime, manager.waitFor([snap.id]));
  await assert.rejects(
    runTool(runtime, manager.sendOwned(owner, snap.id, "repair")),
    /approved|thinking/i,
  );
  assert.equal(requests.length, 1);
  assert.equal(manager.view.get(snap.id)?.status, "done");
});

test("owned execution uses the approved model and thinking rather than the current parent", async (t) => {
  const { manager, runtime, task, owner, results, requests } = await fixture(t);
  const snap = await runTool(runtime, manager.spawnOwned(task, owner));
  await runTool(runtime, manager.waitFor([snap.id]));
  assert.equal(results[0].status, "done", results[0].errorText ?? "");
  assert.equal(results[0].meta.modelLabel, "local/approved");
  assert.equal(results[0].meta.thinkingLevel, "high");
  assert.equal(requests[0].model, "approved");
});
