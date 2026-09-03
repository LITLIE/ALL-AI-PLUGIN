# Shared Agent Runtime Kernel Design

**Status:** Approved for implementation planning (2026-09-03)

## Goal

Provide one local, dependency-free runtime kernel for executable resolution, Windows-safe spawning, command template expansion, and structured health probes so `agent-crew` and `workbench` execute the same configured Agent consistently.

## Scope

The first slice extracts only behavior that is duplicated and independently testable:

- PATH and explicit-path executable resolution with Windows `PATHEXT` support.
- `.cmd`/`.bat` shim plans through `cmd.exe /d /s /c` without enabling general shell parsing.
- Safe argument template expansion for `{{prompt}}`, `{{project}}`, `{{cwd}}`, `{{taskId}}`, `{{runId}}`, and role metadata.
- A bounded asynchronous `probeCommand(config, options)` returning the canonical probe result:

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

- Adapters for existing consumers so current `workbench` and `agent-crew` behavior remains source-compatible during migration.

The kernel does not own EventBus persistence, task orchestration, sandboxing, authentication, remote execution, or GUI bridging.

## Design

Create `shared/agent-runtime/` as a small ESM module with no package dependencies:

- `resolve.mjs`: `resolveExecutable(command, options = {})` and `spawnPlan(command, args, options = {})`.
- `templates.mjs`: `substituteArgs(args, vars)` and shell-metacharacter checks used by both callers.
- `probe.mjs`: `probeCommand(agentConfig, options = {})` and `normalizeProbeResult(value, fallback = {})`.
- `index.mjs`: stable public exports.

The shared module reads the current process PATH and platform by default. Tests may inject `pathValue`, `platform`, `pathext`, and `comSpec` through options so Windows behavior is deterministic without mutating global process state. Production callers use defaults.

`spawnPlan` returns the existing compatibility fields (`file`, `args`, `command`, `shell`, `viaShell`, `shimmed`, `resolved`) so current adapters can migrate one import at a time. The plan always uses `shell: false`; only `.cmd` and `.bat` files are routed through the explicit `cmd.exe` argument form.

`probeCommand` accepts normalized Agent configuration. It prefers `healthCheck.command`, `healthCheck.args`, `healthCheck.env`, and `healthCheck.cwd`; it falls back to the Agent command and `['--version']`. It inherits the process environment, bounds output and execution time, kills the child tree on timeout, applies `healthCheck.expect` to combined stdout/stderr, and resolves exactly once.

## Migration

1. Add shared kernel tests that cover POSIX commands, explicit paths, Windows shim plans, template substitution, probe success/failure/timeout/expectation mismatch, and bounded diagnostics.
2. Replace `workbench/core/utils.mjs` resolution with re-exports or a thin compatibility wrapper backed by the shared module.
3. Replace `workbench/core/probe.mjs` implementation with the shared probe while preserving its public exports.
4. Replace `plugins/agent-crew/server/lib/dispatch.mjs` local `resolveExecutable`, `spawnPlan`, and `probeCli` internals with shared calls. Keep its existing synchronous `probeCli` output shape for plugin callers, mapping the canonical result to `reason` and existing fields.
5. Add cross-consumer contract tests proving equivalent command resolution and probe results for the same fixture configuration.
6. Update architecture and configuration documentation; keep all existing orchestration and Human Bridge tests unchanged.

## Compatibility and Safety

- No runtime dependency or network call is introduced.
- Existing import paths remain valid through compatibility wrappers.
- User prompts are never persisted by the shared probe and are only interpolated by execution callers that explicitly request it.
- If a prompt would enter a Windows shim command line with shell metacharacters, callers must use stdin or reject the invocation using the existing safety rule.
- Missing commands, spawn failures, non-zero exits, expectation mismatches, and timeouts are `unavailable`; no protocol type is implicitly considered healthy.

## Acceptance Criteria

- `workbench` and `agent-crew` resolve the same command/configuration to the same executable and shim plan.
- Both consumers use the same structured probe semantics and 4-second default probe timeout.
- Existing `node --test` suites and plugin syntax checks remain green.
- A fixture command can be probed through either consumer without vendor-specific hard-coded executable names.
- No EventBus, Orchestrator, sandbox, approval, retry, watchdog, metrics, Planner/DAG, Human Bridge, UI, or SSE behavior changes.

## Deferred Work

Automatic discovery of installed Agents, editable configuration UI, richer ACP capability negotiation, Git worktree isolation, Tauri packaging, and extraction of the full EventBus/orchestration runtime remain later M8 work.
