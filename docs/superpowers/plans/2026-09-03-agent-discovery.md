# Installed Agent Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Discover locally installed Agent CLIs and GUI-only suggestions without auto-enabling them, then support explicit validated import of configuration drafts.

**Architecture:** Add a read-only discovery module under `shared/agent-runtime/` that uses the M8-A resolver and probe kernel. Expose discovery through HTTP and CLI, and add a narrow registry import method that validates a draft, writes one safe JSON basename, reloads state, and leaves the imported Agent unknown until probing.

**Tech Stack:** Node.js ESM, built-in `node:fs`, `node:path`, `node:test`; zero runtime dependencies, no network calls.

**Spec:** `docs/superpowers/specs/2026-09-03-agent-discovery-design.md`

## Global Constraints

- Discovery is read-only and never dispatches tasks or auto-enables candidates.
- Use only explicit PATH/catalog/manifest inputs; do not crawl home directories or run package managers.
- Reuse `shared/agent-runtime/resolve.mjs` and `shared/agent-runtime/probe.mjs`; do not duplicate probe logic.
- Imported files must be a single `.json` basename inside the configured agents directory.
- Imported Agents are unknown and unroutable until an explicit probe succeeds.
- Preserve existing EventBus, Orchestrator, adapters, Inline Execution, sandbox, approval, retry, watchdog, metrics, Planner/DAG, Human Bridge, UI, and SSE behavior.
- Use `apply_patch`; no dependencies, network calls, Git initialization, commit, or push.

---

### Task 1: Implement the shared Agent discovery module

**Files:**
- Create: `shared/agent-runtime/discovery.mjs`
- Test: `shared/agent-runtime/test/discovery.test.mjs`
- Modify: `shared/agent-runtime/index.mjs`

**Interfaces:**
- `DEFAULT_CATALOG`: catalog entries for `claude`, `codex`, `gemini`, `opencode`, and `copilot`.
- `discoverAgents(options = {}) -> Promise<{candidates: Array}>`
- `buildConfigDraft(candidate, overrides = {}) -> object`

- [x] **Step 1: Write failing discovery tests**

Create temporary executable fixtures and inject a catalog with `process.execPath`. Assert an available candidate contains `source: "path"`, resolved executable, version, confidence `high`, and a valid `configDraft`. Assert a missing command is omitted from executable candidates. Assert GUI suggestions for `trae` and `workbuddy` contain `type: "human-bridge"`, `source: "known-gui"`, `status: "available"`, `confidence: "advisory"`, and no command. Assert an explicit manifest object can produce a candidate without recursive scanning.

- [x] **Step 2: Run the focused tests and confirm they fail**

Run: `node --test shared/agent-runtime/test/discovery.test.mjs`

Expected: FAIL because `discovery.mjs` does not exist.

- [x] **Step 3: Implement catalog probing and draft generation**

For each catalog item, call shared `probeCommand({ command, healthCheck: { command, args } })`. Include only successful executable probes, normalize candidate IDs to lowercase kebab case, attach `source`, `confidence`, and suggested adapter/capabilities, and generate a draft with `enabled: true`, the discovered command, health check, and empty environment. Add GUI-only drafts separately with `enabled: true` and no command. Accept `options.catalog`, `options.commands`, `options.manifests`, and shared probe options for deterministic tests.

- [x] **Step 4: Run the focused tests and verify they pass**

Run: `node --test shared/agent-runtime/test/discovery.test.mjs`

Expected: PASS.

### Task 2: Add safe explicit Agent config import to the registry

**Files:**
- Modify: `workbench/core/registry.mjs`
- Test: `workbench/test/registry-import.test.mjs`

**Interfaces:**
- `AgentRegistry.importConfig(config, fileName = undefined) -> object`

- [x] **Step 1: Write failing import tests**

Assert a valid draft writes exactly one JSON file, validates through the existing schema, reloads the registry, and reports `status: "unknown"` and `available: false` until probing. Assert duplicate IDs, invalid configs, path traversal (`../escape.json`), non-JSON names, and write failures do not leave partial files or mutate the in-memory registry.

- [x] **Step 2: Run the focused tests and confirm they fail**

Run: `node --test workbench/test/registry-import.test.mjs`

Expected: FAIL because `importConfig()` does not exist.

- [x] **Step 3: Implement validated atomic import**

Validate and normalize the draft before writing. Resolve the target filename to a basename under `agentsDir`, require a `.json` extension, reject existing IDs and existing target files, write JSON to a temporary sibling file, rename it into place, call `load()`, and return the imported config plus unknown probe state. On any error remove only the temporary file and leave existing files untouched.

- [x] **Step 4: Run registry and routing regressions**

Run: `node --test workbench/test/registry-import.test.mjs workbench/test/registry-probe-state.test.mjs workbench/test/registry.test.mjs workbench/test/orchestrator.test.mjs`

Expected: PASS.

### Task 3: Expose discovery and import through HTTP

