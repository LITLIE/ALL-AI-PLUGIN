---
description: 初始化 agent-crew 消息总线并体检各个角色后端是否可用
argument-hint: "[--reset]"
---

初始化本项目的 agent-crew 协作环境。参数：$ARGUMENTS

## 步骤

1. 如果参数里有 `--reset`，先向用户确认要不要清掉现有总线（`.agentbus/` 里的历史消息与线程会全部丢失，不可恢复）。确认后再删除 `.agentbus/bus.jsonl` 与 `.agentbus/state.json`，**保留** `roles.json`（那是用户自己配的角色）。没有 `--reset` 就跳过这一步，不要删任何东西。

2. 初始化并体检：

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" init
   node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" doctor
   ```

3. 检查 MCP 通路：调用 `agent_roster` 工具（完整名 `mcp__plugin_agent-crew_crew__agent_roster`，参数 `probe: true`）。如果这个工具不存在，告诉用户需要 `/reload-plugins`（或重启会话）让插件的 MCP 服务器起来，本次先用命令行模式继续。

4. 如果 `doctor` 里有 `cli` 后端显示 FAIL，逐条说明原因和修法，例如 `codex` 角色需要 `npm install -g @openai/codex` 并且 `codex login` 过。**不要**替用户执行登录或全局安装，把命令给他，让他自己用 `! <命令>` 跑。

5. 最后用一段话汇报：总线路径在哪、有哪些角色、哪些现在就能用、哪些需要补装，然后给出下一步可以试的命令（`/agent-crew:discuss` 或 `/agent-crew:relay`）。

## 说明

`.agentbus/` 落在项目根目录下，是纯文本（JSONL + JSON），可以直接看、可以进版本库。如果这是个 git 仓库，问用户要不要把 `.agentbus/` 加进 `.gitignore`——协作记录想留档就别忽略，只当临时草稿就忽略。
