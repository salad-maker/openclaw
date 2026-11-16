# Coordination host patch for OpenClaw 2026.11.3

This branch adds host capabilities needed by a personal coordination plugin:
durable delegated work, authorized result retrieval and cancellation, scoped
memory and scheduling, and bounded file-tool workers with read-only reviewers.
It is a custom fork, not an official OpenClaw release or an upstream-supported
plugin API contract.

The coordination plugin is maintained separately and remains private. This
public branch contains the host implementation, host tests, and SDK documentation;
it does not distribute the plugin or install its `coordination_goal` tool.
No access to the private repository is needed to inspect this host patch.

## Base and implementation

- Upstream base: [`v2026.11.3`](https://github.com/openclaw/openclaw/releases/tag/v2026.11.3),
  commit `847611dcaa3bf0e2783335f961dd1fd0580e4d9f`.
- Initial interfaces: [`d5f040f3`](https://github.com/salad-maker/openclaw/commit/d5f040f3).
- Cancelled-run result retention: [`b61b2e27`](https://github.com/salad-maker/openclaw/commit/b61b2e27).
- Bounded native file tasks: [`00081825`](https://github.com/salad-maker/openclaw/commit/000818253a4e11e8a970b49a7808fecfea00d4a6).
- [Complete runtime changes against the release base](https://github.com/salad-maker/openclaw/compare/847611dcaa3bf0e2783335f961dd1fd0580e4d9f...000818253a4e11e8a970b49a7808fecfea00d4a6).

The tested and installed runtime is pinned to `00081825`. Later documentation
commits on this branch do not change that runtime. The fork's `main` is pinned
to the upstream release; it is separate from this patched branch.

## Why host changes are necessary

In the audited release, ordinary external plugins could admit native subagent
runs, but lacked the narrow interfaces needed to retrieve persisted results
after a restart and cancel exactly their own work. A process-local wait cache
was insufficient for recovery. The generic gateway interface also correctly
restricted external-plugin access.

Tool-using workers need additional enforcement at the native execution owner.
A plugin prompt cannot itself make a filesystem read-only, preserve a tool-call
budget across execution attempts, or prove that cancelled work has stopped.
The patch adds those controls without removing the generic gateway trust gate.

## What changes

| Capability                     | Host behavior                                                                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owned-run lookup               | `subagent.getRun` retrieves exact plugin-owned native run evidence, including result provenance and pending cleanup. It checks session permissions, physical identity and ownership.    |
| Owned cancellation             | `subagent.cancelRun` uses the native authorized stop path. An acknowledged request is distinct from confirmed settlement. Cancelled keep-mode results remain recoverable after cleanup. |
| Native lifecycle and deadlines | New child sessions receive native lifecycle identity. Bounded deadlines are forwarded to the execution owner; old ownership is not fabricated.                                          |
| Scoped memory                  | V2 `context.memory.search` binds retrieval to the caller's audience, project and sandbox through the existing memory provider.                                                          |
| One-shot scheduling            | V2 scheduling captures creator authority, exact ownership and correlation, using native scheduling/history rather than a second task service.                                           |
| File-tool delegation           | V2 `context.scopedTasks` prepares caller-bound native admission. The host checks the permitted parent tool surface and exact project before dispatch.                                   |
| Execution limits               | A persisted one-run claim prevents reentry from resetting the budget. Native execution enforces 1–300 seconds and 1–32 tool calls; ambiguous outcomes are not automatically replayed.   |
| Child sandbox                  | Scoped workers receive only requested file tools. Reviewer tasks are read-only. Child containers have no network or extra mounts; parent settings remain unchanged.                     |

OpenClaw remains the execution authority. The separate plugin owns goals,
dependencies and projections of native evidence. The patch does not add a
companion service or a competing Workboard execution state machine.

## Boundaries and current limits

- Caller JSON cannot grant ownership, choose an arbitrary workspace, or obtain
  operator authority. Requested tools restrict existing permissions rather than
  grant new ones. The parent must be allowed to delegate and use those tools.
- The scoped task path supports `read`, `write`, `edit`, and `apply_patch`.
  It refuses `exec`, recursive delegation, external execution harnesses and
  scheduled tool-using tasks. Tool-free one-shot scheduling is a separate path.
- Cancellation can remain pending while native execution or cleanup settles.
  Native kill reconciliation can take minutes; an abort signal is not proof of
  stopped work. File effects already performed are not undone.
- No exactly-once guarantee for external effects or hard monetary cap is made.
  A deadline and tool-call allowance are not a billing limit.
- A successful terminal-text match verifies that text condition, not general
  task correctness. Independent artifact or test checks are still necessary.
- Selecting an existing Telegram session through MCP does not confer that
  Telegram sender's authority. The private plugin currently restricts use to
  its authorized private Telegram scope; the patch does not bypass that policy.
- The demonstrated workflow is an explicitly sequenced worker and reviewer,
  not an autonomous multi-agent task-tree scheduler.

## Evidence

The patched source passed focused ownership, lifecycle, cancellation,
execution-budget, sandbox and reentry tests, core typechecking and targeted
lint. The full build, SDK export checks, package integrity/import checks,
disposable npm installation and packaged-gateway plugin registration smoke
also passed.

Integration fixtures exercised real native SQLite and Docker file tools with
synthetic caller identity and mocked inference. Controlled cancellation
required actual interruption, rejected early deletion and joined cleanup.
Three fresh native runtime processes demonstrated completion before plugin
result collection, recovery, and receipt retrieval with dispatch counts 1/0/0.
Those consumer fixtures live with the private plugin; they are not distributed
in this branch. The host regression tests are included here.

After approved local installation, private Telegram worker/reviewer runs
returned distinct successful native receipts and dependency handoff provenance.
A direct byte check independently verified the harmless acceptance file.
A later documentation task completed after its reviewer was given a larger
read budget. Live receipts were reported through the owner's Telegram session;
this is not a claim of broad provider compatibility or an independent audit.

## Source navigation

- [Background-work SDK documentation](docs/plugins/sdk-runtime/background-work.md)
- [Memory/context SDK documentation](docs/plugins/sdk-overview/memory-and-context.md)
- [Caller-bound task admission](src/plugins/tool-scoped-tasks.ts)
- [Native execution budget and one-run claim](src/agents/scoped-task-execution.ts)
- [Private native spawn authority](src/agents/subagents/spawn/scoped-task-authority.ts)
- [Memory binding](src/plugins/tool-memory.ts) and [schedule binding](src/plugins/tool-schedules.ts)
- [Admission tests](src/plugins/tool-scoped-tasks.test.ts) and [execution tests](src/agents/scoped-task-execution.test.ts)

## Deployment and maintenance

This branch is source for review and reproducible custom builds, not a one-click
installation of the private plugin. Follow this checkout's build prerequisites
and pinned package manager when building it. Installing the standard published
OpenClaw package does not include these changes.

Deploy a pinned build with configuration and stopped-state backups, preserving
native run correlation and plugin state. Check active work through supported
interfaces before restarting. Keep the patched host once a scoped child has
been admitted, even after it settles: the unpatched host does not enforce its
persisted one-run claim on later reentry. Operational rollback can disable the
plugin while retaining the patched host and all state; a host downgrade after
admission requires a separately reviewed migration or quarantine procedure.

Future upstream releases may change these interfaces. Updating this fork
requires compatibility checks; the patch has not been submitted or accepted
upstream as part of this work.
