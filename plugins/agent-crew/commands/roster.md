---
description: 查看或修改协作角色（增删角色、绑定 Claude 子智能体或外部 CLI）
argument-hint: "[空=查看] | add <名字> <职责> | rm <id> | bind <id> cli <命令>"
---

管理 agent-crew 的角色注册表。请求：$ARGUMENTS

## 先看现状

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" roster
```

没有参数时，把结果整理成一张清单给用户看：每个角色的 id、职责、后端类型、未读数，并说明哪些角色现在就能被派活（`claude-subagent` 与探测通过的 `cli`）。

## 加角色

新增一个由 Claude 子智能体扮演的角色，需要两步，缺一不可：

1. 写进注册表：

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" role add --id <id> --name <显示名> --title "<职责>" --specialty "<专长>"
   ```

   默认后端是 `claude-subagent`，绑定到 `agent-crew:<id>`。

2. 建对应的子智能体定义文件。**优先**建在项目里：`.claude/agents/<id>.md`（这样不用改插件，也不会在插件更新时丢）。这时要把注册表里的绑定改成裸名：`role set --id <id> --agent <id>`。frontmatter 至少要有 `name` 和 `description`，正文照 `${CLAUDE_PLUGIN_ROOT}/agents/trae.md` 的结构写：职责 / 怎么回帖（`agent_send` 且 `from: <id>`）/ 发言格式 / 纪律。写完提醒用户 `/reload-plugins` 或重启会话，新子智能体才会出现。

## 绑定外部 CLI

把一个外部命令行 agent 接进来（`{{prompt}}` 会被换成 briefing，`{{project}}` 换成项目根目录；不写 `{{prompt}}` 就默认从 stdin 传）：

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" role add --id <id> --name <显示名> --title "<职责>" \
  --backend cli --command <可执行文件> --args=<逗号分隔的参数> --timeout 900000
```

`--args` 必须写成 `--args=...` 的等号形式，因为参数本身通常以 `-` 开头（`--args="exec,--sandbox,read-only,-C,{{project}}"`）。参数列表最终是数组，直接 spawn，不经过 shell。

加完立刻验证：`crew.mjs doctor`，看这一行是 OK 还是 FAIL。FAIL 就把原因告诉用户，不要留着一个假角色。

## 删角色

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs" role rm --id <id>
```

删角色只动注册表，历史消息保留在总线上。如果这个角色还在某个开着的线程里，先提醒用户。
