import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolvePiModel } from "./src/backends/pi.ts";

const models = [
  { provider: "parent-provider", id: "parent-model", contextWindow: 100_000 },
  { provider: "parent-provider", id: "shared", contextWindow: 100_000 },
  { provider: "other-provider", id: "shared", contextWindow: 100_000 },
  { provider: "opencode-go", id: "glm-5.2", contextWindow: 200_000 },
] as const;

const registry = {
  find(provider: string, id: string) {
    return models.find(
      (model) => model.provider === provider && model.id === id,
    );
  },
  getAll() {
    return [...models];
  },
} as unknown as ModelRegistry;

const inherited = { provider: "parent-provider", id: "parent-model" };

test("an omitted model inherits the exact parent model", () => {
  assert.equal(resolvePiModel(registry, undefined, inherited), models[0]);
});

test("an explicitly requested provider/model resolves exactly", () => {
  assert.equal(
    resolvePiModel(registry, "opencode-go/glm-5.2", inherited),
    models[3],
  );
});

test("a bare explicit model prefers the inherited provider", () => {
  assert.equal(resolvePiModel(registry, "shared", inherited), models[1]);
});

test("ambiguous or unknown explicit models fail clearly", () => {
  assert.throws(
    () => resolvePiModel(registry, "shared", undefined),
    /multiple providers/,
  );
  assert.throws(
    () => resolvePiModel(registry, "missing", inherited),
    /Unknown model/,
  );
});
