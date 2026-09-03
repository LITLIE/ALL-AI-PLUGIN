# Task 4 Report: Event Integrity and Replay

## Status

Implemented fail-closed event-store validation and deterministic orchestrator replay while preserving the existing event shape `{ ts, seq, kind, ...meta, payload }` with `taskId`, `runId`, and `agentId` at the top level.

## RED Evidence

Initial `node --test test/replay.test.mjs` run failed 3/3 tests for the expected missing behavior:

- Integrity report had no accumulated `errors` array (`Cannot read properties of undefined (reading 'map')`).
- `EventBus.init()` accepted a store whose first event had `seq: 2` (`Missing expected rejection`).
- `Orchestrator.replay()` attempted to destructure `ev.meta`, which is absent in the persisted top-level metadata format.

The terminal-state replay test was also observed failing before its folding branches were implemented:

- Expected failed run state `failed`, received the default reconstructed state `running`.

## GREEN Implementation

- `EventBus.readAll()` validates every non-empty JSONL line and throws an error containing line details when JSON or sequence integrity is corrupt.
- `EventBus.integrityCheck()` returns `{ ok, totalLines, errors? }`, accumulating `seq_gap` and `invalid_json` errors in line order.
- `EventBus.init()` derives the append sequence only from a fully validated store and rejects corrupt existing data before opening the append stream.
- `EventBus.readFrom(seq)` retains inclusive `event.seq >= seq` behavior through validated `readAll()`.
- `Orchestrator.replay()` clears task, run, and active-run maps, restores task snapshots, creates each run once from top-level metadata, and folds completed, failed, timeout, and interrupted terminal states.
- Completed runs restore text, cost, and duration when present and place their task in `awaiting-review`.

## Changed Files

- `workbench/core/bus.mjs`
- `workbench/core/orchestrator.mjs`
- `workbench/test/replay.test.mjs`
- `.superpowers/sdd/2026-08-31-agentworkbench-echo-mvp/task-4-report.md`

`workbench/test/helpers.mjs` did not require modification because its existing `storeDir` option already supports replay against an isolated persisted store.

## Verification

- `node --test test/replay.test.mjs` — exit 0, 4 tests passed, 0 failed.
- `node --test test/registry.test.mjs test/bus.test.mjs test/orchestrator.test.mjs test/replay.test.mjs` — exit 0, 11 tests passed, 0 failed.
- `node --check core/bus.mjs` — exit 0.
- `node --check core/orchestrator.mjs` — exit 0.

## Concerns

- Verdict events are intentionally not folded or normalized in this task; Task 5 owns that contract.
- No commit was created, as required.

## Fix Round 1: Physical Line Integrity

### RED Evidence

After adding the interior-blank-line regression, `node --test test/replay.test.mjs` failed 1 of 6 tests for the expected reason:

- `integrity preserves physical line indexes across interior blank lines` expected `report.ok === false`, but the parser returned `true` because `.filter(Boolean)` compressed physical line 3 to logical line 2.

The focused `readFrom(2)` assertion passed immediately, confirming the existing inclusive `event.seq >= seq` contract without requiring a production change.

### GREEN Implementation

- The parser now removes only the final empty split sentinel produced by a trailing newline.
- Interior blank physical lines are skipped for JSON parsing but retain their original indexes for sequence validation and `totalLines`.
- CRLF line endings are handled without treating the trailing `\r` as JSON content.
- Bus comments now describe `seq` as stored data validated against physical line numbers and list optional metadata as top-level event fields.

### Verification

- `node --test test/replay.test.mjs` — exit 0, 6 tests passed, 0 failed.
- `node --test test/registry.test.mjs test/bus.test.mjs test/orchestrator.test.mjs test/replay.test.mjs` — exit 0, 13 tests passed, 0 failed.
- `node --check core/bus.mjs` — exit 0.
- `node --check core/orchestrator.mjs` — exit 0.

## Fix Round 2: Append Sequence After Interior Blank Line

### RED Evidence

The valid-store regression used sequence 1 on physical line 1, a blank physical line 2, and sequence 3 on physical line 3. Before the fix, `node --test test/replay.test.mjs` failed 1 of 7 tests:

- `initialization resumes after the final validated sequence` expected the next appended event to have sequence 4, but initialization seeded `_seq` from the two parsed events and emitted sequence 3.

### GREEN Implementation

- `EventBus.init()` now seeds `_seq` from the final validated event's stored sequence, or zero when the store is empty.
- The regression confirms append writes sequence 4 on physical line 4 and the resulting store remains integrity-clean.

### Verification

- `node --test test/replay.test.mjs` — exit 0, 7 tests passed, 0 failed.
- `node --test test/registry.test.mjs test/bus.test.mjs test/orchestrator.test.mjs test/replay.test.mjs` — exit 0, 14 tests passed, 0 failed.
- `node --check core/bus.mjs` — exit 0.
- `node --check core/orchestrator.mjs` — exit 0.
