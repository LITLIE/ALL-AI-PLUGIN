# AgentWorkbench M5 可靠性与安全控制设计

## Status

Proposed after user approval of the M5 implementation direction (2026-09-02). This design covers approval gates, retry orchestration, watchdog timeouts, process-tree termination, metrics, and prompt privacy. Planner/DAG decomposition remains M6.

## Goals

M5 must make a single Task execution dependable and auditable before the workbench grows into multi-task planning:

1. High-risk Tasks cannot start without an independent approval decision.
2. Failed or timed-out Attempts can be retried with bounded exponential backoff.
3. The Orchestrator has a timeout watchdog even when an adapter ignores its timeout argument.
4. Timeout and shutdown cleanup can terminate an adapter's complete process tree.
5. Run lifecycle metrics are persisted as `kind: "metric"` events and exposed for inspection.
6. Replay reconstructs approval, retry, timeout, and metric-related Run metadata without a second database.
7. Raw prompts are not persisted in `run.created`; only length and a one-way hash are retained.

## Non-Goals

M5 does not implement Planner/DAG decomposition, parallel Task scheduling, Git worktrees, human bridge completion, Tauri packaging, remote execution, or a full policy language. The existing copied sandbox and M4 apply/rollback behavior remain unchanged.

## State Model

### Task approval

`Task.sandboxMode` continues to use `read-only`, `workspace-write`, or `high-risk`.

- `read-only` and `workspace-write`: approval is `not_required`.
- `high-risk`: approval starts as `pending` and dispatch is rejected with `409 approval_required` until an independent reviewer grants it.
- A denial is terminal for that approval request. Duplicate or already-terminal decisions return `409`; a future re-approval flow must introduce an explicit new request event rather than mutating this history.

Approval decisions use `approved` or `rejected`, a non-empty `reviewerId`, optional `agentId`, optional reason, and timestamp. When an approval names an Agent, dispatch must use that Agent and the reviewer must not equal its id. Every decision is persisted as `approval.granted` or `approval.denied`.

### Run attempts

The first dispatch creates an Attempt Run with `attempt: 0`, `retryOf: null`, and `retryCount: 0`. A retry creates a new Run linked by `retryOf` and appends the new Run id to `Task.assignedRuns`; the previous Run remains terminal and immutable. The new Run inherits the Task, Agent, prompt hash, sandbox scope, and retry policy, but receives a fresh sandbox and snapshots.

The Task remains `running` while a retry is scheduled or executing. Only the final successful Run moves the Task to `awaiting-review`; exhaustion moves it to `failed` or `timeout` according to the final Attempt. Manual interruption disables automatic retry for that Attempt.

Retry policy:

```text
maxRetries = max(0, integer task.maxRetries ?? agent.maxRetries ?? 0)
delay = min(retryMaxDelayMs, retryBaseDelayMs * 2 ** retryCount)
```

Defaults are `retryBaseDelayMs = 250`, `retryMaxDelayMs = 10_000`. Retryable outcomes are `run.failed` and `run.timeout`; `run.interrupted` is not retryable. Each scheduled retry writes `run.retry.scheduled` with source Run id, next Run id, retry count, delay, and reason. A failed retry creation is recorded as `run.retry.failed` and leaves the Task failed.

## Execution and Timeout Contract

`Orchestrator._executeRun()` owns a watchdog timer around the adapter iterator. The effective timeout is the existing bounded value from Task/Agent configuration. On expiry:

1. Persist one `run.timeout.requested` event.
2. Abort the Run signal and call `adapter.interrupt({ runId, taskId, agentId, reason: "timeout" })`.
3. Wait up to `interruptGraceMs` (default 3 seconds) for the iterator/process to close.
4. If still active, call optional `adapter.terminate({ runId, reason: "timeout" })`, whose process-backed implementations use `killProcessTree()`.
5. Persist exactly one terminal `run.timeout` event. Late adapter output is ignored after the terminal guard.

Normal completion clears the watchdog before snapshot/diff finalization. The same cleanup path is used by service shutdown; shutdown does not create retries.

Adapter compatibility:

- Existing `interrupt()` remains the first cleanup hook.
- `terminate()` is optional; adapters without it rely on their existing interrupt implementation and are marked `termination: "cooperative"` in the metric payload.
- Process-backed adapters must expose the active process/session by Run id and implement `terminate()` with process-tree cleanup.

