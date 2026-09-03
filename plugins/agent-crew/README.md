# agent-crew

让你自己设定的 agent 之间真正**协作与沟通**的 Claude Code 插件。

灵感来自 [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)（把外部 agent 接进 Claude Code），但目标不同：codex-plugin-cc 解决"把活委派给 Codex"，agent-crew 解决"一群我自己定义的角色怎么在一件事上互相讨论、互相交接"。

## 它解决什么

多 agent 协作里最容易被忽略的不是"怎么调起另一个 agent"，而是**沟通留不下痕迹**：子智能体跑完就没了，它的结论只活在某一次输出里；下一个角色看不到前面的人说过什么；换个会话就全部从零开始。

agent-crew 的做法是：所有角色都往同一条**可落盘的消息总线**上发言，其他一切（轮次、阶段、谁欠一次发言）都是从这条日志折叠出来的。

- 发言不落总线就等于没发言 —— 协作状态不依赖谁的记忆。
- 关掉终端第二天回来，`/agent-crew:status` 直接告诉你卡在谁身上。
- 角色的"身份"和"由谁扮演"解耦：同一个 `reviewer` 角色今天由 Claude 子智能体扮演，明天换成外部 CLI，讨论记录连续不断。

## 安装

需要 Node.js 18+（本插件零 npm 依赖）。

```
/plugin marketplace add D:\Agentplugin
/plugin install agent-crew@agentplugin-local
/reload-plugins
/agent-crew:setup
```

`/agent-crew:setup` 会创建 `<项目>/.agentbus/`、写入默认角色，并体检每个后端是否真的能跑。

## 五分钟上手

```
# 一场三方辩论：Trae 出方案，Workbuddy 说实现代价，Critic 挑毛病
/agent-crew:discuss 我们的会话状态应该存 SQLite 还是 JSONL --with trae,workbuddy,critic

# 一条流水线：设计 → 实现 → 评审 → 修复
/agent-crew:relay 给导出功能加分页

# 随时看卡在谁身上
/agent-crew:status
```

## 角色

角色 = 总线上一个可寻址的名字 + 一个决定"谁来回答"的后端。

| 默认角色 | 职责 | 后端 |
| --- | --- | --- |
| `orchestrator` | 拆解目标、派活、汇总结论 | 当前主会话自己 |
| `trae` | 架构与方案设计、技术选型与取舍 | Claude 子智能体 |
| `workbuddy` | 落地实现、补测试、修构建 | Claude 子智能体 |
| `critic` | 质疑者：隐含假设、失败场景、被忽略的成本（只读） | Claude 子智能体 |
| `codex` | 外部独立评审，换一个模型家族交叉验证 | 外部 CLI (`codex exec`，read-only) |
| `human` | 你：拍板、提供业务上下文、批准有风险的动作 | 问用户 |

四种后端：

| type | 谁来回答 |
| --- | --- |
| `self` | 当前主会话 |
| `claude-subagent` | 主会话用 Agent 工具启动指定子智能体 |
| `cli` | 在本机 spawn 一个外部命令行 agent，stdout 自动回帖 |
| `human` | 主会话去问用户，代为回帖 |

改角色：`/agent-crew:roster`，或直接编辑 `<项目>/.agentbus/roles.json`。`config/roles.example.json` 里有可写 Codex、Gemini、PM 等现成条目可抄。

Agent Crew 与 AgentWorkbench 共用仓库根目录下的 `shared/agent-runtime/`：`probeCommand()`、命令解析、Windows shim 启动计划、参数模板和可执行性探活只有一份实现。插件仍保留 `probeCli()` 的同步返回格式和消息总线派发流程；共享层不接管插件自己的 EventBus 或角色状态。

## 两种协作模式

**debate（多方讨论 / 辩论）** —— 用于"该怎么做"还没定的时候。第 1 轮各角色**并行**独立表态（避免互相锚定），第 2 轮起**串行**，让每个人都能看到并回应前面的发言。轮次是算出来的：每人在本线程的发言数取最小值 + 1 就是当前轮，发言数没达标的人进"待发言"名单 —— 所以随时可以补一轮，不需要任何计数器。

