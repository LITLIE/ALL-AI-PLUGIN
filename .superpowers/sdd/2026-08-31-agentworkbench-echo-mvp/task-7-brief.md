### Task 7: Align HTTP/SSE With the Same Core Objects

**Files:**
- Modify: `workbench/server/http.mjs`
- Modify: `workbench/server/sse.mjs`
- Modify: `workbench/ui/app.mjs`
- Create: `workbench/test/http-smoke.test.mjs`

**Interfaces:**
- `GET /api/health` returns `{ ok: true }`.
- `GET /api/agents` includes `echo-test` and its probe state.
- `POST /api/tasks` creates a task using the same Orchestrator instance.
- `POST /api/tasks/:id/dispatch` accepts `{ agentId, prompt }` and returns the Run.
- `GET /api/events?since=N` sends only events with `seq > N`, then new events once.

- [ ] **Step 1: Write failing HTTP smoke tests**

Start `startServer({ host: '127.0.0.1', port: 0, agentsDir })`, call health, agents, task creation, and dispatch endpoints, then close the returned server and bus. Assert the Echo completion event is visible through `/api/events?since=0`.

- [ ] **Step 2: Run the focused HTTP test**

Run: `node --test test/http-smoke.test.mjs`

Expected: FAIL on the current `require` usage and stale SSE implementation.

- [ ] **Step 3: Remove stale HTTP API imports and CommonJS calls**

Keep `server/http.mjs` as the only HTTP router. Use `EventBus.readFrom()` for initial SSE replay and a polling cursor or explicit bus event hook for subsequent events; do not mutate a `const` cursor.

- [ ] **Step 4: Update the UI client to current response shapes**

Read task IDs from `taskId`, Run IDs from `runId`, and verdict actions from the unified endpoint. Do not add new screens or visual systems in this phase.

- [ ] **Step 5: Run HTTP and full tests**

Run: `node --test test/http-smoke.test.mjs; npm test`

Expected: PASS.