## Approval API and CLI

Add the following HTTP endpoint:

```text
POST /api/approval
body: {
  taskId: string,
  decision: "approved" | "rejected",
  reviewerId: string,
  agentId?: string,
  reason?: string
}
```

Responses are `200` for a persisted decision, `400` for malformed input, `404` for an unknown Task, and `409` for a duplicate or invalid state transition. The existing deferred placeholder is replaced; no other deferred route changes.

Add CLI commands:

```text
node awb.mjs task:approve --task <task-id> --reviewer <id> [--reason <text>]
node awb.mjs task:reject --task <task-id> --reviewer <id> [--reason <text>]
node awb.mjs metrics [windowMs]
```

The current `task:verdict` command remains the post-run acceptance gate. Approval and verdict are separate events and permissions.

## Metrics Contract

Introduce a small helper that appends `kind: "metric"` events with this payload:

```json
{
  "name": "run.completed",
  "value": 1,
  "unit": "count",
  "runId": "run-...",
  "taskId": "task-...",
  "agentId": "echo-test",
  "attempt": 0,
  "dimensions": { "outcome": "success" }
}
```

Required names are `run.started`, `run.completed`, `run.failed`, `run.timeout`, `run.interrupted`, `run.retry`, `run.duration_ms`, and `run.cost`. Values must be finite numbers; absent cost is omitted. Prompt text and full adapter output are never metric fields.

`core/audit.mjs` gains structured aggregation for counts, duration totals/averages, retry counts, and per-Agent outcome counts. Add `GET /api/metrics?windowMs=<positive integer>` and the `metrics` CLI command. Existing audit integrity behavior is unchanged.

## Event and Replay Contract

New event payload types:

```text
approval.granted
approval.denied
run.timeout.requested
run.retry.scheduled
run.retry.failed
run.terminated
```

`run.created` keeps the stable Run identity and replaces `prompt` with `promptLength` and `promptSha256`. Adapter events may still contain sanitized textual output for the existing live timeline, but the initial persisted event must not contain the raw prompt. Replay must:

- derive the latest Task approval state from approval events;
- retain every Attempt Run and its `retryOf` relation;
- mark the latest Attempt as authoritative for Task terminal state;
- ignore late events after a terminal guard;
- expose metric events without treating them as state transitions.

All new events use the existing EventBus append-only JSONL format and sanitizer.

## Files and Boundaries

- `workbench/core/orchestrator.mjs`: approval state, Attempt creation, retry scheduling, watchdog, terminal guard, metric emission, replay folding.
- `workbench/core/metrics.mjs`: metric event construction and aggregation, with no persistence outside EventBus.
- `workbench/core/audit.mjs`: delegate/compatibility wrapper for metrics aggregation.
- `workbench/adapters/claude-stream-json.mjs`, `codex-app-server.mjs`, `cli-text.mjs`, `acp.mjs`: optional `terminate()` implementation and cleanup metadata.
- `workbench/server/http.mjs`: `/api/approval` and `/api/metrics` routes.
- `workbench/awb.mjs`: approval and metrics CLI commands.
- `workbench/test/`: approval, retry, watchdog, process-tree, metrics, privacy, HTTP, CLI, and replay tests.
- `workbench/docs/SPEC.md`, `ARCHITECTURE.md`, and ADR-003: update shipped contract and roadmap boundary after implementation.

## Verification Criteria

1. A high-risk Task cannot create a Run before approval; grant/deny events replay correctly.
2. A fixture that fails twice and succeeds on the third Attempt produces three linked Runs, two retry events, and one reviewable final Run.
3. A hanging adapter reaches `run.timeout` within `timeout + interruptGraceMs + small test tolerance`, with no duplicate terminal event.
4. A fixture that spawns a child process leaves no child after timeout/terminate on Windows and POSIX test environments.
5. `node awb.mjs metrics` and `GET /api/metrics` return deterministic aggregates from persisted metric events.
6. `run.created` contains no raw prompt and includes a stable SHA-256 hash and length.
7. Existing M4 tests remain green, including sandbox isolation, diff, apply conflict detection, rollback, and SSE replay.

## Future Extensions

M6 may consume the retry/approval-aware Task state machine for Planner/DAG execution. Parallel scheduling, dependency conflict detection, and aggregate parent-task acceptance should build on these events rather than introducing a second state store.
