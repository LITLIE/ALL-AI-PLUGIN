# AgentWorkbench Sandbox, Diff, Apply and Rollback Design

Date: 2026-09-02  
Status: approved design, pending implementation

## Goal

Give every coding Run an isolated local workspace so Agent changes can be inspected, approved, applied to the target directory, or rolled back without allowing unapproved writes into the target.

## Scope

This slice implements copy-based isolation for one Run at a time, content snapshots, added/modified/deleted change detection, zero-dependency unified diffs, HTTP diff/apply/rollback routes, and event-sourced state transitions. It does not implement Git worktrees, approval prompts, parallel overlap detection, automatic decomposition, or Planner/DAG scheduling.

## Workspace Model

`task.cwd` is the target directory. Each Run receives `runWorkDir(runId)/workspace` under the configured EventBus store. Before execution, the task scope is copied from target to workspace. The default scope is the entire target directory except `.git`, `node_modules`, `dist`, and the Run's own store when nested. A task may provide `scope.include` as relative files/directories and `scope.exclude` as relative paths; all resolved paths must remain inside `task.cwd`.

Adapters receive the workspace path as `cwd`. The Run stores `targetCwd`, `executionCwd`, and snapshot metadata. A failed or interrupted Run never applies changes automatically.

## Snapshot and Diff Contract

The before snapshot records every scoped file as `{ relPath, size, sha256 }` and stores original file bytes under `runWorkDir(runId)/snapshot-before/<relPath>`. The after snapshot records the sandbox state. Diff output is `{ added, modified, deleted }`; each item includes `relPath`, before/after metadata where applicable, and a unified diff for text files. Binary files are represented by metadata and `binary: true` without attempting text decoding.

Empty changes are valid and produce an empty diff. Symlinks and paths escaping the target/workspace root are rejected. Snapshot reads are deterministic and skip excluded directories.

## Apply and Rollback

Only a completed Run whose task has verdict `passed` may be applied. Before copying sandbox changes into `task.cwd`, the current target state is saved as `snapshot-apply-before`. Apply verifies the target files still match the before snapshot; if they do not, it returns a conflict and writes no target files. On success it copies added/modified files and removes deleted files, then writes `run.applied` with change counts.

Rollback is available after apply. It restores `snapshot-apply-before` exactly, removes files added by apply, and writes `run.rolled-back`. Neither operation deletes or rewrites EventBus history. Repeated apply/rollback calls are idempotently rejected with structured status responses.

## Event and State Contract

New run events are `run.snapshot.created`, `run.diff.created`, `run.applied`, `run.rolled-back`, and `run.apply.conflict`. Replay restores `snapshotBefore`, `snapshotAfter`, `diff`, `appliedAt`, and `rolledBackAt` fields. Existing terminal Run semantics and maker-checker verdicts remain authoritative.

## Testing

Tests use temporary directories and fixture adapters. They cover scope copying and containment, excluded paths, hashes/content backups, added/modified/deleted detection, unified text and binary diff behavior, failed/unfinished Run rejection, passed-verdict apply, target conflict detection, rollback restoration, HTTP route status/body contracts, and replay of apply/rollback events. The full suite remains dependency-free and must pass without Git or network access.
