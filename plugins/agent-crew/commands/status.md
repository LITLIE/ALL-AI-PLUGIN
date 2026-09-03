---
description: 总览协作现状：开着的线程、各角色未读、总线最近发生了什么
argument-hint: "[--limit N]"
---

汇报 agent-crew 的当前状态。参数：$ARGUMENTS

依次运行：

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" thread list
node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" roster
node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" log --limit 20
```

然后用一段话回答三个问题，不要把原始输出整段贴给用户：

1. **现在卡在谁身上** — 每个开着的线程差谁发言（debate）或到了哪一棒（relay），点名具体角色。
2. **有什么该收尾了** — 哪些线程已经有足够信息可以关掉写结论。
3. **下一条命令是什么** — 给出具体可执行的建议，例如"用 `/agent-crew:discuss <线程id>` 补上 critic 的第 2 轮"。

如果总线是空的，直接说还没有协作记录，并建议用 `/agent-crew:discuss` 或 `/agent-crew:relay` 开第一个线程。
