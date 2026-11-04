import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { BackendRegistry } from "./src/backend.ts";
import { makeStubBackend } from "./test/stub-backend.ts";
import type {
  ParentContext,
  SpawnTask,
  SubagentSnapshot,
} from "./src/domain.ts";
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
  interruptDelayMs: 30,
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

test("owned completion goes only to its owner and shares ordinary capacity", async () => {
  await withManager(async (manager, runtime) => {
    assert.equal(manager.view.availableSlots(), 4);
    const results: SubagentSnapshot[] = [];
    const ordinary: string[] = [];
    const owner = {
      id: "run-1",
      onSettled: (snap: SubagentSnapshot) => {
        results.push(snap);
      },
    };
    manager.view.setOnSettled((snap) => {
      ordinary.push(snap.id);
    });
    const owned = await runTool(
      runtime,
      manager.spawnOwned(
        {
          ...task("owned work"),
          execution: {
            model: { provider: "test", id: "pi" },
            thinkingLevel: "high",
          },
        },
        owner,
      ),
    );
    await runTool(
      runtime,
      Effect.forEach([1, 2, 3], (n) => manager.spawn(task(`ordinary ${n}`))),
    );
    assert.equal(manager.view.availableSlots(), 0);
    await assert.rejects(
      runTool(runtime, manager.spawn(task("overflow"))),
      /Max 4/,
    );
    await assert.rejects(
      runTool(
        runtime,
        manager.spawnOwned(
          {
            ...task("owned overflow"),
            execution: {
              model: { provider: "test", id: "pi" },
              thinkingLevel: "high",
            },
          },
          owner,
        ),
      ),
      /Max 4/,
    );
    await runTool(runtime, manager.waitFor([owned.id]));
    assert.equal(results.length, 1);
    assert.equal(results[0].ownerId, "run-1");
    assert.equal(results[0].status, "done");
    assert.equal(results[0].outcome, "Completed");
    assert.match(results[0].finalText, /owned work/);
    assert.ok(!ordinary.includes(owned.id));
    assert.notEqual(results[0], manager.view.get(owned.id));
  });
});

test("only the owner can continue settled work, and result snapshots survive continuation", async () => {
  await withManager(async (manager, runtime) => {
    const results: SubagentSnapshot[] = [];
    const owner = {
      id: "run-1",
      onSettled: (snap: SubagentSnapshot) => {
        results.push(snap);
      },
    };
    const snap = await runTool(
      runtime,
      manager.spawnOwned(
        {
          ...task("first"),
          execution: {
            model: { provider: "test", id: "pi" },
            thinkingLevel: "high",
          },
        },
        owner,
      ),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    const first = structuredClone(results[0]);
    await assert.rejects(
      runTool(runtime, manager.send(snap.id, "unauthorized")),
      /owner/i,
    );
    await assert.rejects(
      runTool(runtime, manager.sendOwned({ ...owner }, snap.id, "impostor")),
      /owner/i,
    );
    manager.view.requestSend(snap.id, "takeover must not restart");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(manager.view.get(snap.id)?.status, "done");
    await runTool(runtime, manager.sendOwned(owner, snap.id, "second"));
    // Immediate wait must observe the continuation, not the previous result.
    await runTool(runtime, manager.waitFor([snap.id]));
    assert.equal(results.length, 2);
    assert.match(results[1].finalText, /second/);
    assert.deepEqual(results[0], first);
  });
});

test("owned cancellation checks identity, preserves other work, and notifies only the owner", async () => {
  await withManager(async (manager, runtime) => {
    const results: SubagentSnapshot[] = [];
    const ordinary: string[] = [];
    const owner = {
      id: "run-1",
      onSettled: (snap: SubagentSnapshot) => {
        results.push(snap);
      },
    };
    manager.view.setOnSettled((snap) => {
      ordinary.push(snap.id);
    });
    const owned = await runTool(
      runtime,
      manager.spawnOwned(
        {
          ...task("cancel me"),
          execution: {
            model: { provider: "test", id: "pi" },
            thinkingLevel: "high",
          },
        },
        owner,
      ),
    );
    const other = await runTool(runtime, manager.spawn(task("keep going")));
    await assert.rejects(
      runTool(runtime, manager.cancelOwned({ ...owner }, [owned.id])),
      /owner/i,
    );
    await assert.rejects(
      runTool(runtime, manager.cancelOwned(owner, [owned.id, other.id])),
      /owner/i,
    );
    assert.equal(manager.view.get(owned.id)?.status, "running");
    await runTool(runtime, manager.cancelOwned(owner, [owned.id]));
    assert.equal(manager.view.get(other.id)?.status, "running");
    assert.equal(results.length, 1);
    assert.equal(results[0].outcome, "Interrupted");
    assert.equal(results[0].status, "error");
    assert.ok(!ordinary.includes(owned.id));
    await runTool(runtime, manager.cancelOwned(owner, [owned.id]));
    assert.equal(results.length, 1);
  });
});

test("shutdown reports owned interruption and refuses later continuation", async () => {
  await withManager(async (manager, runtime) => {
    const results: SubagentSnapshot[] = [];
    const owner = {
      id: "run",
      onSettled: (snap: SubagentSnapshot) => {
        results.push(snap);
      },
    };
    const snap = await runTool(
      runtime,
      manager.spawnOwned(
        {
          ...task("work"),
          execution: {
            model: { provider: "test", id: "pi" },
            thinkingLevel: "high",
          },
        },
        owner,
      ),
    );
    await runTool(runtime, manager.disposeAll);
    assert.equal(results.length, 1);
    assert.equal(results[0].outcome, "Interrupted");
    await assert.rejects(
      runTool(runtime, manager.sendOwned(owner, snap.id, "restart")),
      /tracked|shut/i,
    );
  });
});

test("owned work requires an explicit execution choice and freezes it before dispatch", async () => {
  await withManager(async (manager, runtime) => {
    const owner = { id: "run", onSettled: () => {} };
    await assert.rejects(
      runTool(
        runtime,
        manager.spawnOwned(
          task("missing") as import("./src/domain.ts").OwnedSpawnTask,
          owner,
        ),
      ),
      /execution/i,
    );
    const execution = {
      model: { provider: "test", id: "pi" },
      thinkingLevel: "high" as const,
    };
    const spawn = manager.spawnOwned({ ...task("frozen"), execution }, owner);
    execution.model.id = "changed";
    const snap = await runTool(runtime, spawn);
    assert.deepEqual(snap.execution, {
      model: { provider: "test", id: "pi" },
      thinkingLevel: "high",
    });
  });
});

test("owned sends cannot race cancellation into a new run", async () => {
  await withManager(async (manager, runtime) => {
    const owner = { id: "run", onSettled: () => {} };
    const snap = await runTool(
      runtime,
      manager.spawnOwned(
        {
          ...task("work"),
          execution: {
            model: { provider: "test", id: "pi" },
            thinkingLevel: "high",
          },
        },
        owner,
      ),
    );
    const cancelling = runTool(runtime, manager.cancelOwned(owner, [snap.id]));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await assert.rejects(
      runTool(runtime, manager.sendOwned(owner, snap.id, "racing send")),
      /stopping/i,
    );
    await cancelling;
    assert.equal(manager.view.get(snap.id)?.outcome, "Interrupted");
    assert.equal(manager.view.get(snap.id)?.status, "error");
  });
});

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
