# AgentWorkbench Echo MVP Final Fix Report

Date: 2026-09-01
Scope: concentrated final-review fix wave for the active Echo-only MVP.

## Status

Complete. The active runtime now permits only probed Echo agents to execute, persists and replays stable Run state, performs abort-backed interruption, validates reviewer identity before persistence, rejects corrupt JSONL structure, and protects the loopback HTTP/UI boundary. Deferred mutation surfaces either return `501 not_implemented` or were removed.

## RED Evidence

The interrupted test changes were retained as the starting RED baseline.

### Core and replay

Command:

```text
node --test test/orchestrator.test.mjs test/replay.test.mjs test/cli-smoke.test.mjs
```

Result before production fixes: exit 1; 18 tests, 8 passed, 10 failed. Failures showed:

- no persisted `run.created` event;
- non-Echo selection and unavailable Echo dispatch still created Runs;
- no abort signal or interrupted terminal state;
- apply/rollback returned non-501 results;
- interior blanks were skipped and sequence validation used physical lines;
- replay dropped initial Run fields and mapped interrupted tasks to failed;
- CLI persistence still lacked `run.created`.

Separate reviewer command:

```text
node --test test/verdict.test.mjs
```

Result before production fixes: exit 1; 7 tests, 6 passed, 1 failed. Missing, blank, and non-string reviewers were accepted instead of throwing `invalid_reviewer` with status 400.

### HTTP, UI, and CLI boundaries

Command:

```text
node --test test/http-smoke.test.mjs
```

Result before router/UI fixes: exit 1; 5 tests, 2 passed, 3 failed. Observed failures included malformed reviewer HTTP status 500 instead of 400, spoofed Host status 200 instead of 403, and an unsafe task ID breaking out of `data-id` as an `onmouseover` attribute.

Command:

```text
node --test test/cli-smoke.test.mjs
```

Result before CLI pruning: exit 1; 5 tests, 4 passed, 1 failed because `run:rollback` was still advertised.

Targeted task ID mutation check:

```text
node --test --test-name-pattern="HTTP rejects spoofed origins" test/http-smoke.test.mjs
```

Result before the null-ID fix: exit 1; 1 test, 0 passed, 1 failed because `taskId: null` generated a task with HTTP 201 instead of returning 400.

## Implementation Summary

- Restricted capability selection, explicit selection, and direct dispatch to enabled, successfully probed `type: "echo"` configurations before Run creation.
- Added `run.created` persistence with the complete initial Run, event-consistent terminal timestamps/fields, and replay folding that reproduces the stable Run object.
- Added one `AbortController` per active Run, passed its signal to the adapter, invoked adapter interruption with Run context, closed the iterator, persisted `run.interrupted`, and prevented later completion.
- Added structured `invalid_reviewer` validation before verdict events and HTTP status/error mapping.
- Made every interior blank JSONL record invalid, validated logical event sequence continuity, and retained one legal final newline.
- Returned 501 for active apply, rollback, diff, approval, and human-bridge HTTP surfaces; removed rollback from CLI and removed deferred UI controls.
- Removed orphaned legacy alternate API/CLI and approval/reviewer modules that exposed real deferred mutations.
- Added exact Host checks, same-origin mutation validation, task ID generation/validation, static UI containment, URL encoding, and escaped dynamic UI attributes.
- Corrected current SPEC/ARCHITECTURE claims and linked this report from the documented verification section.

## Changed Files

Modified:

- `README.md`
- `workbench/adapters/echo.mjs`
- `workbench/awb.mjs`
- `workbench/core/bus.mjs`
- `workbench/core/orchestrator.mjs`
- `workbench/core/registry.mjs`
- `workbench/docs/ARCHITECTURE.md`
- `workbench/docs/SPEC.md`
- `workbench/server/http.mjs`
- `workbench/test/cli-smoke.test.mjs`
- `workbench/test/http-smoke.test.mjs`
- `workbench/test/orchestrator.test.mjs`
- `workbench/test/replay.test.mjs`
- `workbench/ui/app.mjs`
- `.superpowers/sdd/2026-08-31-agentworkbench-echo-mvp/final-fix-report.md`

Removed as orphaned deferred mutation surfaces:

- `workbench/core/approval.mjs`
- `workbench/core/dispatch.mjs`
- `workbench/core/reviewer.mjs`
- `workbench/server/api.mjs`

The pre-existing `workbench/test/verdict.test.mjs` RED regression was preserved and used unchanged in this continuation.

## GREEN Evidence

Focused results after implementation:

```text
node --test test/orchestrator.test.mjs  -> 6 passed, 0 failed
node --test test/replay.test.mjs        -> 8 passed, 0 failed
node --test test/verdict.test.mjs       -> 7 passed, 0 failed
node --test test/http-smoke.test.mjs    -> 5 passed, 0 failed
node --test test/cli-smoke.test.mjs     -> 5 passed, 0 failed
```

Final behavioral verification from `workbench/`:

```text
npm test
```

Exit 0. TAP summary:

```text
1..36
# tests 36
# pass 36
# fail 0
# duration_ms 5940.6933
```

Final recursive syntax verification from `workbench/`:

```text
Get-ChildItem -Recurse -File -Filter *.mjs | ForEach-Object { node --check $_.FullName }
```

Exit 0; `checked=33`, with no syntax errors.

Final scans found no live imports of the removed legacy API/CLI/reviewer/approval modules and no rollback, approval, diff, or parallel-dispatch controls/claims in the shipped CLI, UI, SPEC, ARCHITECTURE, or README scope.

## Concerns

- `D:\Agentplugin` is not a Git repository, so no commit, Git diff, or Git recovery path is available. The four removed orphaned modules can only be recovered from another workspace copy or external backup.
- Non-Echo configurations and adapter modules intentionally remain visible and probeable for roadmap compatibility. Registry selection, CLI/HTTP explicit selection, and direct Orchestrator dispatch all independently prevent them from executing or creating Runs.
- No real Claude/Codex execution, worktrees, approvals, diff/apply/rollback, human bridge, or other non-coding protocol was implemented.
