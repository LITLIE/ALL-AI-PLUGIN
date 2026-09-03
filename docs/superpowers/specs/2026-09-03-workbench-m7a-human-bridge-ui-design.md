# Workbench M7-A Human Bridge and UI Design

**Status:** Approved for implementation (2026-09-03)

## Goal

Deliver the first product-facing M7 slice for the local AI Agent orchestration workbench: a replay-safe Human Bridge workflow and a usable task/review UI built on the existing Inline Execution, EventBus, HTTP, SSE, sandbox, approval, retry, watchdog, metrics, and Planner/DAG contracts.

## Scope

### Human Bridge

- Add `awaiting-human` as a legal Run/Task state.
- Keep the existing `human-bridge` adapter as the execution boundary.
- Persist a sanitized `bridge.requested` event when a briefing is ready.
- Add `POST /api/bridges/:runId/submit` to accept a non-empty human receipt.
- Mark submitted receipts as `untrusted: true` and `via: "human-bridge"`.
- Reject unknown runs, non-Human-Bridge runs, duplicate submissions, and blank receipts without writing a terminal completion event.
- Replay requested/submitted bridge events and restore the same Run/Task state.

### UI

- Keep the zero-dependency browser SPA and existing inline icon system.
- Show Agent health, capabilities, risk, and probe state on the overview.
- Show task states including `awaiting-human` on the task board.
- Show selected task details with event/log context, diff, approval/verdict actions, and Human Bridge briefing/receipt controls.
- Consume the existing SSE stream and recover missed events using the `seq` cursor.
- Preserve the current dark-first token system and avoid new framework/runtime dependencies.

## Non-Goals

- Probe implementation redesign.
- `shared/` kernel extraction across repositories.
- ACP protocol wiring, Tauri packaging, remote execution, authentication, or multi-user collaboration.
- Changing the semantics of sandbox apply/rollback, approval, retries, watchdogs, metrics, or Planner/DAG scheduling.

## State and Event Contract

The Human Bridge lifecycle is:

```text
pending -> running -> awaiting-human -> completed -> awaiting-review -> passed/rejected/rework
```

The adapter may emit `run.awaiting-human` and `run.briefing-ready` during Inline Execution. The orchestrator maps the former to `awaiting-human` and retains the briefing on the Run. The adapter stream ending in `awaiting-human` must not be treated as a failed stream.

The submit endpoint appends one terminal `run.completed` event containing only receipt metadata and the receipt text as untrusted output. It then updates the Run to `completed` and the Task to `awaiting-review`. A second submission returns `409 bridge_already_submitted` and appends no completion event.

Required event payloads:

- `bridge.requested`: `runId`, `taskId`, `agentId`, `briefing`, `ts`.
- `bridge.submitted`: `runId`, `taskId`, `agentId`, `receiptLength`, `receiptSha256`, `untrusted: true`, `via: "human-bridge"`, `ts`.
- `run.completed` from submission: `runId`, `taskId`, `agentId`, `text`, `meta: { untrusted: true, via: "human-bridge" }`, `ts`.

Raw prompts remain excluded from newly introduced persisted metadata. Receipt text is intentionally retained as the Agent result, but is explicitly untrusted and must remain subject to diff review and maker-checker acceptance.

## HTTP Contract

`POST /api/bridges/:runId/submit`

Request:

```json
{"receiptText":"..."}
```

Responses:

- `200`: terminal Run snapshot when accepted.
- `400`: invalid JSON or blank/non-string receipt.
- `404`: unknown Run.
- `409`: Run is not waiting for Human Bridge or was already submitted.

The route uses the existing loopback Host and same-origin mutation checks.

## UI Interaction Contract

- The Human Bridge panel renders only when the selected Run is `awaiting-human` or has a stored briefing.
- Copying a briefing is a client-only clipboard action and does not append an event.
- Submitting a receipt disables the form while the request is in flight, then refreshes task/run state from the response and SSE.
- Empty/error states are explicit and actionable; no placeholder success state is shown.
- Diff/apply/rollback and verdict buttons remain gated by the existing server responses.

## Error Handling and Recovery

- Invalid bridge submissions do not mutate in-memory state or append terminal events.
- Replay treats bridge events as data and ignores malformed or unsupported event payloads without inventing completion.
- SSE reconnect starts from the last known sequence and de-duplicates by sequence number.
- If the browser loses connectivity during submission, the user can retry; the server's duplicate guard determines whether the first request succeeded.

## Testing

Add tests before implementation for:

- Human Bridge adapter/orchestrator transition to `awaiting-human`.
- Bridge submission success, metadata privacy, untrusted marking, and duplicate rejection.
- Replay recovery of waiting and submitted bridge Runs.
- HTTP route validation and status codes.
- Browser-safe UI rendering and Human Bridge interaction wiring.
- SSE reconnect behavior remains duplicate-free.

The existing full suite must remain green, with no runtime dependency additions.

