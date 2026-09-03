# Shared Agent Runtime Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make `agent-crew` and `workbench` share one dependency-free implementation for executable resolution, Windows-safe spawn plans, argument templates, and structured health probes.

**Architecture:** Add a focused ESM kernel under `shared/agent-runtime/` with injectable platform/PATH options for deterministic tests. Keep existing consumer import paths through thin compatibility wrappers, then migrate `workbench` and `agent-crew` incrementally without changing EventBus, orchestration, sandbox, approval, retry, watchdog, metrics, Planner/DAG, Human Bridge, UI, or SSE behavior.

**Tech Stack:** Node.js ESM, built-in `node:child_process`, `node:fs`, `node:path`, `node:test`; zero runtime dependencies and no network calls.

**Spec:** `docs/superpowers/specs/2026-09-03-agent-runtime-kernel-design.md`

## Global Constraints

- Keep `shell: false`; only Windows `.cmd`/`.bat` shims use explicit `cmd.exe /d /s /c` routing.
- Preserve existing `workbench/core/utils.mjs` and `workbench/core/probe.mjs` exports.
- Preserve `agent-crew` `probeCli()` return fields and synchronous behavior for existing plugin callers.
- Use the canonical probe fields `{ok,status,resolved,version,code,error,checkedAt}` in the shared layer.
- Use a 4-second default probe timeout and bounded diagnostic output.
- Do not persist prompts in the probe layer or add dependencies, network calls, Git metadata, or remote execution.
- Use `apply_patch` for edits and run tests after each task.

---

### Task 1: Add the shared executable resolution and template kernel

**Files:**
- Create: `shared/agent-runtime/resolve.mjs`
- Create: `shared/agent-runtime/templates.mjs`
- Create: `shared/agent-runtime/index.mjs`
- Test: `shared/agent-runtime/test/resolve.test.mjs`

**Interfaces:**
- `resolveExecutable(command, options = {}) -> string | null`
- `spawnPlan(command, args = [], options = {}) -> {file,args,command,shell,viaShell,shimmed,resolved}`
- `substituteArgs(args, vars) -> string[]`
- `hasShellMetachars(value) -> boolean`

- [ ] **Step 1: Write failing resolution and template tests**

```js
test('resolves explicit executable paths and bare commands from an injected PATH', () => {
  const resolved = resolveExecutable('fixture', { platform: 'linux', pathValue: fixtureDir });
  assert.equal(resolved, join(fixtureDir, 'fixture'));
});

test('routes Windows cmd shims through cmd.exe without enabling a shell', () => {
  const plan = spawnPlan('fixture', ['--version'], {
    platform: 'win32', pathValue: fixtureDir, pathext: '.COM;.EXE;.BAT;.CMD', comSpec: 'C:\\\\Windows\\\\System32\\\\cmd.exe',
  });
  assert.equal(plan.viaShell, true);
  assert.equal(plan.shell, false);
  assert.equal(plan.file.toLowerCase().endsWith('cmd.exe'), true);
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c']);
});

test('substitutes known variables and preserves unknown placeholders', () => {
  assert.deepEqual(substituteArgs(['-C', '{{project}}', '{{prompt}}', '{{unknown}}'], { project: 'D:\\repo', prompt: 'hello' }), ['-C', 'D:\\repo', 'hello', '{{unknown}}']);
});
```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run: `node --test shared/agent-runtime/test/resolve.test.mjs`

Expected: FAIL because the shared modules do not exist.

- [ ] **Step 3: Implement resolution, shim routing, and template substitution**

Move the proven `findInPath` behavior into `resolve.mjs`. Use injected options when provided and process defaults otherwise. Treat `.cmd` and `.bat` as shimmed only on Windows, return the compatibility aliases, and replace only `{{word}}` placeholders while leaving unknown keys unchanged. Keep `shell: false` in every returned plan.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `node --test shared/agent-runtime/test/resolve.test.mjs`

Expected: PASS.

### Task 2: Add the shared structured probe implementation

**Files:**
- Create: `shared/agent-runtime/probe.mjs`
- Test: `shared/agent-runtime/test/probe.test.mjs`
- Modify: `shared/agent-runtime/index.mjs`

**Interfaces:**
- `probeCommand(agentConfig = {}, options = {}) -> Promise<{ok,status,resolved,version,code,error,checkedAt}>`
- `normalizeProbeResult(value, fallback = {}) -> {ok,status,resolved,version,code,error,checkedAt}`
- `PROBE_DEFAULTS -> {timeoutMs: 4000, outputLimit: 4096}`

- [ ] **Step 1: Write failing probe tests**

Cover a successful `process.execPath` health command, non-zero exit, missing command, `healthCheck.expect` mismatch, timeout under 500 ms, bounded 20,000-character output, environment/cwd forwarding, and normalization of a partial legacy result.

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run: `node --test shared/agent-runtime/test/probe.test.mjs`

Expected: FAIL because the shared probe module does not exist.

- [ ] **Step 3: Implement the bounded probe**

Use shared `spawnPlan`, `spawn(..., {shell:false})`, inherited plus configured environment, configured health command/args/cwd, exactly-once resolution, bounded combined stdout/stderr, timeout process-tree termination, and expectation matching. Return `unavailable` for all launch and command failures and include a numeric `checkedAt`.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `node --test shared/agent-runtime/test/probe.test.mjs`

Expected: PASS.

### Task 3: Migrate Workbench to the shared kernel

