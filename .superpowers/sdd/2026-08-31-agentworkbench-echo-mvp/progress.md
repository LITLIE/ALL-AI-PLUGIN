# SDD ledger — plan: docs/superpowers/plans/2026-08-31-agentworkbench-echo-mvp.md

## Setup

- Git worktree: unavailable; `D:\Agentplugin` has no `.git`. Current workspace retained with user approval from the plan scope.
- Spec: `docs/superpowers/specs/2026-08-31-agentworkbench-echo-mvp-design.md` is reachable and is the authority.
- Preflight: all plan tasks are scoped to the Echo MVP; no external network, install, delete, push, or publish action is required.

## Preflight Scan

| Scope | Shared files/interfaces | Finding | Ruling |
|---|---|---|---|
| Task 1 -> Task 2 | `registry.mjs`, `utils.mjs`, test harness | Task 1 establishes failing tests; Task 2 fixes ESM boundaries. | Compatible; preserve exported names. |
| Task 1 -> Task 3 | `test/helpers.mjs` | Task 3 consumes helpers introduced in Task 1. | Task 1 must export `createRuntime` and `completedEchoRuntime` contracts. |
| Task 2 -> Task 3 | `AgentRegistry`, `loadAdapter` inputs | Registry returns full config; adapter loader consumes config. | Use `agent.type` as adapter key, never Agent ID. |
| Task 3 -> Task 4 | `EventBus` event shape, `Orchestrator.replay` | Task 4 folds the events Task 3 emits. | Keep `{ts, seq, kind, meta, payload}` and event `payload.type`. |
| Task 3 -> Task 5 | Run terminal state and `agentId` | Verdict checks maker identity after Echo completion. | Preserve `run.agentId`, `run.taskId`, and `awaiting-review`. |
| Task 4 -> Task 6 | Replay and store location | CLI must replay the same bus it writes. | Centralize runtime construction and `AWB_STORE` handling. |
| Task 3/4 -> Task 7 | Orchestrator events and `EventBus.readFrom` | HTTP/SSE exposes live state and replay. | HTTP owns one runtime; SSE cursor is mutable and monotonic. |
| Task 6 -> Task 8 | CLI commands and docs | Final docs must match the shipped command behavior. | Remove claims of deferred features from phase-specific docs. |

| Task | Internal consistency | Ruling |
|---|---|---|
| 1 | Tests use filesystem string paths and helper exports. | Compatible after plan correction. |
| 2 | Export names remain stable while imports become ESM-safe. | Compatible. |
| 3 | Adapter, dispatch, and wait contracts align. | Compatible; one persisted event per yielded Echo event. |
| 4 | Integrity and replay consume the same event format. | Compatible. |
| 5 | Verdict states match the spec (`passed`, `rejected`, `rework`). | Compatible. |
| 6 | CLI waits for terminal Echo event before closing bus. | Compatible. |
| 7 | HTTP routes use class runtime; stale function API is not used. | Compatible. |
| 8 | Verification commands are available without external dependencies. | Compatible. |

No preflight conflicts require a plan change.

