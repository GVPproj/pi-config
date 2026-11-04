# Plan format

`orchestrator prepare` reads a JSON file. Unknown fields are rejected. `models` can be omitted at the tool boundary to inherit the current parent model/thinking for all roles; the resolved choices appear in the approval proposal and are persisted. Override individual roles as needed: implementation/review default to the parent, and conflict defaults to the implementation choice.

```json
{
  "base": "HEAD",
  "delivery": "draft-pr",
  "destination": {
    "remote": "origin",
    "url": "git@github.com:owner/repository.git",
    "repository": "owner/repository",
    "prBase": "main"
  },
  "jobs": [
    {
      "id": "issue-123",
      "branch": "orchestrator/batch-unique-id/issue-123",
      "issues": [
        {
          "id": "123",
          "source": "https://github.com/owner/repository/issues/123",
          "title": "Issue title",
          "material": "Full relevant body and comments, with provenance",
          "acceptance": ["Observable acceptance criterion"],
          "retrievedAt": "2026-01-01T00:00:00Z"
        }
      ],
      "dependencies": []
    }
  ],
  "setup": [],
  "checks": [{ "name": "tests", "command": "npm test", "timeoutMs": 120000 }],
  "requiredCI": [],
  "concurrency": 2,
  "repairLimit": 2,
  "permissions": [
    "Create local commits",
    "Push owned branches and open draft PRs; pushes trigger CI"
  ],
  "baselineExceptions": [],
  "cleanup": "retain"
}
```

Use a unique `orchestrator/` namespace for every batch. No existing branch is adopted during approval. `base` resolves to an exact commit before approval.

`delivery` is `draft-pr`, `integration`, or `both`. Integration requires `integration: { "branch": "orchestrator/batch-unique-id/integration", "publish": false }`. Publishing requires an approved `destination`. Local integration need not have a remote. Required CI without publication is invalid.

Group related issues in one job's `issues` array before approval. PR dependencies currently support a single stacked parent per job: list that job ID in `dependencies` and set `prBaseJob` to it. Group work with multiple PR parents explicitly. Integration-only jobs can have multiple dependencies. Every dependent receives exact verified prerequisite revisions.

Optional explicit models:

```json
{
  "models": {
    "implementation": { "model": "provider/model-id", "thinking": "high" },
    "review": { "model": "provider/model-id", "thinking": "high" },
    "conflict": { "model": "provider/model-id", "thinking": "high" }
  }
}
```

Commands execute with no stdin, bounded timeout, captured logs and process-group cancellation. Commands must be safe in an isolated worktree and leave tracked source unchanged. Workers commit before checks; every verification is tied to a clean, exact commit. Baseline exceptions document known limitations, but a failing command still blocks: use checks that distinguish existing failures from new ones; ambiguous attribution never passes. No command is automatically exempted merely because its name appears in an exception.
