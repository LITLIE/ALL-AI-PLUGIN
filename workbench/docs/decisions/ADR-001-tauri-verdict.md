# ADR-001: 内核与外壳解耦 —— Tauri 仅作可选发布外壳

## Status: Accepted (2026-08-31) — 总监代笔，待专家复核

## Background
用户倾向 Tauri 桌面壳；本机实测 Rust/cargo/rustup 全未安装、MSVC/Visual Studio 未安装，WebView2 151 已装。PM 实测进一步确认竞品 Jockey（Tauri+Rust+SolidJS）已占据"Tauri 多 agent 客户端"生态位，且本工作台的核心能力是 spawn 子进程 + 长连接 stdio 会话管理，与 GUI 框架无关。

公开资料核实（tauri.net.cn / codershandbook.com / psvmc.cn，2026-08 检索）：Windows 上 Tauri 2 需要 Microsoft C++ Build Tools（约 7 GB，安装 15–30 分钟）+ MSVC 工具链的 Rust（磁盘合计 2–5 GB+，首次编译 3–10 分钟）+ WebView2（已满足）。

## Decision
**双轨架构：内核与外壳彻底解耦。**

1. **内核（MVP 唯一交付形态）**：Node 22 本地服务（HTTP + SSE，只监听 `127.0.0.1`）+ 静态 Web UI（前端产物由同一服务同源伺服）。运行时零 npm 依赖，`node core/server.mjs` 一条命令启动，浏览器打开即用。
2. **外壳（可选，M6 阶段）**：Tauri 2 仅作为发布形态包装——窗口加载内核 URL（或内嵌前端产物），通过 `shell/sidecar` 拉起内核进程、探活 `/api/health`、退出时回调关闭。外壳不实现任何业务逻辑，不使用 `invoke` 通道传递业务数据（业务数据只走 HTTP/SSE），保证"有没有外壳，产品行为完全一致"。
3. **裁决**：Tauri 属于"当前环境成本高"而非"完全不可行"。MVP 不阻塞；是否装 Rust 工具链（~7GB+）由用户在 M5 验收后决定。

## Consequences
- 正面：MVP 立即开工，零安装成本；跨平台（任何有 Node 22 + 浏览器的机器可跑）；调试直接用浏览器 DevTools；审计面小（本地 HTTP）。
- 负面：无桌面图标/系统托盘等原生集成（M6 补）；用户需手动开浏览器（M6 补）；Tauri 阶段仍需一次性环境安装。
- 拒绝的替代：Electron（体积与依赖重，且内核形态下无增益）；Tauri 直上（阻塞 MVP，且其 shell 插件权限模型对"spawn 任意 agent + 长连接 stdio"并无增益，反而要逐项配 capability）。

## Related ADRs: ADR-002（执行引擎）、ADR-003（验收与回滚）