**Files:**
- Modify: `workbench/core/utils.mjs`
- Modify: `workbench/core/probe.mjs`
- Test: `workbench/test/shared-kernel-compat.test.mjs`

**Interfaces:**
- Existing `workbench/core/utils.mjs` exports continue to resolve unchanged.
- Existing `workbench/core/probe.mjs` exports delegate to `shared/agent-runtime`.

- [ ] **Step 1: Write compatibility tests before migration**

Assert that Workbench `spawnPlan('node', ['--version'])` retains `file`, `args`, `command`, `shell`, `viaShell`, `shimmed`, and `resolved`, and that Workbench `probeCommand()` returns the canonical seven fields. Assert an existing Claude fixture still launches through its configured command.

- [ ] **Step 2: Run the compatibility tests**

Run: `node --test workbench/test/shared-kernel-compat.test.mjs workbench/test/probe.test.mjs`

Expected: The new shared-kernel compatibility test fails before migration; existing Workbench probe tests remain green.

- [ ] **Step 3: Replace duplicated implementations with wrappers**

Import `spawnPlan`, `findInPath`/resolution helpers, and `killProcessTree` without altering unrelated utility exports. Replace the body of `workbench/core/probe.mjs` with re-exports of the shared probe and defaults. Keep existing callers and test paths stable.

- [ ] **Step 4: Run Workbench adapter and lifecycle regressions**

Run: `node --test workbench/test/shared-kernel-compat.test.mjs workbench/test/probe.test.mjs workbench/test/adapter-probe-contract.test.mjs workbench/test/adapter-config.test.mjs workbench/test/adapter-termination.test.mjs`

Expected: PASS with no lifecycle behavior changes.

### Task 4: Migrate Agent Crew while preserving its public plugin contract

**Files:**
- Modify: `plugins/agent-crew/server/lib/dispatch.mjs`
- Test: `plugins/agent-crew/test/shared-kernel-compat.test.mjs`

**Interfaces:**
- Existing `probeCli(role)` remains synchronous and returns `ok`, `command`, `resolved`, `version`, and `reason`.
- Existing `runCliRole()` keeps its shell-metacharacter rejection, stdin behavior, logs, event shape, and timeout semantics.

- [ ] **Step 1: Write failing cross-consumer tests**

Use a local fixture command and compare Workbench `spawnPlan` with Agent Crew's migrated plan for the same command and args. Call `probeCli()` for a configured CLI role and assert its `resolved`, version, and failure reason derive from the shared probe semantics. Assert missing commands remain a synchronous failure result.

- [ ] **Step 2: Run the focused plugin tests and confirm the cross-consumer assertion fails**

Run: `node --test plugins/agent-crew/test/shared-kernel-compat.test.mjs`

Expected: FAIL because Agent Crew still has private resolution, spawn-plan, and probe code.

- [ ] **Step 3: Replace private resolution and probe internals**

Import the shared `resolveExecutable`, `spawnPlan`, and `probeCommand`. Keep `probeCli()` synchronous by using the existing child-process sync call with the shared plan, or add a small shared synchronous probe helper only if the compatibility test demonstrates it is necessary. Preserve `reason` wording and existing log/event metadata. Do not migrate unrelated dispatch or bus code.

- [ ] **Step 4: Run plugin regression and syntax checks**

Run: `node --test plugins/agent-crew/test/shared-kernel-compat.test.mjs`

Then run: `$files = Get-ChildItem -Recurse -Filter *.mjs | Where-Object { $_.FullName -notmatch '\\\\node_modules\\\\' }; $failed = @(); foreach ($f in $files) { node --check $f.FullName 2>$null; if ($LASTEXITCODE -ne 0) { $failed += $f.FullName } }; "checked=$($files.Count) failed=$($failed.Count)"; $failed`

Expected: focused tests PASS and syntax output reports `failed=0`.

### Task 5: Add cross-consumer documentation and complete verification

**Files:**
- Modify: `workbench/docs/ARCHITECTURE.md`
- Modify: `workbench/docs/SPEC.md`
- Modify: `plugins/agent-crew/README.md`
- Modify: `docs/assessment/2026-09-02-项目成熟度评估与改进路线.md`
- Test: `workbench/test/docs-m8a-contract.test.mjs`

**Interfaces:**
- Documentation identifies `shared/agent-runtime` as the source of truth for executable resolution and probes.
- M8-A is marked complete; automatic discovery and full runtime unification remain deferred.

- [ ] **Step 1: Write failing documentation contract tests**

Assert that the four documents mention the shared runtime kernel, configuration-driven command resolution, Windows shim behavior, and preserved `probeCli`/Workbench compatibility. Assert the assessment marks M8-A complete without claiming full EventBus extraction.

- [ ] **Step 2: Run the focused docs test and confirm it fails**

Run: `node --test workbench/test/docs-m8a-contract.test.mjs`

Expected: FAIL because the migration is not documented.

- [ ] **Step 3: Update the documentation**

Describe the shared module path, public functions, consumer wrappers, and deferred work. Update status and roadmap wording without changing user-facing run commands.

- [ ] **Step 4: Run the complete verification suite**

Run: `node --test`

Expected: all tests pass, including M7-B and M8-A tests.

Run the `.mjs` syntax check from Task 4 again and verify `failed=0`.

- [ ] **Step 5: Run a local cross-consumer smoke test**

Probe the same `process.execPath` fixture through Workbench `probeCommand()` and Agent Crew `probeCli()` using a temporary role/config. Assert both resolve the same executable and report success without network access or token use.

No Git commit or push is included because this workspace has no Git metadata.
