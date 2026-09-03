# PRD — AI Agent 统一编排工作台（AgentWorkbench，命令名 `awb`）

> 版本 v1.0 · 2026-08-31 · 产出：许清楚（PM）实测调研，总监汇编落盘
> 定位：**带验收闸门的可审计追踪层** —— 不是"又一个 ACP 客户端"

## 1. 问题陈述

目标用户：本机装了 3–5 个 AI coding agent（Codex、Claude Code、Trae、Trae SOLO、WorkBuddy）、用 agent 真实改自己仓库的独立开发者/小团队 Lead（Windows 11 优先）。

结构性痛点（非"不方便"）：

| 失效点 | 证据 |
|---|---|
| 生成过剩、验收是天花板 | Faros AI 2026（22000 开发者遥测）：PR 中位评审时长 +441% YoY、31% PR 无人评审即合并、每合并 PR 生产事故 +242.7% |
| 并行 agent 改同一仓库 = 竞态 | dev.to 一线："两个 agent 各自认定同一函数有 bug，以矛盾方式'修复'，彼此不知对方存在" |
| agent 自己给自己打分 | Veracode 2026：约 44% AI 生成任务引入高危漏洞，安全通过率 56% |
| 出事无法回溯 | 无人能回答"谁在哪一步依据什么改的、能不能信、怎么退回" |
| GUI 型 agent 进不了任何编排 | 实测 `trae`/`trae-solo`/`workbuddy` 均不在 PATH，ACP 生态（30+ agent）全是 CLI/SDK 型 |

一句话：多个 agent 已能并行写代码，但没有人能回答"这堆改动是谁在哪一步、依据什么改的、能不能信、怎么退回去"。

## 2. 竞品与市场空白

直接竞品：Zed+ACP（协议最成熟但本质是编辑器，无验收闸门/变更账本）、Google Antigravity（并行编排强，官方自曝并行会合冲突需人工解决，20+ artifacts 要人看 10–15 分钟）、OpenHands（企业级可观测但必须 Docker——本机未装，路线不成立）、Docker cagent（声明式造 agent 不是管 agent）、Jockey/Codeg/Braide/AgentPool 等 ACP 原生工作台（重心在"并行跑起来"，不在"验收与审计"）、Cursor 3/Trae SOLO/Agent HQ（锁死厂商名单与计费）。

三个无人填补的空白：① 把"验收"当一等公民（判定+留痕+回放）；② GUI 型 agent 一等公民接入；③ Windows 上零依赖跑起来（无 Docker、无 Rust）。

## 3. 差异化 5 点

1. **追踪优先不是聊天优先**：只追加事件日志是产品内核，任何时刻可 replay。
2. **验收闸门是硬约束**：maker-checker 强制分离——写代码的 agent 不能验收自己的产出；判定前先过确定性预检（测试/构建/diff 体积/目录白名单）。
3. **GUI 型 agent 是一等公民**：human-bridge 与 CLI/ACP 平级，同样进总线、同样带 untrusted 标记。
4. **零依赖、本地、无 Docker、无外传**：Node 22 + Git 即可跑，只监听 127.0.0.1，埋点本地落盘。
5. **复用已验证的 agent-crew 协议**，两边并存。

## 4. 功能清单（RICE 排序，Score=(R×I×C)/E）

| # | 功能 | Score | 优先级 |
|---|---|---|---|
| F2 | 事件总线（只追加）+ 状态派生 | 15.00 | P0 |
| F1 | 适配器层（配置驱动：CLI/原生协议/ACP/人工桥接/Echo） | 10.00 | P0 |
| F9 | 高风险操作人工确认（审批流） | 8.10 | P0 |
| F4 | 实时输出与日志流（结构化事件 → 时间线） | 7.20 | P0 |
| F8 | 一键应用/回滚 | 6.80 | P0 |
| F11 | 审计留痕与回放 | 6.80 | P0 |
| F5 | 执行隔离（git worktree / 目录白名单） | 6.30 | P0 |
| F13 | 超时中断与失败重试 | 6.30 | P0 |
| F6 | 变更采集与 diff 审阅 | 6.08 | P0 |
| F7 | 验收闸门（通过/驳回/重新分派 + maker-checker） | 5.74 | P0 |
| F3 | 任务拆解与派发（能力标签 + 串行/并行） | 5.40 | P0 |
| F12 | 图形界面（总览/看板/日志流/diff 审阅） | 4.00 | P0（最后建，建在 CLI 之上） |
| F14 | 成本/耗时统计面板 | 2.70 | P1 |
| F10 | 敏感信息脱敏 | 2.00 | P1 |
| F15 | 主控 Agent 自动拆解 | 1.44 | P2 |

## 5. MVP 范围

**做（最薄可验证版）**：F2 总线 + F1 四类后端（`native-jsonrpc` Codex app-server、`stream-json` Claude、`human-bridge`、内置 `echo`）+ F3 手工拆任务/能力选派/并行 + F4 事件时间线 + F5 worktree 隔离 + F6 变更清单与 unified diff + F7 三种判定 + maker≠checker + F8 worktree 级应用/回滚 + F9 审批双通道 + F11 事件即审计 + F12 只读 UI 四屏。

