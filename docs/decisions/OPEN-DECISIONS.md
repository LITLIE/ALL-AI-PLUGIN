# OPEN-DECISIONS — AI Agent 统一编排工作台

> 只追加 + 就地关闭。OPEN → RESOLVED 时补 Resolution 字段并写明关闭依据。
> 每个 Phase 开始时把未决项复现到工作上下文最前面。

| Date | Source | Open Item | Related Constraints | Current Leaning | Blocked By | Resolves When | Status |
|------|--------|-----------|---------------------|-----------------|------------|---------------|--------|
| 2026-08-31 | Phase 0 | 发布形态：Tauri 桌面壳 vs Node 本地服务 + 浏览器 UI | 用户偏好 Tauri；本机实测无 Rust / 无 MSVC Build Tools；WebView2 151 已装；MVP 要求端到端可用 | 内核与外壳解耦：内核 = 本地服务 + 静态 Web UI，Tauri 仅作后期可选外壳，两条路共用同一内核 | 架构师给出 Tauri 实测安装成本与对比矩阵 | 架构师回传裁决 + 用户拍板 | **RESOLVED (2026-08-31)** · Resolution: 架构师两轮均被 429 配额打断，总监代笔裁决（ADR-001）：双轨架构——内核 Node 本地服务 + 静态 UI 为 MVP 唯一形态，Tauri 2 仅为 M6 可选外壳（实测成本 MSVC ~7GB + Rust 2-5GB + 首编 3-10min）。**待专家复核** |
| 2026-08-31 | Phase 0 | 非 git 工作区的 diff 与回滚方案 | 要求"一键应用或回滚"且不能假定项目一定是 git 仓库 | 执行前做文件路径 + 内容哈希快照，执行后比对出增删改；回滚走快照还原，git 仓库额外叠加 git diff 作为展示增强 | 架构师给出方案与边界 | Phase 1 架构回传 | **RESOLVED (2026-08-31)** · Resolution: ADR-003 快照底座（sha256+内容备份→比对→还原），git 为增强。**待专家复核** |
| 2026-08-31 | Phase 0 | GUI 型 Agent（Trae / Trae SOLO / WorkBuddy）的接入形态 | 三者无 CLI 入口，无法被 spawn（PM 实测均不在 PATH） | human-bridge 适配器：生成 briefing → 复制到剪贴板 → 人工在对方 UI 执行 → 粘贴结果回写，产出由人工回填并留痕 | 无 | PM/架构师确认可行性后转为已决 | **RESOLVED (2026-08-31)** · Resolution: PM 实测确认无 CLI，human-bridge 确立为与 CLI/ACP 平级的一等后端（PRD 差异化 3、UIUX BridgePanel） |
| 2026-08-31 | Phase 0 | 是否将 ACP（Agent Client Protocol）作为一等公民适配器 | 若成熟可显著降低各 Agent 接入成本；若不成熟则退化为 stdout 文本解析 | 先看 PM 调研的 ACP 成熟度与支持方名单再定 | PM 协议调研 | Phase 1 PM 回传 | **RESOLVED (2026-08-31)** · Resolution: PM 实测 ACP v1 成熟（30+ agent）但 Claude 不说 ACP、Codex 走原生 app-server 能力更强。定为：协议可插拔五解析器（native-jsonrpc/stream-json/acp/cli-text/human-bridge），ACP 是第三方统一入口之一、非唯一通道 |
| 2026-08-31 | Phase 0 | 多 Agent 并行写同一仓库时的冲突治理 | 并行执行是硬需求，但两个 Agent 同时改同一文件必然冲突 | MVP 阶段用文件级写锁 + 任务级作用域声明（每个任务声明允许写入的 glob），冲突即拒绝派工 | 架构师给出锁粒度方案 | Phase 1 架构回传 | **RESOLVED (2026-08-31)** · Resolution: 任务级 scope glob 声明 + 派发前重叠检测（AC-10 预警默认拒绝并行）；git 仓库叠加 worktree 物理隔离（AC-09） |
| 2026-08-31 | Phase 0 | 超时中断在 Windows 上的可靠实现 | Node 的 kill 在 Windows 上杀不掉孙进程；codex/claude 均为 npm .cmd 包装，进程树更深 | spawn 改用异步 + AbortController，超时走进程树终止（taskkill /T /F 或 Job Object），由架构师实测选定 | 架构师实测 | Phase 1 架构回传 | **RESOLVED (2026-08-31)** · Resolution: ADR-002——taskkill /PID /T /F（POSIX 进程组）；长连接先 turn/interrupt 3s 宽限再杀树；退出钩子+崩溃对账防孤儿。Job Object 因需原生绑定破坏零依赖纪律被拒。**待专家复核** |
