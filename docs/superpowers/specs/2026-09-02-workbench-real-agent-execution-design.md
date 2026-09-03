# AgentWorkbench Real Agent Execution 设计规格

日期：2026-09-02  
状态：待用户复核  
范围：M1 真实 Agent 执行纵向切片

## 1. 目标

让 `workbench` 从“只能运行 Echo 的演示链路”升级为可真实派发外部 Agent 的本地工作台核心。第一阶段只要求 Claude stream-json 和 Codex app-server 能通过统一编排器完成一次可追踪 Run；所有过程事件、终态、错误、中断和结果都必须进入现有 EventBus，并能通过 replay 恢复。

完成标准：

- Windows 上能正确定位并启动 npm 安装的 `.cmd/.bat` CLI shim。
- `agents:probe` 能按 Agent 配置探测命令，而不是硬编码命令名。
- 已探测成功且有对应适配器的非 Echo Agent 可以被 CLI、HTTP 和 Orchestrator 派发。
- Claude Run 在超时前产生唯一 `run.completed` 或明确失败终态。
- Codex Run 能识别 app-server 的完成通知，不再无条件等待到超时。
- 适配器事件顺序和终态数量有自动化契约测试，测试不联网、不消耗模型额度。

## 2. 范围与非目标

本阶段包含：

- 统一 `spawn` 解析和 Windows shim 路由。
- 统一适配器输入契约：传入完整 `agentConfig`、取消信号和事件回调/异步事件流。
- Claude stream-json 事件桥接。
- Codex app-server 完成、错误和中断桥接。
- 解除 Echo-only gate，但保留 probe、enabled 和 adapter 存在性校验。
- 真实协议的本地 fixture 测试、CLI/HTTP 回归测试和文档同步。

本阶段明确不包含：

- git worktree、快照、diff、apply、rollback。
- 高风险审批和人工桥接闭环。
- 自动任务拆解、依赖 DAG、并行调度和重试策略。
- Tauri、远程 Agent、云端服务或新增运行时依赖。
- 将原始 prompt/output 从事件日志中移除的隐私策略重构；只记录当前范围内必须保留的兼容字段，另开任务处理。

## 3. 设计方案

### 3.1 统一启动层

`workbench/core/utils.mjs` 中的 `findInPath`/`spawnPlan` 不再保留独立实现，直接采用 `plugins/agent-crew/server/lib/dispatch.mjs` 已验证的解析语义：

- Windows 按 `PATHEXT` 探测 `.COM/.EXE/.BAT/.CMD`。
- npm 的 `.cmd/.bat` 通过 `cmd.exe /d /s /c` 启动。
- 普通可执行文件直接 spawn，不把外部 prompt 重新交给 shell 解析。
- 所有适配器通过 Workbench 唯一的启动 helper 生成 `{ file, args, viaShell, resolved }` 计划并保留解析后的路径；编排器不直接处理进程细节。

旧的 `spawn-helper.mjs` 只保留确实被调用的通用辅助函数；不得形成第二套命令解析规则。若两个模块职责重叠，以 `utils.mjs` 作为 Workbench 的唯一外部进程入口。

### 3.2 配置驱动适配器契约

`loadAdapter` 继续根据 `agentConfig.type` 加载模块。编排器调用适配器时传入：

```js
adapter.run({
  taskId,
  runId,
  prompt,
  cwd,
  timeoutMs,
  signal,
  agentConfig,
});
```

适配器必须返回 `AsyncIterable<Event>`。每个适配器负责把外部协议转换成统一事件；Orchestrator 负责追加事件和派生状态，不读取厂商原始消息来判断状态。

配置字段语义：

- `command`：探测和启动的命令。
- `args`：参数模板；支持 `{{prompt}}`、`{{cwd}}` 等有限变量替换。
- `env`：叠加到当前进程环境的变量。
- `timeoutDefault`/`timeoutMax`：默认和上限由适配器/编排器共同约束。
- `outputProtocol`：决定适配器如何解析 stdout。
- `maxRetries`：本阶段只保留在 Run 元数据中，不执行自动重试。

适配器不得硬编码 `claude`、`codex` 或 Agent ID；默认值只允许作为缺失配置时的兼容回退，并在测试中覆盖配置优先级。

### 3.3 Claude stream-json

Claude 适配器采用单向异步队列：stdout/stderr 监听器只负责把转换后的统一事件放入队列，`run()` generator 负责按顺序 yield。这样不会丢失回调事件，也不会在 generator 内重复产生 `run.started`。

事件映射：

