# AgentWorkbench Architecture

Status: M8-B shipped (2026-09-03). This is the implementation map for the current runtime, not the original multi-agent product proposal.

## Runtime Path

There is one assembled runtime path for CLI and HTTP:

```text
awb.mjs
  ├─ EventBus       append-only event log
  ├─ AgentRegistry  agents/*.json configuration and probes
  └─ Orchestrator   task/run state machine and capability selection
       └─ adapters/index.mjs -> echo / claude-stream-json / codex-app-server / cli-text
             └─ sandbox.mjs + diff.mjs -> copied execution workspace, snapshots, diff, apply, rollback
       └─ metrics.mjs -> local lifecycle metric events and aggregation
       └─ dag.mjs + planner.mjs -> validated plans, dependency readiness, and parent aggregation
       └─ human-bridge.mjs -> briefing pause and untrusted receipt handoff
```

`server/http.mjs` creates the same three core objects and exposes them through REST and SSE. It does not introduce a separate persistence or orchestration implementation. The server only binds to `127.0.0.1`.

## Shared Agent Runtime Kernel

`shared/agent-runtime/` is the source of truth for executable resolution, Windows `.cmd`/`.bat` shim plans, argument template substitution, and bounded structured probes. Its public `probeCommand()` function returns the canonical result. Workbench keeps compatibility exports in `core/utils.mjs` and `core/probe.mjs`; Agent Crew imports the same kernel while retaining its synchronous `probeCli()` and bus dispatch contracts. This shared layer does not extract or merge EventBus, Orchestrator, or sandbox state; EventBus remains outside the shared kernel.

`shared/agent-runtime/discovery.mjs` adds read-only discovery over an explicit catalog, explicit manifest objects, and advisory known-GUI entries for Trae and WorkBuddy. It returns candidate `source`, `confidence`, probe status, and a validated configuration draft. It never scans recursively, installs anything, or mutates the registry. `AgentRegistry.importConfig()` is the only persistence path for a discovery draft: it validates the schema, writes one safe JSON basename atomically, reloads the registry, and leaves the imported Agent `unknown` until probing.

The Agent UI provides a structured editor over common draft fields and keeps an advanced JSON view synchronized. It previews routing impact from the edited capability/risk/enabled values and presents the final summary in the existing confirmation dialog before calling the import endpoint.

## Configuration-Driven Registry

`workbench/agents/*.json` is the registry source. Each entry defines an adapter `type`, capabilities, risk metadata, command, arguments, environment, and probe behavior. `config/schema.mjs` parses full-line comments without touching string contents, normalizes the legacy `adapterId` alias, and validates required fields, adapter types, risk levels, and capability tags. `AgentRegistry.load()` reads files independently: invalid files are excluded from execution and exposed through structured `errors`/`configError` data, while valid files continue loading. Selection and dispatch accept any enabled configured adapter whose probe succeeds; the adapter receives the complete configuration for command and protocol-specific behavior.

Claude stream-json, Codex app-server, ACP, and generic CLI adapters are executable only when their configured commands probe successfully. Human Bridge is an in-process adapter and reports available without spawning a process. Probe results with `status: unknown` are never treated as available.

Planner Agents advertise the existing `design` or `analyze` capability. `planner.mjs` extracts JSON from the terminal Run text, strips optional fences, hashes the raw candidate, and delegates schema/risk/dependency checks to `dag.mjs`. Accepted plans create child Tasks only after the plan event is persisted.

## Codex Session Lifecycle

Each Codex run owns one app-server process and one JSON-RPC session. The adapter performs `initialize`, `thread/start`, and `turn/start`, then waits for compatible completion notifications (`turn/completed`, `turn/complete`, `turn.finished`, or `event_msg/task_complete`). Completion payloads may be nested under `params.turn` or an `event_msg` payload. Server errors and early process exit become `run.failed`; timeout becomes `run.timeout`; an aborted run becomes `run.interrupted`. The adapter records `threadId` and `turnId`, sends `turn/interrupt` with both identifiers on timeout/abort, and closes the process. A guard ensures only one terminal event is emitted.

## EventBus Storage

`EventBus` receives the store root from `AWB_STORE` and writes to:

```text
<AWB_STORE>/eventbus/bus.jsonl
```

