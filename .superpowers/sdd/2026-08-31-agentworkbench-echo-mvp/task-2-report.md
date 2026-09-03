# Task 2 Report

## Status

Complete. Core utilities and registry are ESM-safe for the focused Task 2 scope.

## Changed Files

- `workbench/core/registry.mjs`
- `workbench/core/utils.mjs`
- `workbench/core/spawn-helper.mjs`
- `workbench/test/registry.test.mjs`
- `.superpowers/sdd/2026-08-31-agentworkbench-echo-mvp/task-2-report.md`

## Test Outcomes

- `node --test test/registry.test.mjs`: PASS, exit 0; 2 tests passed, 0 failed, 0 skipped, duration 262.415 ms.
- `node --check core/registry.mjs`: PASS, exit 0.
- `node --check core/utils.mjs`: PASS, exit 0.
- `node --check core/spawn-helper.mjs`: PASS, exit 0.
- `rg -n "\brequire\s*\(" core/registry.mjs core/utils.mjs core/spawn-helper.mjs`: no matches (exit 1 is ripgrep's expected no-match status).

## Concerns

- Health and syntax of non-echo adapter implementations are outside Task 2. `probeAll()` now records individual adapter load/probe failures instead of aborting the full result map, allowing the echo probe result to be returned.

## Review Fix Round

### Changes

- `AgentRegistry.probe()` now resolves adapters with `loadAdapter(agent.type)` only.
- Restored the original exception boundary: adapter import/load and missing-adapter handling occur before the `adapter.probe()` try/catch.

### Verification

- `node --test test/registry.test.mjs`: BLOCKED, exit 1; 1 test passed and 1 failed. `probeAll()` correctly propagates a syntax error while importing the first configured adapter before reaching echo.
- `node --check core/registry.mjs`: PASS, exit 0.
- `node --check core/utils.mjs`: PASS, exit 0.
- `node --check core/spawn-helper.mjs`: PASS, exit 0.
- Diagnostic `node --check adapters/claude-stream-json.mjs`: FAIL, exit 1 at line 53 with `SyntaxError: Unexpected strict mode reserved word`.
- Diagnostic syntax checks for `adapters/codex-app-server.mjs`, `adapters/human-bridge.mjs`, and `adapters/echo.mjs`: PASS, exit 0.

### Concern

- The focused `probeAll()` test cannot pass with the restored narrow exception boundary until the out-of-scope `claude-stream-json` adapter syntax error is fixed by Task 3.

## Controller Ruling

### Change

- Kept `probe(agentId)` with its narrow exception boundary.
- Added per-agent rejection handling in `probeAll()`: failures are stored in `_probed`, returned in the Agent-ID-keyed results object as `{ ok: false, error }`, and probing continues.

### Verification

- `node --test test/registry.test.mjs`: PASS, exit 0; 2 tests passed, 0 failed, 0 skipped, duration 233.9713 ms.
- `node --check core/registry.mjs`: PASS, exit 0.
- `node --check core/utils.mjs`: PASS, exit 0.
- `node --check core/spawn-helper.mjs`: PASS, exit 0.

### Concern

- `adapters/claude-stream-json.mjs` remains syntax-invalid and out of Task 2 scope. Bulk probing now reports that adapter's failure without preventing the echo probe result.

## Fix Round 2

### Change

- `probeAll()` now stores every normal `probe(id)` result in `_probed` before adding it to the Agent-ID-keyed result object.
- The existing catch path continues to store rejected probe failures.
- Added a behavior-level test confirming a missing-adapter bulk result is reflected by `listAll()` and marks the agent unavailable.

### TDD Evidence

- RED: `node --test test/registry.test.mjs` failed with 2 passed and 1 failed; `listAll()` returned no cached probe (`undefined !== false`).
- GREEN: `node --test test/registry.test.mjs` passed with 3 tests passed, 0 failed, 0 skipped, duration 238.3059 ms.

### Syntax Verification

- `node --check core/registry.mjs`: PASS, exit 0.
- `node --check core/utils.mjs`: PASS, exit 0.
- `node --check core/spawn-helper.mjs`: PASS, exit 0.

### Concern

- No new concern. The known out-of-scope Claude adapter syntax failure remains contained by bulk probing.