**不做（Out-of-Scope，防蔓延）**：云端/多机/团队协作；Docker/容器沙箱（本机未装）；自研 agent/模型路由；内置编辑器（审阅不做编辑）；AI 自动解决合并冲突；定时后台任务；局域网/远程访问；厂商计费管理；>10 并行（审查带宽天花板）；模型微调。

## 6. 验收标准（EARS，完整 25 条）

**适配器层**
- AC-01 When 在 `agents/*.json` 新增适配器配置（不改核心代码），系统必须在下次启动时列入可用 Agent 并能 probe 出可执行路径与版本。
- AC-02 If `command` 在 PATH 解析不到，则必须标记 `unavailable` 并给出搜索路径，不得延迟到派发时才失败。
- AC-03 While 经 cmd.exe 启动，if args 含 `{{prompt}}` 且提示词含 shell 元字符（`& | < > ^ " \` %` 或换行），then 必须拒绝执行并提示改走 stdin。
- AC-04 When 外部 CLI 的 stdout 回帖总线，必须标记 `meta.untrusted = true`。

**编排调度**
- AC-05 When 选派执行者，必须只从 `capabilityTags ∩ requiredTags ≠ ∅` 的 Agent 中挑选。
- AC-06 If 交集为空，则任务置 `blocked` 并列出缺失能力标签。
- AC-07 While 运行超过 `timeoutMs`，必须先发协议中断（`turn/interrupt` / 进程信号），失败再升级 SIGKILL，并记录 `run.timeout`。
- AC-08 If 可重试错误（`willRetry:true` 或退出码非 0 且 stderr 匹配重试模式），则按指数退避重试至 `maxRetries`，每次写 `dispatch` 事件。

**执行隔离**
- AC-09 When 任务派发，必须获得独立工作区（git worktree 或快照目录），并行任务互不可见未提交改动。
- AC-10 If 并行任务文件变更范围重叠，则派发前冲突预警并在验收界面高亮重叠文件。

**验收机制**
- AC-11 When 变更进入验收，必须汇总：文件清单、unified diff、测试构建结果（若配置）、完整事件流。
- AC-12 If 验收者 = 产出者，则拒绝判定并提示违反 maker-checker。
- AC-13 When 驳回，任务退回队列（保留 diff 供复阅）并写带 `refs` 的 `verdict` 事件。
- AC-14 When 重新分派，新 briefing 必须包含被驳回 diff 与理由。

**应用与回滚**
- AC-15 When 应用，必须先做可回滚快照（或 git stash）再合并；成功后 git 场景 `git status` 干净。
- AC-16 When 回滚，必须恢复到应用前基线并写 `rollback` 事件，不得删除历史事件。
- AC-17 If 合并冲突，则停止自动流程、保留现场、呈现冲突清单，不得自动解决。

**安全约束**
- AC-18 When 请求高风险操作，必须暂停并弹人工确认，未响应前 `awaiting-approval` 且倒计时可见。
- AC-19 While 后端为 read-only 策略，必须拒绝任何写请求（即使 Agent 自称已授权）。
- AC-20 When 事件写入或渲染，必须对密钥模式（`sk-`、`ghp_`、`Bearer `、AWS key、私钥头）脱敏，原文不得落盘。
- AC-21 When GUI 型 Agent 粘贴回执，必须作为普通事件回帖并标 `meta.via="human-bridge"`、`meta.untrusted=true`。

**审计与可用性**
- AC-22 When 请求回放任务，必须能从事件日志重建任意时刻状态。
- AC-23 If 日志中间行被删/损坏，必须检测报错，不得静默重排 seq。
- AC-24 While 任一 Agent 执行中，UI 必须显示状态、时长、最近输出与可见中止入口。
- AC-25 When 重启工作台，必须从日志派生恢复完整任务状态（无内存态依赖）。

## 7. 非功能需求

性能：事件到 UI p95 < 500ms；CLI 冷启动 < 1s；日志追加 O(1) 无锁。可用性：崩溃重启零丢失；单 Agent 故障不扩散。安全：仅 127.0.0.1；无遥测外传；外部输出一律 untrusted；参数数组直接 spawn 不经 shell。兼容：Windows 11 优先（实测 Node 22.22.2/Git 2.55/codex 0.150.1/claude 2.1.251/WebView2 151），macOS/Linux 走 spawn 抽象保持可移植。依赖：**运行时零 npm 依赖**，构建期依赖单独隔离。UI：中文为主、文案外置；WCAG 2.1 AA 基本合规（P2）。

## 8. 数据埋点（本地，不外传）

全部写本地事件日志 `kind:"metric"`，绝不外传。必埋：`agent_registered`/`agent_probe_failed`、`first_task_dispatched`、`run_started/completed/failed/timeout/interrupted`、`approval_requested/approved/denied`、`verdict_passed/rejected/rework`、`changes_applied/rolled_back`、`merge_conflict`、`error_occurred`。不采集隐私：不上报 IP，不存原始提示词与输出正文（只存长度与哈希）。
