# AgentWorkbench Configuration Contract Design

Date: 2026-09-02  
Status: approved

## Goal

Make `workbench/agents/*.json` a validated, configuration-driven contract for the local Agent orchestration runtime. A new Agent that uses an existing adapter type must be addable as JSON only, while malformed configuration fails clearly before probing or dispatch.

## Decisions

- `type` is the canonical adapter field. `adapterId` is accepted as a compatibility alias only when `type` is absent; conflicting values are invalid.
- Risk levels are exactly `read-only`, `workspace-write`, and `high-risk`.
- Capability tags are drawn from a checked-in allow-list shared by the registry and documentation.
- Agent files may contain full-line `//` comments. Parsing must preserve `//` inside JSON strings.
- Invalid files are retained as structured configuration errors and are excluded from `agents`, probing, selection, and dispatch. One invalid file must not prevent valid files from loading.
- Existing public registry methods remain available. `load()` still returns no value; callers inspect `agents` and `errors`, while `listAll()` exposes validation errors for UI/CLI status.

## Validation Contract

Required fields are `id`, `displayName`, `type`, `outputProtocol`, `riskLevel`, and `capabilityTags`. `id` must be a non-empty lowercase identifier using letters, digits, and `-`; `capabilityTags` must be a non-empty array of known strings; `riskLevel` must be canonical; `type` must resolve to a registered adapter. Optional command, args, env, healthCheck, timeout, retry, and bridge fields keep their existing semantics.

The normalizer produces a new object and never mutates parsed input. It sets `type` from `adapterId` when needed and sets `enabled` to `true` unless explicitly `false`. Validation errors contain `code`, `file`, `field`, and a human-readable `message`.

## Compatibility and Migration

The four shipped configurations migrate `low`/`medium` to canonical values. `AgentRegistry` accepts legacy `adapterId` for external configs, but newly written files and documentation use `type`. No automatic risk conversion is applied because risk changes are security-sensitive.

## Testing

Tests cover comment parsing with URLs and Windows paths, alias normalization and conflict rejection, unknown capability/risk/type rejection, invalid-file isolation, disabled agents, and a temporary JSON-only `cli-text` Agent that probes and dispatches through existing code. The full suite must remain dependency-free and pass without network access.
