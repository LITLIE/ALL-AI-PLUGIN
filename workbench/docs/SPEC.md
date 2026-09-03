# AgentWorkbench Specification

Status: M8-B shipped (2026-09-03). This document describes the behavior that is implemented and tested in `workbench/`. Earlier planning documents remain useful as a roadmap, but are not a claim that the full product is present.

## 1. Shipped Scope

The workbench is a local, zero-runtime-dependency Node.js runtime with this execution path:

`awb.mjs` -> `EventBus` + `AgentRegistry` + `Orchestrator` -> configured adapter -> persisted events.

The deterministic `echo-test` agent remains the no-network test path. Claude stream-json and Codex app-server adapters are executable through the same Orchestrator when their configured commands probe successfully. Codex uses a per-run JSON-RPC session with `initialize`, `thread/start`, and `turn/start`; completion, server errors, process exit, timeout, and abort all resolve to one normalized terminal event. Real CLI smoke tests require local installation/authentication and are not part of the default test suite. In the current environment, Codex probes successfully while Claude is unavailable because its command is not on the Node process PATH.

The registry is configuration-driven and validated. JSON files in `workbench/agents/` define an agent id, adapter type, capabilities, risk metadata, command, arguments, environment, and probe behavior. `type` is canonical; legacy `adapterId` is accepted only as an alias. Risk levels are `read-only`, `workspace-write`, or `high-risk`, and capability tags are checked against `workbench/config/capabilities.json`. Invalid files are isolated and reported through structured registry errors without blocking valid Agents. Every adapter probe returns `{ok,status,resolved,version,code,error,checkedAt}`; `status: "unknown"` is used before the first explicit probe and unknown/unavailable Agents are excluded from automatic routing. Adding a compatible configured adapter does not require changing the registry or Orchestrator.

Executable resolution and probe execution are shared with the sibling Agent Crew plugin through `shared/agent-runtime/`. The shared kernel exposes `probeCommand()` and preserves `shell: false`, handles Windows `.cmd`/`.bat` shims through explicit `cmd.exe /d /s /c` arguments, expands configured templates, and keeps the 4-second bounded probe contract. Workbench compatibility modules and Agent Crew's synchronous `probeCli()` keep their existing public shapes.

The shared kernel also provides bounded installed-Agent discovery. Discovery probes only the configured catalog and explicit manifests on the current PATH; it does not crawl home directories, install packages, or make network requests. Results expose `source` (`path`, `manifest`, or `known-gui`) and `confidence` (`high` or `advisory`). Discovery is read-only: candidates are never enabled or routed automatically. A client must explicitly confirm a draft through `POST /api/agents/import`; the imported Agent is reloaded with `status: "unknown"` and remains unroutable until a later explicit probe succeeds.

High-risk tasks enter an explicit approval state. Dispatch is rejected with `409 approval_required` until a different reviewer approves the task; approval decisions are append-only and replayable. Self-approval and decisions after a terminal approval state are rejected.

Each dispatched Run executes in an isolated local copy at `<AWB_STORE>/runs/<runId>/workspace`. The target directory is never used as the Agent process cwd. Copy and snapshot scope support `include`/`exclude`; `.git`, `node_modules`, `dist`, and an in-target `.awb` store are excluded by default. Symlinks and paths outside the target are rejected.

Root Tasks may be decomposed by a configured Planner Agent into a validated 1-64 child DAG. Child Tasks persist `parentTaskId`, dependencies, plan version, and blocked reasons. `task:run` schedules ready children in parallel (default maximum 4), propagates dependency failures/blocks, and persists a parent aggregate. A missing capability produces `blocked` instead of consuming a Run ID.

Human Bridge Agents use the `awaiting-human` state. Inline Execution persists a briefing and pauses the Run; the browser or another local client submits a non-empty receipt through `POST /api/bridges/:runId/submit`. Submitted output is retained as `untrusted` with `via: "human-bridge"`, then enters the normal diff and maker-checker review flow. Duplicate, blank, unknown, and non-bridge submissions are rejected without a second completion event.

## 2. Event Store Contract

Set `AWB_STORE` to choose the store root. The event log is always:

`<AWB_STORE>/eventbus/bus.jsonl`

The file is append-only JSONL. Each event has a one-based, contiguous `seq`; interior blank records are invalid and only the final newline is ignored. `audit` checks JSON validity and sequence continuity. Runtime state is rebuilt by replaying the event log; there is no second database. Secrets matching the bus sanitizer patterns are redacted before persistence. `run.created` stores prompt length and SHA-256 only; older logs containing a prompt remain replay-compatible but new prompts are never persisted.

`kind: "metric"` events record local lifecycle telemetry (`run.started`, `run.completed`, `run.failed`, `run.timeout`, `run.interrupted`, `run.retry`, `run.duration_ms`, and `run.cost`). `metrics` and `GET /api/metrics` aggregate counts, durations, retry totals, and per-agent outcomes without exporting data.

## 3. CLI Contract

Run commands from `workbench/`:

```text
node awb.mjs agents:list
node awb.mjs agents:probe
node awb.mjs agents:discover [--commands claude,codex]
node awb.mjs task:create --title <text> --requiredTags <a,b> [--description <text>] [--cwd <path>] [--sandboxMode read-only|workspace-write|high-risk]
node awb.mjs task:list
node awb.mjs task:dispatch --task <task-id> [--agent <agent-id>]
node awb.mjs task:decompose --task <task-id> --planner <agent-id> [--prompt <text>]
node awb.mjs task:run --task <task-id> [--maxParallel <n>] [--continueOnFailure]
node awb.mjs task:approve --task <task-id> --reviewer <id> [--agent <agent-id>] [--reason <text>]
node awb.mjs task:reject --task <task-id> --reviewer <id> [--agent <agent-id>] [--reason <text>]
node awb.mjs task:verdict --run <run-id> --action passed|rejected|rework --reviewer <id> [--note <text>]
node awb.mjs run:interrupt --run <run-id>
node awb.mjs bus:tail [count]
node awb.mjs audit
node awb.mjs metrics [windowMs]
node awb.mjs replay
```

The six-command Echo smoke flow is:

```text
AWB_STORE=<temporary-dir> node awb.mjs agents:list
AWB_STORE=<temporary-dir> node awb.mjs task:create --title "Echo smoke" --requiredTags read
AWB_STORE=<temporary-dir> node awb.mjs task:dispatch --task <task-id> --agent echo-test
AWB_STORE=<temporary-dir> node awb.mjs task:verdict --run <run-id> --action passed --reviewer human
AWB_STORE=<temporary-dir> node awb.mjs replay
AWB_STORE=<temporary-dir> node awb.mjs audit
```

The dispatch output supplies `<run-id>`. The verdict is maker-checker gated: the reviewer id must differ from the run's agent id. Supported verdicts are `passed`, `rejected`, and `rework`; a denied self-review is persisted as `verdict.denied`.

`task:dispatch` uses Inline Execution: it prints the terminal Run after adapter completion, retry exhaustion, timeout, or interruption. Snapshot, diff, apply, and rollback are available through the HTTP API; a future CLI surface may wrap these operations.

## 4. HTTP and SSE Contract

`node awb.mjs serve` starts a loopback-only server (default `http://127.0.0.1:7788`). Implemented JSON endpoints are:

- `GET /api/health`
- `GET /api/agents`, `GET /api/agents/discover`, `POST /api/agents/import`, `POST /api/agents/probe`
- `GET /api/tasks`, `POST /api/tasks`, `GET /api/tasks/:id`
- `POST /api/tasks/:id/dispatch`
- `POST /api/tasks/:id/decompose`
- `POST /api/tasks/:id/run`
- `POST /api/bridges/:runId/submit`
- `POST /api/approval`
- `GET /api/runs/:id`, `POST /api/runs/:id/interrupt`, `POST /api/runs/:id/verdict`
- `GET /api/runs/:id/diff`
- `POST /api/runs/:id/apply`, `POST /api/runs/:id/rollback`
- `GET /api/audit`, `GET /api/metrics?windowMs=<positive integer>`, `GET /api/bus/recent`

`GET /api/events?since=<seq>` is the SSE stream. It replays events after `since` from the same `bus.jsonl`, then polls for new events and emits a periodic heartbeat. Reconnects use the last received sequence and are duplicate-free.

Requests require an exact loopback `Host`. Browser-originated mutations must use the same `Origin`. Task IDs are either server-generated or validated before persistence, and static files are served only from `workbench/ui/`.

`GET /api/runs/:id/diff` returns persisted `added`, `modified`, and `deleted` changes, with unified text diffs and binary metadata. `apply` requires a `completed` Run with a `passed` verdict and an available diff. Before writing, the target is snapshotted again and compared with the pre-run snapshot; an external change returns `409 target_conflict` and writes an audit event without applying partial changes. A successful apply stores `snapshot-apply-before` so `rollback` can restore the exact pre-apply state. Repeated calls return `already_applied` or `already_rolled_back` conflicts.

## 5. UI Contract

`node awb.mjs serve` serves the browser workbench from `/`. The UI shows Agent health, task states including `awaiting-human`, selected Run logs, Human Bridge briefing/receipt controls, diff summaries, and existing approval/verdict/apply/rollback actions. The Agent view can run read-only discovery, inspect candidate `source`/`confidence`, edit a JSON draft, and require confirmation before importing it. Imported Agents are displayed as `未探活` until the user invokes the explicit re-probe action. The UI consumes `GET /api/events?since=<seq>` and reconnects from the latest sequence without duplicating events.

## 6. Explicitly Deferred

The following are roadmap items, not shipped behavior: recursive vendor-specific installation scanning, automatic enablement/routing, Git worktree integration; Tauri packaging; and multi-user/cloud/remote operation. ACP and generic CLI adapters are shipped as configuration-driven local process adapters; their `command`, `args`, `env`, `cwd`, and `healthCheck.expect` fields are used for both probing and execution. The current sandbox is a local copied workspace, not a Git worktree. Human Bridge is shipped for local GUI-agent handoff; remote execution and multi-user bridges remain deferred.

## 7. Verification

The repository's `node --test` suite covers EventBus integrity/replay, registry loading and probing, sandbox copy/containment/snapshots, diff classification and unified text output, Echo orchestration and interruption, Claude and Codex fixture adapters (including nested completion, server error, early exit, timeout, and abort), Human Bridge waiting/submission/replay, approval gates, retries, watchdog termination, prompt privacy, lifecycle metrics, Planner JSON validation, DAG cycles/readiness, blocked propagation, parallel scheduling, maker-checker verdicts, apply conflict detection, rollback, replay recovery, CLI persistence, HTTP boundary validation, graph routes, bridge submission, dispatch, diff/apply/rollback, UI projection, and SSE replay. The test suite does not require network access or agent authentication.
