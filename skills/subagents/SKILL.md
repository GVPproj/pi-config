---
name: subagents
description: Delegate independent work to background Pi subagents when parallelism will materially help, or when the user asks to use subagents.
---

# Subagents

Use `subagent_spawn` for self-contained work that can proceed independently while you continue useful parent work. Each child is a headless in-process Pi session with its own context window and persisted transcript.

## Delegate deliberately

Proactively delegate when a task has a genuinely independent stream, such as:

- codebase research or locating an implementation while you inspect another area
- running a focused review or diagnosis that does not need the parent's evolving context
- executing an independent test or verification track

Do not delegate trivial work, tightly serial work, or work whose coordination cost exceeds the saved time. Do not spawn a child merely to repeat the parent's work. Never split concurrent edits across overlapping files.

## Child contract

Children cannot see the parent conversation. Give each child a complete prompt containing:

- the concrete objective and expected report
- relevant absolute paths and known context
- constraints, exclusions, and verification requirements
- explicit file ownership if edits are allowed

Children share the parent's host and workspace with full filesystem access; there is no sandbox or worktree isolation. Prefer read-only delegation when parent and child activity could conflict. Children cannot call any `subagent_*` or `bg_*` tool.

## Model behavior

Omit `model` so the child inherits the parent's exact model. Set `model` only when the user explicitly requests that model for the child; use `provider/model-id`, for example `opencode-go/glm-5.2`. Child reasoning always inherits the parent's current level.

## Spawn and manage

Call `subagent_spawn` with a self-contained `prompt`, short `name`, and optional `working_dir`. At most four children run concurrently.

- `subagent_check({ id })`: inspect current status without blocking or consuming the result.
- `subagent_list()`: list all tracked runs.
- `subagent_wait({ ids })`: block only when their results are required to proceed.
- `subagent_cancel({ ids })`: stop runs while preserving partial persisted transcripts.
- `/subagents`: inspect a transcript or take over a child interactively.

Results arrive automatically exactly once. After spawning, continue useful parent work instead of polling or immediately waiting.
