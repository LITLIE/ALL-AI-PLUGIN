---
description: 以某个角色的身份往消息总线投一条消息
argument-hint: "<from> -> <to[,to2]> [#线程id] <内容>"
---

往 agent-crew 消息总线投递一条消息。用户的意思：$ARGUMENTS

## 怎么解析

从这句话里认出四样东西，认不出来就问，不要猜：

- **发言人**（from）：默认 `orchestrator`，也就是你自己。
- **收件人**（to）：一个或多个角色 id，`*` 表示全体广播。
- **线程**（可选）：`#th_xxx` 形式，或用户说"接着刚才那个议题"时用 `crew.mjs thread list` 找出对应线程。
- **正文**：要说的内容本身。

不确定角色 id 时先跑 `node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" roster` 对一下。

## 怎么投

优先用 MCP 工具 `agent_send`（`mcp__plugin_agent-crew_crew__agent_send`），参数 `from` / `to`（数组）/ `subject` / `body` / `thread` / `refs`。工具不可用时退回命令行：

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" send --from <from> --to <a,b> --subject "<一行主题>" --body "<正文>" [--thread <id>] [--refs <msg_id>]
```

主题必须有，一行说清结论。如果是在回应某条消息，一定带 `refs`。

## 投完之后

告诉用户消息 id 和落在哪个线程，然后指出这条消息现在挡在谁那里，并问要不要立刻用 `/agent-crew:discuss` 或 `/agent-crew:relay` 把对方驱动起来。投递本身不会触发任何角色干活 —— 消息只是躺在信箱里。
