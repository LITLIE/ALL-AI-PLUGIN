# Agentplugin

一个本地 Claude Code 插件市场，目前收录一个插件：

## [agent-crew](plugins/agent-crew/) — 自定义 agent 之间的协作与沟通

把你自己设定的角色（Trae、Workbuddy、Critic，以及外部 CLI agent 如 OpenAI Codex）挂到同一条可落盘的消息总线上，用两种模式协作：

- **多方讨论 / 辩论**（`/agent-crew:discuss`）—— 各角色独立表态、互相质疑，收敛出结论。
- **流水线接力**（`/agent-crew:relay`）—— 设计 → 实现 → 评审 → 修复，一棒一棒交接。

角色既可以由 Claude 子智能体扮演，也可以绑定到任何外部命令行 agent —— 上层协作协议一样，底层随时可换。

## 安装

```
/plugin marketplace add D:\Agentplugin
/plugin install agent-crew@agentplugin-local
/reload-plugins
/agent-crew:setup
```

完整说明见 [plugins/agent-crew/README.md](plugins/agent-crew/README.md)。

## AgentWorkbench

`workbench/` contains a local AgentWorkbench runtime. It keeps the deterministic `echo-test` path for no-token validation and executes configured Claude stream-json, Codex app-server, ACP, and generic CLI Agents through the same EventBus, AgentRegistry, and Orchestrator when their local commands probe successfully. Every probe returns `status` (`available`, `unavailable`, or `unknown`), resolved executable, version, exit code, and bounded diagnostics; unprobed Agents are not routable. Codex runs use a real JSON-RPC session/turn lifecycle with normalized completion, error, timeout, and interruption events.

The append-only event log is stored at `<AWB_STORE>/eventbus/bus.jsonl`. From `workbench/`, use `node awb.mjs agents:list`, `agents:probe`, read-only `agents:discover`, `task:create`, `task:decompose`, `task:run`, `task:dispatch`, `task:approve`/`task:reject` for high-risk tasks, `task:verdict`, `metrics`, `replay`, and `audit`; `node awb.mjs serve` exposes the loopback HTTP API and `/api/events` SSE stream. Discovery returns bounded local candidates with `source` and `confidence`; it never auto-enables them. Explicitly confirmed drafts can be imported with `POST /api/agents/import` and remain `unknown` until probed. Inline Execution returns dispatch results, Human Bridge Runs pause at `awaiting-human` until `POST /api/bridges/:runId/submit` receives a receipt, and verdicts enforce maker-checker separation.

The default tests use local fixtures and do not require tokens. Agent JSON is validated against the shared capability/risk vocabulary; invalid files are reported without blocking valid Agents. Real Agent execution requires each CLI to be installed, authenticated, and visible to the Node process PATH; run `node awb.mjs agents:probe` to check. Each Run executes in a local copied sandbox under `<AWB_STORE>/runs/<runId>/workspace`, so the target directory is protected from direct Agent writes. M4 persists pre/post snapshots, classifies `added`/`modified`/`deleted` changes, exposes diff review over HTTP, and supports verdict-gated apply plus rollback with target-conflict detection. M5 adds approval gates, immutable retries with exponential backoff, watchdog interruption/termination, prompt privacy (length/hash only), and local lifecycle metrics via `node awb.mjs metrics` or `GET /api/metrics`. M6 adds Planner-generated validated DAGs, dependency-aware parallel execution, blocked propagation, parent aggregates, and replay-safe graph state. M7-A adds the local Human Bridge briefing/receipt loop and UI review surfaces; M7-B makes process probes truthful and ACP/CLI commands configuration-driven. Remote execution, Tauri packaging, and multi-user collaboration remain deferred. See [workbench/docs/SPEC.md](workbench/docs/SPEC.md) and [workbench/docs/ARCHITECTURE.md](workbench/docs/ARCHITECTURE.md) for the current contract.

## 目录

```
.claude-plugin/marketplace.json   市场清单
plugins/agent-crew/               插件本体
```
