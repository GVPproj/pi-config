# pi-config

<img width="1140" height="334" alt="image" src="https://github.com/user-attachments/assets/0a6d71c7-4e84-4ea1-8d9e-681593bf726d" />

A standalone [Pi](https://github.com/earendil-works/pi) package providing a custom startup screen, themes, Pi-only subagents, and parent-owned background terminals. It targets Pi 0.84.2.

## Resources

- `extensions/startup-screen`: responsive welcome card with the active model, tips, tool count, and recent sessions
- `themes`: Solarized Osaka and Solarized Light themes
- `extensions/background-terminals`: bounded, inspectable background processes
- `extensions/subagents`: in-process Pi child agents
- `extensions/orchestrator`: approved issue batches, retained herdr workspaces, exact-revision verification, and draft PR/integration delivery
- `skills/background-terminals`: guidance for background-process tools
- `skills/subagents`: guidance for delegating work to child agents
- `skills/orchestrate`: tracker-aware issue-batch planning and approval

## Development

```bash
npm install
npm run format:check
npm run check
npm test
```

## Issue orchestration

Use `/skill:orchestrate` in a trusted repository with `docs/agents/issue-tracker.md` (run `/setup` if missing), a running local herdr session, and the subagent extension enabled. The skill prepares a plan; `/orchestrator approve <digest>` starts only that plan. All roles inherit the parent model/thinking unless explicitly overridden in the approved plan.

`orchestrator` provides prepare, inspect, pause, resume, cancel, and open operations. `/orchestrator worker <job>` opens the existing child inspection UI; it does not launch another writer. `/orchestrator release` stops owned execution and releases the repository lock without deleting work. Resume requires explicit confirmation. Pausing lets active jobs settle; cancelling interrupts owned workers/checks.

State and evidence live under Pi's configured agent directory, keyed by Git common-directory identity and run UUID. Worktrees, branches, and child sessions are retained. Git creates checkouts with sanitized routing, replacements, and hooks; herdr's native worktree-open command registers the visible workspace without changing focus. This avoids executing Git under a long-lived herdr server's uncontrolled environment. Publication, remote CI, integration, and cancellation have separate outcomes. Never use an active job checkout as a second writer. Worktrees/tool policies are not a sandbox.

GitHub.com is the supported publication host; local integration needs no remote. PR dependencies use explicit single-parent stacks (group multi-parent PR work before approval); integration-only jobs can compose multiple prerequisites. Required CI is observed against the exact SHA every 15 seconds, for up to 30 minutes, without model polling. Unavailable evidence blocks rather than passing. Baseline exceptions are documentary: checks must distinguish pre-existing failures from new ones. Unsupported hosts, ambiguous setup/workspace creation, and dirty/diverged checkouts block for explicit reconciliation; no destructive recovery is attempted. Resume can explicitly adopt retained checkouts (`recoverWorkspace`) or authorize a pending setup retry (`retrySetup`). Setup also prepares every new integration candidate before checks; completed steps are not replayed when resuming the same candidate. Checks use a parent-connected supervisor, persist their process identity before execution, and are reconciled before restart. An abandoned ownership-transition guard fails closed and requires manual inspection.

Validation uses public job operations with disposable Git repositories and controlled hosting/model adapters. `npm run test:herdr` additionally starts and cleans up its own isolated named herdr server; it never uses active workspaces. Ordinary `npm test` skips that opt-in acceptance test. Live provider output and real GitHub publication are not exercised by development tests.

## Attribution

Credit to [`davis7dotsh/my-pi-setup`](https://github.com/davis7dotsh/my-pi-setup), revision [`73bf4d8`](https://github.com/davis7dotsh/my-pi-setup/commit/73bf4d826f39b5cab6b7865e706ba4a2669629ca), by Benjamin Davis. Forking from there to do my own thing.