Writes are append-only. `seq` is assigned in memory and must remain contiguous across stored events. Every interior blank record is corruption; one final newline is legal. `readAll()` rejects malformed JSON, blank records, or sequence gaps, while `integrityCheck()` returns a structured result for the CLI and HTTP audit endpoints. `run.created` stores prompt length and SHA-256 rather than raw prompt text; replay accepts older events that still contain a prompt. `Orchestrator.replay()` folds later events into the same stable task/run/verdict state. The bus sanitizer redacts recognized secret patterns before writing.

## State and Verdicts

Tasks start as `pending`, become `running` during dispatch, and become `awaiting-review` after a configured adapter emits `run.completed`. Human Bridge Runs pause at `awaiting-human`; `run.briefing-ready` is retained on the Run and mirrored by `bridge.requested`. `submitBridgeReceipt()` appends one `bridge.submitted` event and one untrusted `run.completed` event, then moves the Task to `awaiting-review`. High-risk tasks start with `approval.status=pending`; `submitApproval()` persists approved/denied decisions and dispatch refuses unapproved tasks. A reviewer submits `passed`, `rejected`, or `rework`. Maker-checker is enforced by rejecting any verdict where `reviewerId === run.agentId`; the denial is itself an auditable `verdict.denied` event. Accepted verdicts update the task state and are recoverable through replay.

Each failed or timed-out Run may schedule an immutable retry Run using exponential backoff up to `maxRetries`. A watchdog races every adapter iterator step against the effective timeout, requests interruption, waits the configured grace period, invokes adapter termination when available, and emits one authoritative timeout outcome. Inline CLI and HTTP dispatch return the terminal Attempt, including the final retry outcome.

`runTaskGraph()` executes accepted child plans with a bounded worker loop. It marks ready children, blocks missing capabilities or failed dependencies, dispatches independent children concurrently, and persists `scheduler.started`, `task.ready`, `task.blocked`, `task.aggregate.updated`, and `scheduler.completed`. Replaying these events reconstructs the graph but never starts a Run.

## Sandbox and Change Lifecycle

`Orchestrator._executeRun()` creates `<AWB_STORE>/runs/<runId>/workspace` by copying the task target within the requested scope. The Agent receives that copied directory as `cwd`. A pre-run snapshot records file hashes and backs up original contents; after the adapter reaches a terminal event, a second snapshot and persisted diff are created. Text changes include a zero-dependency unified diff, while binary changes include metadata only.

`apply(runId)` is a deliberate post-review operation. It requires a completed Run and `verdict === passed`, compares the current target snapshot with the pre-run snapshot, and returns `409 target_conflict` if the target changed externally. On success it copies additions/modifications and removes deletions, while storing `snapshot-apply-before`. `rollback(runId)` restores that apply snapshot and emits `run.rolled-back`; event replay reconstructs diff/apply/rollback metadata after restart.

## Interfaces

CLI entry points are implemented in `awb.mjs` (`agents:list`, `agents:probe`, `agents:discover`, `task:create`, `task:list`, `task:dispatch`, `task:decompose`, `task:run`, `task:approve`, `task:reject`, `task:verdict`, `run:interrupt`, `bus:tail`, `audit`, `metrics`, and `replay`). The HTTP server mirrors the shipped task/agent/run operations under `/api/*`, including read-only `/api/agents/discover`, explicit `/api/agents/import`, approval, metrics, decomposition, graph execution, Human Bridge submission at `/api/bridges/:runId/submit`, run diff inspection, and apply/rollback. Exact loopback Host validation, same-origin mutation checks, task/run ID validation, and static-file containment are enforced at the router boundary. `GET /api/events?since=<seq>` is an SSE view over the same EventBus and supports replay-on-connect plus polling for new events.

## Deferred Architecture

Git worktrees, Tauri packaging, remote execution, automatic enablement and vendor-specific recursive Agent discovery, and full EventBus/orchestration extraction are explicitly deferred. Planner/DAG execution is shipped in M6, local Human Bridge handoff in M7-A, truthful configuration-driven probes plus ACP/CLI execution in M7-B, the shared executable runtime kernel in M8-A, and bounded read-only discovery plus explicit import in M8-B. The shipped sandbox is a copied directory with file snapshots and deterministic apply/rollback; Git-backed isolation, richer routing, and remote GUI bridges remain future work.
