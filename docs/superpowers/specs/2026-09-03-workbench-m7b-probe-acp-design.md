# Workbench M7-B Probe and ACP Design

**Status:** Approved for implementation design review (2026-09-03)

## Goal

Replace optimistic Agent probing with a real, configuration-driven health check and make the ACP adapter executable only when its configured command is actually available, while preserving all shipped M4, M5, M6, and M7-A behavior.

## Scope

### Probe Contract

Every adapter exposes `probe(agentConfig)` and returns a structured result:

```js
{
  ok: boolean,
  status: 'available' | 'unavailable' | 'unknown',
  resolved: string | null,
  version: string | null,
  code: number | null,
  error: string | null,
  checkedAt: number
}
```

- Built-in `echo` and `human-bridge` adapters return `available` without spawning a process.
- Process-backed adapters execute the configured `healthCheck` command, arguments, environment, and cwd through the existing Windows-safe `spawnPlan` path.
- A zero exit code is necessary for availability. When `healthCheck.expect` is present, the combined stdout/stderr must contain that string.
- Missing command, spawn error, timeout, non-zero exit, and expectation mismatch return `unavailable` with a stable error description.
- Probe never receives or persists a user task prompt.

### Registry State

- `AgentRegistry.probe()` stores the full structured result.
- `AgentRegistry.listAll()` reports `available: true` only for `ok === true`; an agent that has not been probed is `available: false` with `probe.status === 'unknown'`.
- `findByCapability()` excludes disabled, unavailable, and unknown agents from automatic routing.
- HTTP `POST /api/agents/probe` returns the structured result map unchanged.

### Configuration Consistency

Probe and execution use the same normalized Agent configuration. The configured `command`, `args`, `env`, `cwd`, and protocol-specific fields are passed to the adapter for both health checks and actual runs. No adapter may silently replace a configured command with a hard-coded vendor executable.

### ACP Adapter

- ACP uses `agentConfig.command` and `agentConfig.args` for process startup.
- If no command is configured, ACP is unavailable rather than assumed available.
- ACP probe defaults to the configured health check or a safe `--version` command for the configured executable.
- ACP run retains the existing JSON-RPC lifecycle, but startup/handshake failures become `run.failed` through the existing terminal event contract.

### Generic CLI Adapter

`cli-text` uses the Agent configuration for command, args, env, and cwd. It no longer invokes a hard-coded Claude command. Prompt substitution remains subject to the existing shell-metacharacter safety rules and stdin/argv protocol configuration.

## Non-Goals

- Extracting a cross-repository `shared/` package.
- Changing sandbox isolation, snapshots, diff/apply/rollback, approval, retry, watchdog, metrics, Planner/DAG, Human Bridge, or UI behavior.
- Adding runtime dependencies, network calls, authentication, remote execution, Tauri packaging, or multi-user support.
- Performing a full ACP protocol redesign; this slice only makes command selection and availability truthful.

## Data Flow

```text
agents/*.json
  -> normalizeConfig / validateConfig
  -> AgentRegistry.probe
  -> adapter.probe(agentConfig)
  -> spawnPlan + health command
  -> structured probe result
  -> listAll / findByCapability / HTTP response
```

For process-backed adapters, probe execution is bounded by a configured probe timeout (default 4 seconds), kills the probe child on timeout, and always resolves exactly once. Probe processes never run inside a task sandbox because they only inspect executable availability.

## Error Handling

- Probe failures are per-Agent and do not prevent valid configuration files from loading.
- Registry preserves the last probe result until the next explicit probe; startup performs one `probeAll()` as today.
- Unknown probe status is never treated as available for dispatch.
- A configured command that resolves to a Windows `.cmd`/`.bat` shim is launched through `cmd.exe /d /s /c` using `spawnPlan`.
- Health output is truncated to a bounded diagnostic length before being returned or logged.

## Testing

Add tests before implementation for:

- Built-in adapter probe results and structured fields.
- Process-backed command success, non-zero exit, missing command, timeout, and `expect` mismatch.
- Windows shim resolution through `spawnPlan`.
- Registry unknown/unavailable/available routing behavior.
- ACP configured command probe and run startup failure.
- Generic CLI configured command usage.
- HTTP probe response shape and repeatability.
- Existing Human Bridge, UI, Planner/DAG, sandbox, approval, retry, watchdog, metrics, replay, and SSE suites remaining green.

## Acceptance Criteria

- No adapter reports `ok: true` solely because its protocol is known.
- No process-backed adapter starts a hard-coded executable when configuration supplies another command.
- A fresh registry never auto-routes an unprobed Agent.
- All tests are deterministic, local, and token-free.
- The complete `node --test` suite and `.mjs` syntax checks pass.

