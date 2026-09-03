# AgentWorkbench M6 Planner/DAG Design

Status: Proposed after user approval (2026-09-03).

## Goal

Make the local AgentWorkbench capable of turning one parent task into a validated dependency DAG, scheduling ready subtasks through the existing AgentRegistry and Orchestrator, and producing a replayable parent summary while preserving M5 approval, retry, watchdog, privacy, and metrics behavior.

## Scope

M6 adds four capabilities:

1. A Planner contract that returns a strict JSON task graph.
2. Event-sourced parent/child and dependency relationships.
3. Dependency-aware scheduling with parallel execution of independent ready tasks.
4. `blocked` state and parent aggregation when capability or dependency requirements cannot be satisfied.

M6 does not add Git worktrees, remote execution, Tauri packaging, Human Bridge completion, ACP, multi-user authorization, or a general workflow language.

## Design Principles

- The Planner proposes structure; the Orchestrator remains the only component allowed to create Runs, apply approval gates, retry, enforce timeouts, and accept results.
- The EventBus remains the source of truth. Every decomposition and scheduling decision is persisted before it is relied upon.
- Existing single-task dispatch remains valid. A task without children continues to use the M5 Inline Execution path.
- No runtime dependencies are added. Planner output is validated with local JavaScript code.
- Invalid or unsafe plans fail closed without creating child Runs.

## Data Model

### Task fields

Existing Task fields remain unchanged. M6 adds:

- `parentTaskId: string | null` — parent task, null for a root task.
- `children: string[]` — child task IDs in plan order.
- `planVersion: number` — starts at 0; each accepted decomposition increments it.
- `planStatus: "none" | "pending" | "accepted" | "rejected"`.
- `blockedReason: { code: string, message: string, missingTags?: string[] } | null`.
- `aggregate: { total, completed, failed, timeout, interrupted, blocked } | null` for parent summaries.

The task state set adds `blocked`. A parent task with accepted children is `running` while children are active, then becomes `awaiting-review` when every child reaches a successful review-ready terminal state. A failed, timed-out, interrupted, or blocked child prevents automatic parent acceptance and is reflected in `aggregate`.

### Planner output

The Planner must return an object with exactly one required top-level `tasks` array. Each child entry contains:

```json
{
  "taskId": "subtask-build",
  "title": "Build the service",
  "description": "Implement the service layer",
  "requiredTags": ["write"],
  "dependencies": [],
  "sandboxMode": "workspace-write",
  "scope": null
}
```

Allowed fields are `taskId`, `title`, `description`, `requiredTags`, `dependencies`, `sandboxMode`, and `scope`. Unknown fields are ignored for forward compatibility but never passed to an adapter. `taskId` must satisfy the existing task ID contract and be unique within the plan and event store. Dependencies may refer only to sibling child IDs. A child cannot depend on itself, and Kahn topological validation must reject cycles.

The plan must contain at least one child and no more than 64 children. Required tags must use the existing capability vocabulary. `sandboxMode` defaults to the parent value and cannot reduce a parent `high-risk` task to a lower-risk mode.

## Planner Contract

The Orchestrator exposes `decomposeTask(taskId, plannerAgentId, prompt?)`.

1. Resolve the parent task and planner Agent through the normal registry/probe checks.
2. Run the planner using an adapter with a planner-specific prompt requesting JSON only.
3. Collect text output without persisting the raw planner prompt or untrusted output in `task.decomposed`; store only the output hash, length, planner run ID, and normalized child definitions.
4. Parse the first valid JSON object and validate the plan schema, IDs, capabilities, dependencies, limits, and risk inheritance.
5. On validation failure, persist `task.plan.rejected` and leave the parent unchanged.
6. On success, persist `task.plan.accepted` followed by child `task.created` events. Only after those events are written does the parent expose its children to the scheduler.

Planner Runs use the existing Run lifecycle and therefore receive approval, retry, watchdog, snapshots, and metrics. A planner must be a configured Agent with the existing `design` or `analyze` capability; no new capability vocabulary is introduced for M6. The default Echo fixture may be used in tests with a deterministic JSON response.

## Events

M6 introduces these event payload types under the existing `kind: "task"` or `kind: "scheduler"` event families:

