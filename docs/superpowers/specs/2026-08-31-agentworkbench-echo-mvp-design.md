# AgentWorkbench Echo MVP 设计规格

日期：2026-08-31  
状态：待用户复核  
范围：第一阶段可运行垂直切片

## 1. 目标与边界

本阶段把现有 `workbench` 收敛为一套可运行的核心实现，完成无网络、无 Token 的 Echo 全链路：

`Agent 注册 -> 能力匹配 -> 任务创建 -> Run 执行 -> 事件追加 -> replay 恢复 -> maker-checker 验收 -> 基础 HTTP/SSE 观察`

本阶段不实现真实 Claude/Codex 执行、复杂 worktree 合并、完整 Diff Viewer、审批 RPC、Tauri 外壳和通用非 coding Agent 协议。它们只能建立在这条链路稳定之后。

## 2. 外部项目调研结论

- [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)：后台任务需要独立的状态、结果、取消和转移入口；命令面应可查询而非依赖当前进程输出。
- [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph)：持久化状态、可恢复执行和人工介入应属于运行时基础能力，而不是 UI 附加功能。
- [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands)：控制台、Agent Server、Agent/工具运行时要有清晰边界；一个控制台可以连接多个 Agent 后端。
- [agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol)：客户端与 Agent 通过稳定协议解耦，协议版本与能力协商独立于实现版本。

吸收原则：当前阶段只落地“后台状态、可恢复事件、适配器边界”三点，不引入这些项目的云端、容器、调度或模型路由复杂度。

## 3. 架构决策

### 3.1 单一核心模型

运行路径只使用：

- `EventBus`：追加事件、脱敏、连续序列、完整性检查、按序读取。
- `AgentRegistry`：加载 `agents/*.json`、探测、按能力过滤。
- `Orchestrator`：创建任务、选择 Agent、启动 Run、消费适配器事件、派生状态、replay。

旧的函数式 API 不再被 CLI 或 HTTP 调用；可以暂时保留文件，但不能继续作为第二套契约。

### 3.2 Agent 与适配器

Agent 配置中的 `type` 是适配器键：

```json
{ "id": "echo-test", "type": "echo", "capabilityTags": ["read", "test"] }
```

加载函数接收完整 Agent 配置，以便适配器读取命令、环境、超时和风险策略。适配器最小接口：

```js
{
  probe(agent): Promise<{ ok: boolean, version?: string, error?: string }>,
  run({ taskId, runId, prompt, cwd, timeoutMs, signal }): AsyncIterable<Event>,
  interrupt({ runId }): Promise<void>
}
```

Echo 适配器必须稳定地产生 `run.started`、`run.stdout`、`run.completed`，并且能被测试等待到终态。

### 3.3 事件格式与状态派生

事件统一为：

```json
{
  "ts": "2026-08-31T00:00:00.000Z",
  "seq": 1,
  "kind": "run",
  "meta": { "taskId": "task-1", "runId": "run-1", "agentId": "echo-test" },
  "payload": { "type": "run.completed", "text": "..." }
}
```

`seq` 从 1 开始且必须连续；读取时遇到非法 JSON、缺失或跳号必须报告错误，不能静默过滤或重排。事件写入前对字符串递归脱敏。任务和 Run 状态只从事件派生，`state.json` 若存在也只能作为可删除缓存。

### 3.4 CLI 与 HTTP

CLI 和 HTTP 共用同一组核心对象：

- CLI：`agents:list`、`task:create`、`task:dispatch`、`task:list`、`task:verdict`、`replay`、`audit`。
- HTTP：`/api/health`、`/api/agents`、`/api/tasks`、`/api/tasks/:id/dispatch`、`/api/runs/:id/verdict`、`/api/events`。

派发接口返回 Run 标识；Echo smoke test 负责等待事件流到达完成态。SSE 首次连接按 `since` 补发，随后只发送新序列，断线重连不得重复或漏发。

## 4. 关键流程

1. 注册表加载 JSON；内置 Echo 探测为可用。
2. 创建任务并追加 `task.created`。
3. 根据 `requiredTags` 选择候选 Agent；无交集时返回缺失标签并保持任务阻塞。
4. 创建 Run，追加 `run.started`，消费适配器 AsyncIterable，并把每个事件追加到总线。
5. `run.completed` 将任务置为 `awaiting-review`。
6. 验收时若 reviewer 与 maker 相同，追加拒绝事件并不改变成功状态；不同 reviewer 才能记录通过、驳回或返工。
7. 新进程执行 `replay`，从事件重建同样的任务与 Run 状态。

## 5. 错误处理

- 所有 ESM 模块不得使用未定义的 CommonJS `require`。
- 适配器不存在、配置损坏、Agent 不可用、能力不匹配都返回结构化错误，不让进程产生未处理异常。
- 运行异常追加 `run.failed`；第一阶段不做自动重试，但保留 `maxRetries` 字段和后续扩展点。
- 中断追加 `run.interrupted`，不得伪造 `run.completed`。
- 总线损坏使 `audit` 以非零退出，并返回首个错误位置。

## 6. 测试与验收

使用 Node 内置 `node:test`，不新增运行时依赖，至少覆盖：

- ESM 模块可加载，所有 `workbench/**/*.mjs` 通过语法检查。
- 注册表加载四个配置，`echo-test` 探测可用。
- 能力匹配成功与无匹配阻塞。
- Echo Run 事件顺序、终态和任务状态。
- maker-checker 同 Agent 被拒绝，不同 reviewer 可记录 verdict。
- replay 后任务和 Run 状态与执行结束时一致。
- 非法 JSON、seq 缺口、敏感串脱敏均能被检测。
- HTTP health、agents、tasks 和 SSE since 补发。

验收命令：

```text
node --test
node awb.mjs agents:list
node awb.mjs task:create --title demo --requiredTags read
node awb.mjs task:dispatch --task <id> --agent echo-test
node awb.mjs replay
node awb.mjs audit
```

## 7. 后续扩展接口

真实 Claude/Codex 适配器、worktree 快照、审批、Diff 和 UI 只依赖本规格定义的核心接口，不改变任务状态和事件字段的基本语义。未来通用 Agent Runtime 应在适配器之上增加协议版本与 capability negotiation，而不是让编排器识别厂商名称。

