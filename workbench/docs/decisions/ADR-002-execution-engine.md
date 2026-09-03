# ADR-002: 执行引擎 —— 异步 spawn 双生命周期 + Windows 进程树终结

## Status: Accepted (2026-08-31) — 总监代笔，待专家复核

## Background
现有 agent-crew 的 `runCliRole()` 用 `spawnSync`，阻塞且无法并行、无法超时中断。PM 实测：`codex`/`claude` 是 npm shim（Node 直接 spawn 报 ENOENT），真实进程树为 `cmd.exe → node.exe <cli>.js`；Codex 0.150.1 另有原生 `codex app-server`（JSON-RPC over stdio 长连接会话），Claude 2.1.251 有原生 `stream-json` 一次性进程模式。两类通道并存。

## Decision
1. **统一入口复用 `spawnPlan()` 语义**（移植自 `plugins/agent-crew/server/lib/dispatch.mjs`）：PATH/PATHEXT 解析真实入口、`.cmd/.bat` 经 `cmd.exe /d /s /c` 路由、`{{prompt}}` 含 shell 元字符（`[&|<>^"`%\r\n]`）时禁止进 argv、必须走 stdin。抽为 `core/spawn.mjs`，行为不变，配 Windows 回归测试（AC-03）。
2. **两种执行生命周期**（`core/executor.mjs`）：
   - `oneshot`（cli-text / stream-json / echo）：`child_process.spawn` + 流式 stdout/stderr 采集 + 退出码语义；支持 AbortController。
   - `session`（native-jsonrpc / acp）：spawn 一次 → 协议握手 → 请求-响应按 id 关联、通知按 method 分发 → 多轮 turn → 优雅关闭。会话对象持有 kill 句柄；进程 `exit` 时清理全部 pending 请求并标记会话死亡，防止悬挂。
3. **超时中断两套语义**：
   - oneshot：Windows 上 `taskkill /PID <pid> /T /F`（终结整棵 shim→node 树，实测这是唯一可靠手段）；POSIX 上 detached + `process.kill(-pgid)`。
   - session：先发 `turn/interrupt`（Codex）/ Ctrl 事件，等待宽限 3s 无响应再升级进程树终结。中断必须落 `run.timeout` / `run.interrupted` 审计事件。
4. **防孤儿进程**：服务退出钩子（`process.on('exit'/'SIGINT'/'SIGTERM'/'beforeExit')`）遍历全部活跃 run/session 逐个进程树终结；每个 spawn 记录 `{pid, runId, startedAt}` 到内存注册表 + 崩溃恢复时按日志对账，发现无主进程即终结。
5. **重试判定**：Codex 读 error 事件 `willRetry` 字段；oneshot 读退出码 + stderr 匹配可重试模式（网络断连/限流）。指数退避 `1s × 2^n`，默认 `maxRetries: 2`；重试在**同 thread 内开新 turn**（保留上下文），不重建会话。

## Consequences
- 正面：并行与超时真正可用；协议原生中断优先于杀进程，产出不被无谓丢弃；Windows 陷阱全部有测试覆盖。
- 负面：`taskkill` 依赖系统工具（Windows 自带，可接受）；session 模式需维护请求关联表，实现复杂度高于 oneshot。
- 拒绝的替代：Job Object（win32 API 需原生绑定，破坏零依赖纪律）；仅靠 `child.kill()`（杀不死 shim 树，PM 已实测 ENOENT/残留风险）。

## Related ADRs: ADR-001、ADR-003
