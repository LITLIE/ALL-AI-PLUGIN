---
description: 查看、推进或关闭一个协作线程
argument-hint: "<线程id> [read|advance|close] [说明]"
---

操作一个 agent-crew 线程。参数：$ARGUMENTS

## 先定位线程

没给 id 就先列出来让用户选：

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" thread list
```

线程 id 支持前缀匹配，`th_mtd0` 这样就够。

## read（默认）

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" thread read --id <id> --limit 30
```

读完用自己的话总结：议题是什么、目前各方分歧在哪、debate 还差谁发言 / relay 到了哪一棒、下一步该谁动。不要复述全部发言。

## advance（推进 relay）

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" thread advance --id <id> [--phase <阶段>] [--note "<交棒说明>"]
```

不传 `--phase` 就是顺推一格。推进前先确认当前这一棒真的交付了东西（`thread read` 里能看到本阶段负责人的回帖）；没有就先提醒用户，别空推。`--note` 写清交给下一棒的人需要知道什么。

## close（收尾）

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" thread close --id <id> --conclusion "<结论>"
```

结论要能独立看懂：最终决定是什么、依据是哪几条发言（带消息 id）、谁反对过以及为什么没采纳。关线程前先广播一次结论（`agent_broadcast`），让所有参与角色的记录里都留下这个结果。

关掉之后线程仍然可读，只是不再出现在 `--open` 列表和 SessionStart 摘要里。