- `task.plan.requested`: parent task, planner agent, plan version, prompt length/hash.
- `task.plan.accepted`: parent task, plan version, normalized child IDs, plan hash.
- `task.plan.rejected`: parent task, plan version, rejection code and message.
- `task.created`: child task with `parentTaskId` and dependency IDs.
- `task.blocked`: task ID, reason code, message, and missing tags when applicable.
- `task.ready`: task ID and satisfied dependency IDs.
- `task.aggregate.updated`: parent task aggregate counters and child states.
- `scheduler.started` / `scheduler.completed`: parent task, scheduled child IDs, and final aggregate.

Raw prompts, planner output text, and adapter output bodies are not included in these events. Existing EventBus secret sanitization remains active.

## Scheduler Semantics

The Orchestrator exposes `runTaskGraph(parentTaskId, options?)`.

- A task is ready when all dependencies have a terminal `run.completed` outcome (represented by child Task state `awaiting-review` or `passed`) and the task has not already produced a Run for the current plan version.
- Ready tasks are dispatched concurrently with `Promise.allSettled`; each child still gets an independent immutable Run and M5 lifecycle controls.
- Before dispatch, capability selection runs independently per child. No match produces `task.blocked` and does not consume a Run ID.
- A blocked child causes dependent children to become blocked with reason `dependency_blocked`.
- A failed, timeout, or interrupted child stops automatic scheduling of descendants unless `continueOnFailure: true` is explicitly requested. Even with continuation, the parent cannot auto-complete.
- Scheduler calls are idempotent for a given parent and plan version. Repeated calls reuse existing child state and never duplicate `task.created` or Run events.
- Parent aggregation is recalculated from replayed child states, not from an in-memory counter alone.

The default policy is fail-fast (`continueOnFailure: false`). Parallel execution is limited by an in-process `maxParallel` option, defaulting to 4, and never bypasses approval or adapter availability checks.

## HTTP and CLI

CLI additions:

```text
node awb.mjs task:decompose --task <id> --planner <agent-id> [--prompt <text>]
node awb.mjs task:run --task <id> [--maxParallel <n>] [--continueOnFailure]
```

HTTP additions:

- `POST /api/tasks/:id/decompose` with `{ plannerAgentId, prompt? }`
- `POST /api/tasks/:id/run` with `{ maxParallel?, continueOnFailure? }`

Both APIs return structured JSON errors and preserve loopback/origin validation. Decomposition returns the parent snapshot and normalized children. Graph execution returns the parent snapshot, child snapshots, and aggregate summary after the scheduler reaches a stable point.

## Error Handling

- Missing parent or planner Agent: 404/400 with no mutation.
- Planner unavailable or non-planning: 409 with no child creation.
- Invalid JSON/schema/cycle/duplicate ID: `task.plan.rejected`, parent remains unchanged.
- Existing child ID collision: plan rejected before any child event.
- Dependency blocked or missing capability: child becomes `blocked`; this is a durable state, not a failed Run.
- EventBus corruption: scheduling aborts and leaves the existing graph untouched.
- Concurrent decomposition: only the first accepted `planVersion` wins; later requests return `plan_conflict`.

## Testing Requirements

Tests must cover:

1. Planner JSON parsing, unknown fields, limits, risk inheritance, duplicate IDs, invalid capabilities, missing dependencies, self-dependencies, and cycles.
2. Event ordering and replay of accepted/rejected plans, child creation, blocked states, and aggregates.
3. Parallel scheduling of independent children with a deterministic max-concurrency assertion.
4. Dependency ordering and prevention of descendant dispatch after failure or block.
5. Idempotent repeated `task:run` calls and plan-version conflict handling.
6. CLI and HTTP happy paths plus validation/error responses.
7. Regression coverage proving M5 approval, retry, watchdog, prompt privacy, metrics, diff/apply/rollback, and single-task Inline Execution remain unchanged.

## Success Criteria

- A root task can be decomposed into at least three children by a configured planner fixture.
- Independent children execute in parallel, dependent children wait for prerequisites, and the parent aggregate is persisted.
- Missing capability produces a durable `blocked` task with missing tags visible through CLI/HTTP and replay.
- Restarting the runtime and replaying the EventBus reconstructs the exact DAG and scheduler state without duplicate Runs.
- All existing and new tests pass with no new runtime dependency.