- `system/init` → `run.init`。
- `assistant` 文本 → `run.stdout`。
- stderr 行 → `run.stderr`。
- `result` 且成功 → 唯一 `run.completed`，携带 `text`、`cost`、`duration` 和可用 usage 元数据。
- 非零退出或 result 失败 → 唯一 `run.failed`。
- 超时 → 先发 `run.timeout`，再终止进程；不得随后发 completed。

进程关闭和 result 事件存在竞态时，以已观察到的终态事件为准；如果关闭时没有终态，按退出码产生一个失败终态。队列关闭必须可唤醒 generator，避免永久等待。

### 3.4 Codex app-server

Codex 适配器继续使用 JSON-RPC over stdio，但必须保存并消费通知队列。Run 等待以下任一条件：

- 收到当前 turn 的完成通知，转换为 `run.completed`。
- 收到明确错误通知或进程异常退出，转换为 `run.failed`。
- 超过有效 timeout，产生 `run.timeout`，发送 `turn/interrupt`，等待最多 3 秒后终止进程。

通知解析必须兼容响应和通知分离、不同版本的完成方法名，以及缺少可选字段的消息。不得以“轮询时间结束”作为正常完成依据。

`interrupt()` 必须调用活动 Run 的适配器上下文；Windows 上最终进程树终结使用统一的 `killProcessTree`，防止 npm shim 或子进程残留。

### 3.5 编排器状态与安全校验

解除 `type === 'echo'` 的硬编码限制，但保留以下校验顺序：

1. Agent 存在且 enabled。
2. 注册表中存在对应适配器。
3. probe 已成功，或显式要求先 probe 并返回结构化不可用错误。
4. 任务能力标签与 Agent 能力匹配。

Run 仍遵循现有状态机：`running → completed → awaiting-review`，或 `running → failed|timeout|interrupted`。每个 Run 最多一个终态事件。Orchestrator 通过 `agentConfig` 传递配置，并保留活动适配器和 iterator 供中断使用。

## 4. 测试设计

新增 `workbench/test/adapter-contract.test.mjs`，使用临时目录中的假 CLI fixture：

- Windows fixture 同时覆盖无扩展名 shim 和 `.cmd` 文件，验证解析结果和启动成功。
- Claude fixture 输出最小合法 stream-json：init、assistant、result。
- Codex fixture 模拟 initialize、thread/start、turn/start 以及完成通知。
- 每个协议都断言：一个 `run.started`、至少一个过程事件、恰好一个终态事件、generator 正常结束。
- 超时和中断测试断言不会产生 completed，也不会重复终态。

现有 Echo、EventBus、replay、verdict、HTTP/SSE 和安全测试必须继续通过。增加至少两条端到端回归：

1. 使用临时 Agent 配置替换命令后，probe 和 dispatch 使用新配置，不读取硬编码命令。
2. 通过 HTTP 派发非 Echo fixture，SSE 能看到过程事件和终态，重启后 replay 状态一致。

测试命令：

```text
cd workbench
node --test
node awb.mjs agents:probe
```

真实机器上的 Claude/Codex smoke test 作为可选验证，不作为默认 CI 门槛；它需要本地安装和认证，不得让自动化测试依赖网络或用户凭据。

## 5. 失败处理与可观测性

- 配置缺失、命令找不到、协议解析错误和进程异常都转换为可读的 `run.failed` 或 probe 错误。
- 适配器 stdout/stderr 作为不可信数据写入事件；不执行其中夹带的命令。
- 超时和中断必须写入总线，且清理活动进程/iterator。
- 适配器诊断保留 resolved executable、退出码和错误摘要，但不改变现有 EventBus 的追加、脱敏和完整性规则。

## 6. 验收场景

1. 本地 fixture 的 `agents:probe` 和 dispatch 必须报告 `ok: true`；真实机器上若未安装或未认证，必须给出明确 ENOENT/认证错误，而不能显示假阳性。
2. Echo 任务行为与当前 36 个测试保持一致。
3. Claude fixture 在一次 Run 中得到 `run.completed`，任务进入 `awaiting-review`。
4. Codex fixture 在模拟完成通知后立即 completed，不等待 timeout。
5. 对任何外部 Agent 调用 `task:verdict` 仍执行 maker-checker 分离。
6. `node --test` 全部通过，且不得新增运行时依赖。

## 7. 后续衔接

M1 完成后，M2 可在不改变核心 Run 事件语义的前提下加入真正的 Codex session 生命周期；M3 统一 capability/risk schema；M4 再接入隔离、snapshot、diff、apply 和 rollback。Planner/DAG 必须建立在真实适配器链稳定之后。
