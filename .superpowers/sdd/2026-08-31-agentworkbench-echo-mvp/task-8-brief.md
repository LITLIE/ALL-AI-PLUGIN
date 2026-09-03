### Task 8: Final Verification and Documentation Update

**Files:**
- Modify: `workbench/docs/SPEC.md`
- Modify: `workbench/docs/ARCHITECTURE.md`
- Modify: `README.md`
- If required for the mandated all-module syntax gate, minimally repair stale ESM parse blockers in `workbench/adapters/claude-stream-json.mjs`, `workbench/adapters/cli-text.mjs`, or `workbench/server/api.mjs`; keep these legacy modules inactive and do not expand runtime scope.

- [ ] **Step 1: Run all static and behavioral checks**

Run:

```text
Get-ChildItem -Recurse -File workbench -Filter *.mjs | ForEach-Object { node --check $_.FullName }
npm test
node awb.mjs agents:list
node awb.mjs audit
```

Expected: all syntax checks and tests pass; `agents:list` shows `echo-test` available; `audit` reports an intact store for the test workspace.

Current preflight evidence: the behavioral suite passes, but the recursive syntax gate currently reports illegal `yield` in two legacy adapters and illegal `await` in the unused legacy `server/api.mjs`. These parse blockers must be corrected minimally before completion.

- [ ] **Step 2: Update docs to match shipped behavior**

Document the single runtime path, the Echo smoke test, the exact store layout, and the explicitly deferred features. Remove claims that are not implemented in this phase.

- [ ] **Step 3: Verify the documented smoke flow manually**

Run the six commands in the design spec with a temporary `AWB_STORE`, then inspect `bus.jsonl` and confirm ordered task/run/verdict events.

- [ ] **Step 4: Record final repository status**

Run: `git status --short`

Expected: the command still reports no Git repository. Report changed files and test output directly to the user; do not claim a commit.
