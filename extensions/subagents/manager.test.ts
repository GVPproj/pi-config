import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { BackendRegistry } from "./src/backend.ts";
import { makeStubBackend } from "./test/stub-backend.ts";
import type { ParentContext, SpawnTask } from "./src/domain.ts";
import {
  SubagentManager,
  SubagentManagerLive,
  type SubagentManagerShape,
} from "./src/manager.ts";
import { runTool } from "./src/runtime.ts";

const stubBackend = makeStubBackend({
  backend: "pi",
  defaultModelLabel: "test/pi",
  contextWindow: 200_000,
  toolName: "bash",
  cadenceMs: 30,
});

const TestRegistryLive = Layer.succeed(
  BackendRegistry,
  new Map([["pi", stubBackend]]),
);

const createTestRuntime = () =>
  ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(TestRegistryLive)),
  );

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return { prompt, title: "test", cwd: process.cwd(), parent };
}

async function withManager(
  run: (
    manager: SubagentManagerShape,
    runtime: ReturnType<typeof createTestRuntime>,
  ) => Promise<void>,
) {
  const runtime = createTestRuntime();
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

test("Pi subagent completes and delivers a final result", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn(task("Say hello to the tests")),
    );
    assert.equal(snap.status, "running");
    assert.equal(snap.backend, "pi");
    assert.match(snap.id, /^sa-/);
    assert.ok(snap.meta.sessionFilePath);

    await runTool(runtime, manager.waitFor([snap.id]));
    const done = manager.view.get(snap.id);
    assert.equal(done?.status, "done");
    assert.match(
      done?.finalText ?? "",
      /\[stub:pi\] completed: Say hello to the tests/,
    );
    assert.ok((done?.turns ?? 0) >= 2);
    assert.ok(done?.transcript.some((item) => item.kind === "toolResult"));
    assert.deepEqual(settled, [{ id: snap.id, consumed: true }]);
  });
});

test("failed prompts settle once as unconsumed errors", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn(task("FAIL: blow up please")),
    );
    while (manager.view.get(snap.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(manager.view.get(snap.id)?.status, "error");
    assert.match(manager.view.get(snap.id)?.errorText ?? "", /task failed/);
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
  });
});

test("cancel interrupts a running Pi subagent", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(runtime, manager.spawn(task("Long task")));
    const report = await runTool(runtime, manager.cancel([snap.id]));
    assert.deepEqual(report, [
      { id: snap.id, title: "test", status: "error", cancelled: true },
    ]);
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
  });
});

test("the concurrency cap rejects a fifth running subagent", async () => {
  await withManager(async (manager, runtime) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach([1, 2, 3, 4], (n) => manager.spawn(task(`Task ${n}`)), {
        concurrency: "unbounded",
      }),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(runtime, manager.spawn(task("Task 5"))),
      /Max 4 subagents/,
    );
  });
});

test("idle restarts respect the concurrency cap", async () => {
  await withManager(async (manager, runtime) => {
    const settled = await runTool(
      runtime,
      manager.spawn(task("early finisher")),
    );
    await runTool(runtime, manager.waitFor([settled.id]));
    await runTool(
      runtime,
      Effect.forEach([1, 2, 3, 4], (n) => manager.spawn(task(`Task ${n}`)), {
        concurrency: "unbounded",
      }),
    );
    await assert.rejects(
      runTool(runtime, manager.send(settled.id, "go again")),
      /Max 4 subagents/,
    );
    assert.equal(manager.view.get(settled.id)?.status, "done");
  });
});

test("send steers an idle subagent into another turn", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(runtime, manager.spawn(task("First turn")));
    await runTool(runtime, manager.waitFor([snap.id]));
    await runTool(runtime, manager.send(snap.id, "Second turn"));
    while (manager.view.get(snap.id)?.status !== "running") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterSecond = manager.view.get(snap.id);
    assert.equal(afterSecond?.status, "done");
    assert.match(afterSecond?.finalText ?? "", /Second turn/);
  });
});
