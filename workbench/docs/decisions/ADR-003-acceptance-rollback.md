# ADR-003: 验收与回滚 —— 文件快照为底座，git 为增强

## Status: Accepted and implemented in M5 (2026-09-02)

## Background
需求要求"一键应用或回滚"与"全过程可追溯"，但目标工作区不能假定是 git 仓库（PM 实测本机 Docker 未装，容器沙箱不成立；GUI 型 agent 的目标目录可能根本不是仓库）。PRD AC-15/16 要求应用后状态干净、回滚不得删除历史事件。

## Decision
**快照（snapshot）机制为唯一强制底座，git 能力为可选增强。**

1. **执行前快照**（`core/sandbox.mjs`）：Run 在 `store/runs/<runId>/workspace` 中执行；按任务 scope 扫描文件清单，每文件记录 `{relPath, size, sha256}`，并把原内容备份到 `store/runs/<runId>/snapshot-before/`。默认排除 `node_modules/**、.git/**、dist/**`，目标内的 `.awb` 也会自动排除。
2. **执行后比对**：终态事件后重新扫描同一 sandbox scope，输出 `added / modified / deleted`；modified 文本文件带行级 unified diff，二进制文件只记录元数据。
3. **diff 来源**：当前统一使用零依赖内置实现，不要求 Git。Git worktree/diff 增强保留为后续路线。
4. **回滚 = 快照还原**：apply 前保存目标目录快照到 `snapshot-apply-before/`；`rollback` 恢复该快照并删除 apply 后新增文件，事件总线历史保持 append-only。
5. **应用**：仅允许 `completed + passed` 的 Run。应用前再次扫描目标并与执行前快照比较；目标被外部修改时返回 `409 target_conflict`，不写入部分变更。重复 apply/rollback 分别返回 `already_applied` / `already_rolled_back`。
6. **验收闸门**：已实现 maker-checker，`reviewerId === run.agentId` 直接拒绝并写 `verdict.denied`。高风险任务另需独立 reviewer 通过 approval 闸门；批准、拒绝、自审拒绝和冲突决策均写入可回放事件。
7. **可靠性控制**：失败/超时 Attempt 按任务策略指数退避并创建新的 immutable Run；watchdog 负责中断、宽限和可选进程终结。每个生命周期阶段写入本地 metric 事件，原始 prompt 只保留长度与哈希。

## Consequences
- 正面：非 git 目录获得可审计的回滚能力；Agent 不直接写目标目录；回滚确定性高（还原哈希一致的原始内容）；大仓库只备份 scope 内文件，成本可控。
- 负面：快照与重试占用磁盘（需配 retention 清理策略）；复制大型工作区有额外时间和空间成本；apply 前冲突检查只保护目标在快照后的变更，不替代更细粒度的并发锁；Inline HTTP dispatch 会等待终态，长任务需要后续异步 job API。
- 拒绝的替代：仅 git stash/分支（非 git 场景失效）；仅补丁包（二进制与新增文件处理复杂、易碎）。

## Related ADRs: ADR-002
