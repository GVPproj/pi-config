import { Type, type Static } from "typebox";

const text = Type.String({ minLength: 1 });
const object = <T extends Record<string, import("typebox").TSchema>>(
  properties: T,
) => Type.Object(properties, { additionalProperties: false });
const choice = <T extends string>(values: T[]) =>
  Type.Unsafe<T>({ type: "string", enum: values });
export const ModelSchema = object({
  model: text,
  thinking: choice(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
});
export type ModelChoice = Static<typeof ModelSchema>;
const CommandSchema = object({
  name: text,
  command: text,
  timeoutMs: Type.Integer({ minimum: 1, maximum: 3_600_000 }),
});
export type Command = Static<typeof CommandSchema>;
export const PlanSchema = object({
  base: text,
  delivery: choice(["draft-pr", "integration", "both"]),
  destination: Type.Optional(
    object({ remote: text, url: text, repository: text, prBase: text }),
  ),
  integration: Type.Optional(object({ branch: text, publish: Type.Boolean() })),
  jobs: Type.Array(
    object({
      id: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$" }),
      branch: text,
      issues: Type.Array(
        object({
          id: text,
          source: text,
          title: text,
          material: text,
          acceptance: Type.Array(text, { minItems: 1 }),
          retrievedAt: text,
        }),
        { minItems: 1 },
      ),
      dependencies: Type.Array(text),
      prBaseJob: Type.Optional(text),
    }),
    { minItems: 1, maxItems: 32 },
  ),
  setup: Type.Array(CommandSchema),
  checks: Type.Array(CommandSchema, { minItems: 1 }),
  requiredCI: Type.Array(text),
  concurrency: Type.Integer({ minimum: 1, maximum: 4 }),
  repairLimit: Type.Integer({ minimum: 0, maximum: 2 }),
  permissions: Type.Array(text),
  baselineExceptions: Type.Array(text),
  cleanup: Type.Literal("retain"),
  models: object({
    implementation: ModelSchema,
    review: ModelSchema,
    conflict: ModelSchema,
  }),
});
export type Plan = Static<typeof PlanSchema>;
export type JobPlan = Plan["jobs"][number];
export type Stage =
  | "workspace"
  | "setup"
  | "implementation"
  | "checking"
  | "review"
  | "verified"
  | "publication"
  | "ci"
  | "integration";
export type ExecutionState =
  "queued" | "running" | "blocked" | "failed" | "cancelled" | "complete";
export interface CheckEvidence {
  name: string;
  command: string;
  sha: string;
  code: number | null;
  cancelled: boolean;
  timedOut: boolean;
  artifact: string;
}
export interface WorkerResult {
  id: string;
  session?: string;
  model: ModelChoice;
  status: "done" | "error";
  text: string;
}
export interface Workers {
  run(
    input: {
      owner: string;
      role: "implementation" | "review" | "conflict";
      cwd: string;
      prompt: string;
      model: ModelChoice;
      onStart: (id: string, session?: string) => void;
    },
    signal: AbortSignal,
  ): Promise<WorkerResult>;
}
export interface Models {
  validate(choice: ModelChoice): Promise<void>;
}
export interface Verification {
  sha: string;
  tree: string;
  base: string;
  dependencies: Record<string, string>;
  checks: CheckEvidence[];
  review: { worker: WorkerResult; artifact: string };
  time: string;
}
export const IntentSchema = object({
  kind: choice([
    "workspace",
    "setup",
    "compose-prerequisites",
    "implementation",
    "checking",
    "publication",
    "merge",
    "repair",
    "push",
  ]),
  time: text,
  sha: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" })),
});
export type Intent = Static<typeof IntentSchema>;
export interface Job {
  id: string;
  stage: Stage;
  state: ExecutionState;
  repairs: number;
  attempts: number;
  setupIndex: number;
  setupEvidence: CheckEvidence[];
  workspace?: import("./herdr.ts").Workspace;
  base?: string;
  source?: string;
  dependencies: Record<string, string>;
  executor?: { id: string; session?: string; role: string };
  executors: Array<{
    id: string;
    session?: string;
    role: string;
    model: ModelChoice;
  }>;
  checks: CheckEvidence[];
  checkProcess?: import("./commands.ts").CheckProcess;
  verification?: Verification;
  invalidations: string[];
  blocker?: string;
  feedback?: string;
  artifacts: string[];
  intent?: Intent;
  publication?: import("./github.ts").Publication;
  ci?: import("./github.ts").CiEvidence;
  integration?: { source: string; sha: string };
  cleanup: "retained";
}
export interface Integration {
  workspace?: import("./herdr.ts").Workspace;
  sha: string;
  startingSha: string;
  state: ExecutionState;
  job?: string;
  blocker?: string;
  intent?: Intent;
  checks: CheckEvidence[];
  checkProcess?: import("./commands.ts").CheckProcess;
  publication?: string;
  candidate?: string;
  feedback?: string;
  artifacts: string[];
}
export interface Run {
  version: 1;
  id: string;
  repo: string;
  identity: string;
  approval: string;
  approvedAt: string;
  plan: Plan;
  paused: boolean;
  cancelled: boolean;
  jobs: Record<string, Job>;
  artifacts: string[];
  integration?: Integration;
  history: string[];
}
