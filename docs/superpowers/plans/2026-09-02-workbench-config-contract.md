# AgentWorkbench Configuration Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate and normalize Agent JSON configuration so existing adapter types can be added without core code changes.

**Architecture:** A small config module owns the allow-lists, comment-safe parser, normalization, and validation. `AgentRegistry` consumes that module, isolates invalid files as structured errors, and exposes valid configurations unchanged to existing adapters and orchestrator code.

**Tech Stack:** Node.js 22 ESM, built-in `node:test`, JSON configuration, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-02-workbench-config-contract-design.md`

## Global Constraints

- Risk levels are exactly `read-only`, `workspace-write`, and `high-risk`.
- `type` is canonical; `adapterId` is a compatibility alias only when `type` is absent.
- Full-line `//` comments are supported without removing `//` inside JSON strings.
- Invalid Agent files do not block valid files from loading and cannot be probed or dispatched.
- No runtime dependencies, no network requirement, and no changes to EventBus or adapter execution protocols.

---

### Task 1: Add Shared Configuration Vocabulary and Parser

**Files:**
- Create: `workbench/config/capabilities.json`
- Create: `workbench/config/schema.mjs`
- Test: `workbench/test/config-schema.test.mjs`

**Interfaces:**
- `RISK_LEVELS`: frozen set/array of `read-only`, `workspace-write`, `high-risk`.
- `CAPABILITY_TAGS`: loaded allow-list containing `read`, `write`, `refactor`, `analyze`, `test`, `review`, `design`.
- `parseConfigText(source, file)`: parses JSON with full-line comments and throws a structured error without altering string contents.
- `normalizeConfig(raw, file)`: returns a copied config with canonical `type` and default `enabled`.
- `validateConfig(config, file)`: returns `{ ok: true, config }` or `{ ok: false, errors }`.

- [ ] **Step 1: Write failing tests** for URL/path comment preservation, canonical risk values, alias normalization, conflicting `type`/`adapterId`, unknown capability, and unknown risk.
- [ ] **Step 2: Run** `node --test test\config-schema.test.mjs` and confirm failures are caused by missing config module behavior.
- [ ] **Step 3: Implement** the allow-list and a character-by-character comment stripper that recognizes `//` only outside quoted strings, then implement normalization and validation.
- [ ] **Step 4: Run** the focused test and confirm all schema cases pass.

### Task 2: Integrate Registry Validation and Error Isolation

**Files:**
- Modify: `workbench/core/registry.mjs`
- Modify: `workbench/test/registry.test.mjs`

**Interfaces:**
- `registry.errors`: array of `{ code, file, field, message }` for invalid files.
- `listAll()` includes `configError` when an invalid file shares the listing surface; invalid entries are not listed as available.
- Valid entries continue through `probe`, `probeAll`, `findByCapability`, and `upsert` validation.

- [ ] **Step 1: Write failing tests** for invalid-file isolation, structured error fields, disabled config exclusion, and rejecting invalid `upsert()` values.
- [ ] **Step 2: Run** `node --test test\registry.test.mjs` and confirm expected failures.
- [ ] **Step 3: Implement** per-file parsing/validation, reset errors on load, preserve valid entries, and make `upsert()` normalize/validate before mutation.
- [ ] **Step 4: Run** registry and config tests together.

### Task 3: Migrate Shipped Configs and User Documentation

**Files:**
- Modify: `workbench/agents/claude-stream.json`
- Modify: `workbench/agents/codex-appserver.json`
- Modify: `workbench/agents/trae-solo-bridge.json`
- Modify: `workbench/agents/README.md`
- Modify: `workbench/ui/app.mjs`
- Test: `workbench/test/cli-smoke.test.mjs`

- [ ] **Step 1: Add a failing assertion** that all shipped configs load without validation errors and expose only canonical risk values.
- [ ] **Step 2: Run** the focused config/CLI tests and confirm the current `low`/`medium` values fail.
- [ ] **Step 3: Migrate** Claude/Codex/Trae to canonical risk values, document the vocabulary and `adapterId` compatibility, and update UI risk styling for the canonical names.
- [ ] **Step 4: Run** CLI, registry, and UI browser-safety tests.

### Task 4: JSON-Only Agent Regression and Full Verification

**Files:**
- Modify: `workbench/test/adapter-config.test.mjs`
- Modify: `workbench/docs/SPEC.md`
- Modify: `workbench/docs/ARCHITECTURE.md`
- Modify: `D:\Agentplugin\README.md`

- [ ] **Step 1: Add** a temporary JSON-only Agent using an existing adapter and assert probe/dispatch use its configured command and environment.
- [ ] **Step 2: Run** the focused regression and confirm it passes without adding adapter code.
- [ ] **Step 3: Document** schema validation, canonical risks, capability vocabulary, and invalid-config behavior.
- [ ] **Step 4: Run** `node --test` and syntax-check every `.mjs` file under `workbench`.
