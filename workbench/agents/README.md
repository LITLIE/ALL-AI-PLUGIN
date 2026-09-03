# Agent 适配器配置文件

## 目录结构

```
workbench/
  agents/              # Agent 适配器配置目录（JSON 驱动注册）
    codex-appserver.json    # Codex CLI（JSON-RPC，app-server 长连接）
    claude-stream.json      # Claude Code（stream-json，一次性进程）
    trae-solo-bridge.json   # Trae SOLO（人工桥接，GUI 型 Agent）
    echo.json              # Echo 假适配器（测试用）
```

## 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 全局唯一标识符，小写字母、数字和连字符 |
| `displayName` | string | 是 | UI 显示名称 |
| `type` | string | 是 | 适配器类型（决定 outputProtocol 解析器） |
| `outputProtocol` | string | 是 | 输出协议：`native-jsonrpc` / `stream-json` / `acp` / `cli-text` / `human-bridge` / `echo` |
| `riskLevel` | string | 是 | `read-only` / `workspace-write` / `high-risk` |
| `capabilityTags` | string[] | 是 | 能力标签，用于任务匹配派工 |
| `command` | string | 否 | 启动命令（null 表示无需 spawn，如 human-bridge / echo） |
| `args` | string[] | 否 | 命令行参数，支持 `{{prompt}}` 占位符 |
| `env` | object | 否 | 环境变量 |
| `healthCheck` | object | 否 | 健康探测配置 |
| `sessionMode` | boolean | 否 | 是否为长连接会话（true=app-server/ACP，false=一次性进程） |
| `interruptMethod` | string | 否 | 中断方式：`jsonrpc-turn-interrupt` / `signal-term` / `signal-kill` |
| `timeoutDefault` | number | 否 | 默认超时 ms |
| `timeoutMax` | number | 否 | 最大超时 ms |
| `maxRetries` | number | 否 | 最大重试次数 |
| `retryableErrors` | string[] | 否 | 可重试的错误类型 |
| `notes` | string | 否 | 维护备注 |

兼容旧配置：`adapterId` 可作为 `type` 的别名，但不能与 `type` 同时指定不同值。风险等级和能力标签采用 `workbench/config/capabilities.json` 中的严格词汇表；未知值会使该文件不可用，但不会阻断其它 Agent 加载。完整错误会出现在 `agents:list` 的 `configError` 字段和 Registry 的 `errors` 集合中。

当前能力标签：`read`、`write`、`refactor`、`analyze`、`test`、`review`、`design`。

## 新增 Agent 流程

1. 在 `agents/` 目录新建 JSON 文件（如 `gemini-cli.json`）
2. 填写上述字段
3. 刷新 UI → Agent 自动出现在注册列表并完成健康探测
4. 无需修改任何核心代码

## 已安装 Agent 发现与显式导入（M8-B）

`node awb.mjs agents:discover [--commands claude,codex]` 和 `GET /api/agents/discover` 只读探测当前 PATH 中的默认 CLI catalog，也接受显式 manifest。结果包含 `source`（`path`、`manifest`、`known-gui`）和 `confidence`（`high` 或 `advisory`），并附带可编辑的 `configDraft`。Trae、WorkBuddy 仅作为 `human-bridge` advisory 候选展示。

发现不会递归扫描用户目录、运行包管理器、联网或自动启用 Agent。用户或受信客户端必须明确确认后执行 explicit import，调用 `POST /api/agents/import`，请求体为 `{ "config": { ... }, "fileName": "optional.json" }`。导入仅写入 agents 目录下的单层 `.json` 文件并原子替换；重复 ID、路径穿越和无效配置会被拒绝。导入后的 Agent 初始为 `status: "unknown"`、不可自动路由，需显式执行 `node awb.mjs agents:probe` 或 `POST /api/agents/probe`。

## 什么情况下需要写代码？

| 场景 | 是否需要写代码 |
|------|--------------|
| 新的 outputProtocol 协议 | 是：新增解析器（`server/lib/parsers/*.mjs`） |
| 新的 spawn 行为（如特殊 cwd 策略） | 是：修改 `core/executor.mjs` |
| 新的中断语义 | 是：修改 `core/executor.mjs` |
| 新增 JSON 格式的 Agent 配置 | 否：只加 JSON 文件 |

## 健康探测（healthCheck）

```json
{
  "command": "codex",
  "args": ["--version"],
  "expect": "codex"
}
```

- `command`：探测命令（不含 args 中的 prompt 占位符）
- `expect`：stdout 中包含的期望字符串（用于判断命令可执行）

探测结果：
    - ✅ 退出码为 0 且包含期望字符串 → Agent 标记为 `available`
    - ❌ 不包含 / 命令不存在 / 超时 → Agent 标记为 `unavailable`，显示错误信息
    - ⏳ 尚未执行探活 → Agent 状态为 `unknown`，不会参与自动路由

    ACP 与 `cli-text` 的启动命令、参数、环境和 cwd 全部读取本配置，不会隐式调用 `claude` 或 `claude-code-acp`。`healthCheck.expect` 可用于校验版本输出；`node awb.mjs agents:probe` 和 `POST /api/agents/probe` 返回完整结构化结果。

## human-bridge 特殊字段

```json
{
  "type": "human-bridge",
  "outputProtocol": "human-bridge",
  "bridgeInstructions": {
    "prompt": "请将以下任务在 XXX 中完成…",
    "copyButton": true,
    "pasteInput": true
  }
}
```

工作流程：
1. 工作台生成 briefing（含完整任务描述 + 工作目录）
2. 用户一键复制到剪贴板
3. 用户切换到目标 GUI Agent 执行
4. 用户将产出粘贴回工作台
5. 产出作为带 `meta.via="human-bridge"` + `meta.untrusted=true` 的事件回帖

## echo 特殊说明

`type: "echo"` 是内置假适配器，不需要 `command` 字段。收到任务后：
1. 等待 500ms（模拟思考）
2. 回帖原样 prompt 内容的 `run_completed` 事件
3. 用于验证全链路，不消耗 token，不依赖网络