**Files:**
- Modify: `workbench/server/http.mjs`
- Test: `workbench/test/http-discovery.test.mjs`

**Interfaces:**
- `GET /api/agents/discover -> { candidates: [...] }`
- `POST /api/agents/import` with `{ config, fileName? } -> imported Agent`

- [x] **Step 1: Write failing HTTP tests**

Start the loopback server with a temporary agents directory. Assert `GET /api/agents/discover` returns candidates and does not change `GET /api/agents`. Assert a valid import returns 201, creates the file, and the imported Agent is unavailable/unknown until `POST /api/agents/probe`. Assert malformed bodies, duplicate IDs, path traversal, and invalid origins return errors without writes.

- [x] **Step 2: Run the focused HTTP tests and confirm they fail**

Run: `node --test workbench/test/http-discovery.test.mjs`

Expected: FAIL because the routes do not exist.

- [x] **Step 3: Implement loopback routes**

Add the discovery GET route before task routes, pass only validated query command filters to `discoverAgents()`, and return `{ candidates }`. Add the import POST route with JSON body validation, call `registry.importConfig()`, and return the resulting Agent with status unknown. Keep existing host/origin checks and error serialization unchanged.

- [x] **Step 4: Run HTTP boundary regressions**

Run: `node --test workbench/test/http-discovery.test.mjs workbench/test/http-probe.test.mjs workbench/test/http-smoke.test.mjs`

Expected: PASS.

### Task 4: Add the read-only discovery CLI command

**Files:**
- Modify: `workbench/awb.mjs`
- Modify: `workbench/package.json`
- Test: `workbench/test/cli-discovery.test.mjs`

**Interfaces:**
- CLI command: `node awb.mjs agents:discover [--commands claude,codex]`
- Output: JSON `{ candidates: [...] }` with no prompt or task data.

- [x] **Step 1: Write failing CLI tests**

Run the CLI with an injected temporary catalog/fixture environment and assert `agents:discover` exits zero, emits parseable candidate JSON, and does not create an Agent config file. Assert `--help` lists the command and existing `agents:list`/`agents:probe` output remains compatible.

- [x] **Step 2: Run the focused tests and confirm they fail**

Run: `node --test workbench/test/cli-discovery.test.mjs`

Expected: FAIL because the command is not registered.

- [x] **Step 3: Implement CLI parsing and output**

Register `agents:discover` as a probe-free runtime command, parse the optional comma-separated command filter, call `discoverAgents()`, and print only the JSON result. Do not add an automatic import flag; imports remain explicit through the HTTP endpoint.

- [x] **Step 4: Run CLI regressions**

Run: `node --test workbench/test/cli-discovery.test.mjs workbench/test/cli-smoke.test.mjs`

Expected: PASS.

### Task 5: Document M8-B and complete verification

**Files:**
- Modify: `workbench/docs/ARCHITECTURE.md`
- Modify: `workbench/docs/SPEC.md`
- Modify: `workbench/agents/README.md`
- Modify: `README.md`
- Modify: `docs/assessment/2026-09-02-项目成熟度评估与改进路线.md`
- Test: `workbench/test/docs-m8b-contract.test.mjs`

**Interfaces:**
- Documentation describes `GET /api/agents/discover`, `POST /api/agents/import`, `agents:discover`, candidate confidence/source, and explicit import semantics.
- M8-B is marked complete; automatic enablement and vendor-specific discovery remain deferred.

- [x] **Step 1: Write failing documentation tests**

Assert the relevant documents mention read-only discovery, explicit import, `source`, `confidence`, and that unknown imported Agents are not routable. Assert the assessment marks M8-B complete without claiming recursive installation scanning.

- [x] **Step 2: Run the focused docs test and confirm it fails**

Run: `node --test workbench/test/docs-m8b-contract.test.mjs`

Expected: FAIL because the new discovery contract is not documented.

- [x] **Step 3: Update documentation**

Add configuration examples and command/API descriptions while preserving all existing run flows. Clarify that discovery is local, bounded, read-only, and no prompt/task data is collected.

- [x] **Step 4: Run complete verification**

Run: `node --test`

Expected: all existing M7-A/M7-B/M8-A tests plus M8-B tests pass.

Run: `$files = Get-ChildItem -Recurse -Filter *.mjs | Where-Object { $_.FullName -notmatch '\\\\node_modules\\\\' }; $failed = @(); foreach ($f in $files) { node --check $f.FullName 2>$null; if ($LASTEXITCODE -ne 0) { $failed += $f.FullName } }; "checked=$($files.Count) failed=$($failed.Count)"; $failed`

Expected: `failed=0`.

- [x] **Step 5: Run local discovery/import smoke**

Start the server on a free loopback port, call `GET /api/agents/discover`, import one fixture draft through `POST /api/agents/import`, then call `POST /api/agents/probe`. Verify the imported Agent is unknown before probing and available after a successful fixture probe. Do not use network access or real Agent credentials.

No Git commit or push is included because this workspace has no Git metadata.