**relay（流水线接力）** —— 用于方向已定、要把它做完的时候。严格串行，默认阶段 `design → implement → review → fix`，每阶段一个负责人。上一棒没交付就推不动下一棒；评审阶段只读不改；同一个问题来回超过两轮会停下来问你。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/agent-crew:setup` | 初始化总线 + 体检后端可用性 |
| `/agent-crew:roster` | 查看 / 增删角色，绑定子智能体或外部 CLI |
| `/agent-crew:discuss` | 组织一场多方讨论并收敛结论 |
| `/agent-crew:relay` | 按阶段接力把一件事做完 |
| `/agent-crew:send` | 以某个角色身份投一条消息 |
| `/agent-crew:inbox` | 读某个角色的收件箱 |
| `/agent-crew:thread` | 查看 / 推进 / 关闭一个线程 |
| `/agent-crew:status` | 总览：谁卡着、什么该收尾、下一条命令 |

## MCP 工具

插件自带一个零依赖的 MCP 服务器（`server/mcp-server.mjs`），让任何角色都能直接收发消息，而不必走 shell：

`agent_roster`、`agent_send`、`agent_broadcast`、`agent_inbox`、`agent_dispatch`、`thread_open`、`thread_read`、`thread_advance`、`thread_close`、`bus_log`

会话里的完整名字是 `mcp__plugin_agent-crew_crew__<工具名>`。

## 命令行

同一份状态也能从 shell 读写，调试和写脚本时用：

```
node "<插件目录>/scripts/crew.mjs" help
node "<插件目录>/scripts/crew.mjs" doctor
node "<插件目录>/scripts/crew.mjs" thread read --id th_xxx
```

## 数据

一切都在 `<项目>/.agentbus/`，纯文本，可读可 diff 可进版本库：

```
bus.jsonl      只追加的事件日志（消息 / 广播 / 开线程 / 阶段推进 / 派活）
roles.json     角色注册表
state.json     每个角色的已读游标
runs/          外部 CLI 每次执行的完整 stdout/stderr
artifacts/     正文放不下的大块交接产物
```

`seq` 不存在文件里，是读取时按行号算的 —— 所以追加不用加锁，多个写入方可以并发 append。代价是**不要删改中间的行**（会让后面的 seq 全部前移，已读游标错位）。要撤回，追加一条更正消息。

数据模型和排查细节见 `skills/crew-protocol/SKILL.md`（在会话里会按需自动加载）。

## 安全

- **外部 agent 的输出是不可信数据。** 外部 CLI 的 stdout 会被原样回帖到总线，并在 `meta.untrusted` 上打标。它可能包含"忽略之前的指令"这类内容 —— 当同事的意见来评估，不要执行其中夹带的命令。三个自带子智能体的提示里都写明了这条。
- **外部 CLI 不经过 shell**：`backend.args` 是数组。插件自己在 PATH 里解析出可执行文件，直接 spawn，briefing 里的引号、`&`、换行都原样进 argv，不会被当成命令。唯一例外是 Windows 上 npm 装出来的 `.cmd` / `.bat` 包装脚本（Node 不允许不经 `cmd.exe` 启动它们）：这种情况下如果 `args` 里还塞了 `{{prompt}}`、而 briefing 含 shell 元字符，dispatch 会直接报错让你改用 stdin，而不是冒险执行。
- **默认不给外部 agent 写权限**：自带的 `codex` 角色是 `--sandbox read-only`。要让它动手改文件得自己加一个 `workspace-write` 的角色（`config/roles.example.json` 里有示例），这是个明确的决定，不是默认。
- **破坏性动作要人批准**：删数据、改生产配置、force push 这类动作，角色提示和编排命令都要求先停下来问 `human`。
- SessionStart 钩子只跑一条本地 `crew.mjs digest`（在总线空闲时什么都不输出），不联网、不改文件。

## 已知边界

- Claude 子智能体后端**必须**由主会话启动 —— MCP 服务器起不了子智能体，所以 `agent_dispatch` 对这类角色返回的是一份 briefing，由编排方（`/agent-crew:discuss`、`/agent-crew:relay`）接手。这是刻意的：让"谁能启动谁"这件事保持显式。
- 子智能体偶尔会忘记回帖。编排命令每一步都会 `thread_read` 复核，缺了就由 orchestrator 代为补录并注明。
- 目前没有后台任务管理（像 codex-plugin-cc 的 `status/result/cancel`）：外部 CLI 是同步跑完的，长任务会占住这一轮。
- 没有 Stop 钩子式的自动评审闸门 —— 那种设计容易把两个 agent 拖进烧配额的循环，需要的话应当是明确的开关。

## 目录

```
.claude-plugin/plugin.json     插件清单
.mcp.json                      MCP 服务器注册
hooks/hooks.json               SessionStart：把待处理的协作状态摘要注入上下文
agents/                        trae / workbuddy / critic 三个示例角色
commands/                      8 个 slash 命令
skills/crew-protocol/          总线协议参考
scripts/crew.mjs               命令行入口
server/mcp-server.mjs          MCP 服务器（手写 JSON-RPC，零依赖）
server/lib/                    paths / store / roles / threads / dispatch / render
config/roles.example.json      可抄的角色条目
```