Task 1: implementer DONE; review pending (no Git commit available).
Task 1: complete (no Git commit available, review PASS; deferred minor: clean temporary test directories).
Task 2: implementer complete; review pending (no Git commit available).
Task 2: Ruling: keep `agent.type` adapter lookup because the task's explicit test requires "type is resolved" and `echo-test` cannot pass when lookup uses Agent ID; remove the unrequested `adapterId` fallback. Cost if wrong: Task 3 may need to revise this lookup while adopting the full config contract.
Task 2: fix round 1/5 requested (remove `adapterId` fallback; restore narrow probe exception boundary).
Task 2: Ruling: isolate failures in `probeAll()` rather than `probe()`, because the explicit ID-keyed bulk result contract and Echo probe test are otherwise impossible while another configured adapter has a syntax error. Cost if wrong: callers expecting `probeAll()` to reject on the first bad Agent will instead receive a complete health map.
Task 2: fix round 1/5 (2 prior findings addressed, 1 open: normal missing-adapter result not stored).
Task 2: fix round 2/5 requested (store every resolved `probeAll()` result in `_probed`).
Task 2: fix round 2/5 (1 addressed, 0 open; no Git commit available).
Task 2: complete (no Git commit available, review clean after 2 fix rounds).
Task 3: implementer complete; review pending (no Git commit available).
Task 3: fix round 1/5 requested (ensure adapter load errors and nonterminal stream completion resolve `waitForRun()` with failed terminal state).
Task 3: fix round 1/5 (1 addressed, 0 open; no Git commit available).
Task 3: complete (no Git commit available, review clean after 1 fix round).
Task 4: implementer complete; review pending (no Git commit available).
Task 4: Ruling: sequence validation follows physical file line numbers for non-empty records; only the final newline is ignorable. Interior blank lines therefore make following stored seq values inconsistent. Cost if wrong: manually formatted JSONL with intentional blank separators will be rejected as corrupt.
Task 4: fix round 1/5 requested (preserve physical line indexes, update comments, add blank-line and inclusive readFrom regressions).
Task 4: fix round 1/5 (3 addressed, 1 open: init cursor uses event count instead of last validated seq).
Task 4: fix round 2/5 requested (derive append cursor from final validated event seq and test append after legal interior blank line).
Task 4: fix round 2/5 (1 addressed, 0 open; no Git commit available).
Task 4: complete (no Git commit available, review clean after 2 fix rounds).
Task 5: implementer complete; review pending (no Git commit available).
Task 5: complete (no Git commit available, review approved; deferred minors: denied-only replay assertion, append-failure atomicity test, rejected/rework event assertions).
Task 6: implementer complete; review pending (no Git commit available).
Task 6: fix round 1/5 requested (close bus if runtime initialization fails; make Echo availability assertion exact; test corrupt audit exit).
Task 6: fix round 1/5 (3 addressed, 0 open; no Git commit available).
Task 6: complete (no Git commit available, review clean after 1 fix round).
Task 7: implementer changes present; initial review found loopback binding, SSE since>0 coverage, temp cleanup, and browser UI safety gaps.
Task 7: fix round 1/5 (4 addressed, 0 open; no Git commit available).
Task 7: complete (no Git commit available, review clean after 1 fix round).
Task 8: implementer complete; recursive syntax gate, behavioral tests, CLI smoke, audit, and finite Echo flow verified; docs aligned and legacy syntax blockers minimally repaired.
Task 8: complete (no Git commit available, verification report recorded).
Final review: Critical/Important findings accepted for one concentrated fix wave: non-Echo adapters active, host/CORS security, anonymous reviewer, blank-line integrity, incomplete Run replay, interruption race, deferred APIs/UI exposed, and task/static path safety.
Ruling: the final review's strict continuous-sequence requirement supersedes the earlier interior-blank-line ruling because the spec's binding contract says seq must be continuous; interior blank records will now be corruption. Cost if wrong: manually separated JSONL with blank lines will require cleanup before audit/replay.
Final fix wave: implementation complete; independent verification `npm test` 36/36 and recursive syntax check 33/33 passed.
Final re-review: all load-bearing findings addressed; residual observations are UI refresh omission for run.interrupted, unprobed-agent selection metadata, and future adapter interrupt-hook robustness.
Ruling: park UI interruption refresh as a minor residual because backend state/event persistence is correct and SSE reconnect or manual reload refreshes the task; adding a dedicated UI event branch is follow-up polish, not a blocker for the Echo core acceptance path. Cost if wrong: users may see stale running status briefly after interrupt.
Ruling: park unprobed-agent selection as a minor residual because every shipped CLI/HTTP runtime probes before selection and direct dispatch rejects unprobed agents before Run creation. Cost if wrong: callers constructing an unprobed registry directly may receive a candidate that later fails dispatch.
Ruling: park adapter interrupt-hook ordering as a future-adapter residual because only the deterministic Echo adapter is executable in this MVP and its hook is immediate; the next real-adapter phase must persist interruption before awaiting untrusted hooks. Cost if wrong: a future adapter with a hanging interrupt hook could delay HTTP response or audit persistence.
Plan complete: final verification passed; local server verified at http://127.0.0.1:7788/api/health.
