# Installed Agent Discovery Design

**Status:** Approved for implementation planning (2026-09-03)

## Goal

Let the local workbench discover installed command-line Agents and known GUI-only Agents, present truthful configuration drafts, and require explicit user confirmation before any Agent becomes routable.

## Scope

M8-B adds a read-only discovery layer plus explicit config import:

- Scan a small, documented catalog of common Agent commands through the shared M8-A runtime kernel.
- Probe discovered commands using the same structured `probeCommand()` contract as registered Agents.
- Optionally inspect caller-provided manifest files, without recursive filesystem crawling.
- Emit GUI-only suggestions for Trae and WorkBuddy as Human Bridge drafts; these are not executable commands.
- Return candidate metadata: `id`, `displayName`, `source`, `command`, `resolved`, `status`, `version`, `confidence`, and `configDraft`.
- Expose read-only `GET /api/agents/discover` and CLI `node awb.mjs agents:discover`.
- Add explicit import of a validated draft through `POST /api/agents/import`; import writes one JSON file, reloads the registry, and leaves the Agent unprobed until the next probe.

Discovery never enables an Agent automatically and never dispatches a task.

## Discovery Sources

The default command catalog is intentionally small and transparent:

| Candidate | Command | Suggested adapter | Default capability hint |
|---|---|---|---|
| Claude Code | `claude` | `claude-stream-json` | `read`, `write`, `analyze`, `test` |
| Codex CLI | `codex` | `codex-app-server` | `read`, `write`, `analyze`, `test` |
| Gemini CLI | `gemini` | `cli-text` | `read`, `analyze` |
| OpenCode | `opencode` | `cli-text` | `read`, `write`, `analyze` |
| GitHub Copilot CLI | `copilot` | `cli-text` | `read`, `analyze` |

The catalog is data, not an implicit execution fallback. A command is a candidate only when it resolves and its health probe succeeds. A caller may pass an explicit catalog or manifest path in tests and future integrations.

GUI-only suggestions use `human-bridge`, `source: known-gui`, `status: available`, and `confidence: advisory`; they contain no command and are never treated as process-backed availability.

## Data Flow

```text
catalog / optional manifests
  -> resolveExecutable + probeCommand
  -> discovery candidates (read-only)
  -> UI / CLI review
  -> explicit POST /api/agents/import
  -> validateConfig + write agents/*.json
  -> registry reload + status unknown until probe
```

## API and CLI

`GET /api/agents/discover` accepts optional query parameters:

- `commands=claude,codex` limits catalog entries.
- `manifest=<absolute-or-contained-file>` inspects one JSON manifest when configured by the caller.

The response is `{ candidates: [...] }`. It contains no prompts, secrets, or task data.

`POST /api/agents/import` accepts one `config` object and optional `fileName`. The server validates the config with the existing schema, rejects path traversal and duplicate IDs, writes a JSON config under the configured agents directory, reloads the registry, and returns the imported Agent with `status: "unknown"` until an explicit probe runs.

`node awb.mjs agents:discover` prints the same candidate metadata as JSON. It is read-only. Import remains an explicit HTTP operation so a UI confirmation or a separate trusted client must choose the draft.

## Safety and Error Handling

- Discovery uses only local PATH and explicitly provided manifest paths; no network calls, package-manager commands, registry scans, or recursive home-directory scans.
- Every process probe is bounded by the shared 4-second timeout and diagnostic output limit.
- Unresolved commands are omitted from executable candidates rather than reported as available.
- Malformed manifests and invalid drafts return structured per-candidate errors and do not block other candidates.
- Imported filenames are restricted to a single `.json` basename and cannot escape the agents directory.
- Imported Agents are disabled only when the draft says so; they remain unroutable while `status: "unknown"`.

## Compatibility

- Existing `AgentRegistry.load`, `probeAll`, routing, adapters, Inline Execution, sandbox, approval, retry, watchdog, metrics, Planner/DAG, Human Bridge, UI, and SSE behavior remain unchanged.
- Discovery reuses `shared/agent-runtime` and does not duplicate executable resolution or probe logic.
- Existing Agent JSON files are never rewritten by discovery.

## Acceptance Criteria

- On a machine with `codex` available, discovery returns one available Codex candidate with the resolved executable and version.
- On a machine without `claude`, discovery does not fabricate an available Claude candidate.
- GUI-only Trae and WorkBuddy drafts are advisory Human Bridge candidates with no command.
- Importing a valid draft creates exactly one config file and leaves it unknown until probing.
- Invalid drafts, duplicate IDs, path traversal, and malformed manifests are rejected without partial writes.
- Existing test suites remain green and new discovery tests are deterministic, local, token-free, and network-free.

## Deferred Work

Automatic catalog updates, vendor-specific manifests, package-manager integration, GUI process detection, automatic enablement, and remote Agent discovery remain deferred.
