# UIUX — AgentWorkbench（深色优先）

> v1.0 · 2026-08-31 · 总监代笔（待专家复核）· 遵守 P0：无 emoji 图标 / 无紫粉渐变 / 无硬编码色 / 无弹跳缓动 / 无空洞占位文案

## 1. 设计原则

1. **信息密度优先于装饰**：工具型工作台，首屏即数据（Agent 状态 + 运行中的任务），无 Hero、无插画。
2. **状态一眼可辨**：任何节点 3 米外可读状态（颜色 + 图标 + 文字三重编码，不依赖单一通道）。
3. **危险操作永远有两步**：确认弹窗必须复述具体对象（命令/路径），绝不复用普通弹窗样式。
4. **审计即界面**：时间线不是隐藏页，是任务详情的默认 Tab。

## 2. Design Token（深色为一等公民；CSS 变量 + JSON 双源，禁止硬编码）

```css
:root {
  /* 表面（深色阶梯） */
  --bg-root:#0B0E14; --bg-panel:#11151D; --bg-panel-2:#161B26; --bg-hover:#1C2330;
  --border-1:#1E242E; --border-2:#2A3242;
  /* 文本 */
  --text-1:#E6EAF2; --text-2:#8B93A7; --text-3:#5A6377;
  /* 品牌：靛蓝纯色（无渐变） */
  --accent:#5B7CFA; --accent-dim:#3D4E8F; --accent-text:#A9BCFF;
  /* 状态语义色 */
  --st-idle:#8B93A7; --st-running:#5B9DF8; --st-success:#3FB68B; --st-failed:#E5646E;
  --st-blocked:#E0A458; --st-approval:#E0A458; --st-review:#9D7BEA;
  /* diff（开发者惯例：绿增红删） */
  --diff-add-bg:#12271C; --diff-add-fg:#4ADE9C; --diff-del-bg:#2C161B; --diff-del-fg:#F0848D;
  /* 字体 */
  --font-ui:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  --font-mono:"Cascadia Code","JetBrains Mono",Consolas,monospace;
  /* 间距 / 圆角 / 动效 */
  --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-6:24px;
  --r-1:4px; --r-2:8px;
  --dur-1:120ms; --dur-2:200ms; --ease:cubic-bezier(0.2,0,0,1);
  /* 层级 */
  --z-panel:100; --z-dialog:200; --z-toast:300;
}
```

浅色主题映射：`--bg-root:#F5F7FA; --bg-panel:#FFFFFF; --text-1:#1A2233; --border-1:#E3E8F0;` 状态色不变（对比度已达标）。对比度：全部文本/状态色对各自底色 ≥ 4.5:1（WCAG AA）。

## 3. 状态色语义表（全项目唯一映射，禁止自造）

| 状态 | 变量 | 图标语义（Lucide 名） |
|---|---|---|
| idle 待命 | --st-idle | circle-dashed |
| running 执行中 | --st-running | loader-circle（旋转） |
| awaiting-approval 待审批 | --st-approval | shield-alert |
| awaiting-review 待验收 | --st-review | eye |
| success 成功 | --st-success | check |
| failed 失败 | --st-failed | x |
| blocked 阻塞 | --st-blocked | octagon-pause |
| rolled-back 已回滚 | --st-idle | undo-2 |

## 4. 图标系统锁定

**锁定 Lucide（ISC License，统一 2px 描边）**——以 Lucide 为例（示例，非指定；规则是"全项目锁定一套、统一描边、可矢量缩放、禁止 emoji"）。实现方式：`ui/icons.mjs` 内联本项目实际用到的 SVG 子集（约 40 枚），三档尺寸 16/20/24px（行内/按钮/独立），`stroke-width=2` 不可改。本项目图标清单（节选）：play、square-x、rotate-ccw（重派）、check、x、eye、shield-alert、octagon-pause、undo-2、loader-circle、terminal、git-branch、file-diff、scroll-text（审计）、copy、clipboard-paste、settings、plug（注册）、user（人工桥接）、alert-triangle、search、pause、clock、coins（成本）、chevron-right。

## 5. 信息架构（五屏）

```
┌────────────┬──────────────────────────────────────┬───────────────┐
│ 左栏 220px │           中央工作区（hash 路由）        │ 右栏 320px    │
│            │                                       │               │
│ ▸ 总览      │  ① /overview  Agent 卡片网格           │ 上下文面板：   │
│ ▸ 任务看板  │  ② /board     任务看板（列=状态）        │ 选中对象的     │
│ ▸ 审阅      │  ③ /logs      实时日志流                │ 详情/操作/     │
│ ▸ 审计      │  ④ /diff      变更对比审阅              │ 事件流        │
│ ▸ 设置      │  ⑤ /audit     审计时间线+回放           │               │
│            │                                       │               │
│ 状态点：服务 │  全局顶栏：服务健康点 · 当前目录 · 脱敏开关 │ 审批弹窗层叠  │
└────────────┴──────────────────────────────────────┴───────────────┘
```

- **总览**：AgentCard 网格（名称/厂商/adapter 类型徽标/能力标签/风险等级徽标/健康状态/当前 run/探活按钮）。空状态文案："还没有注册 Agent —— 把 `agents/echo.json` 复制改一个 command，刷新即生效"。
- **看板**：列 = `ready / running / awaiting-review / blocked / done`；TaskNode 卡片（标题、选中 Agent、步骤进度、耗时、scope 徽标）；并行关系用分组底色表达，M5 不画 DAG 连线（避免过度工程）。
- **日志流**：LogStream = 虚拟滚动 + 级别着色 + 关键字过滤 + "跟随滚动"开关（用户上滚即暂停跟随，底部浮标恢复）+ 单 run / 单任务视图切换；SSE 断线顶部黄条提示并自动补齐。
- **审阅**：DiffViewer = 文件树（增/删/改角标 + 并行重叠文件高亮）+ unified diff 双栏着色 + 预检结果（测试/构建，通过/失败各一行）+ 底部操作条：通过（主按钮）/ 驳回 / 重新分派（次按钮）；maker=checker 时按钮禁用并解释原因。
- **审计**：AuditTimeline（图标 + 操作者 + 动作 + 对象 + 时间，可按任务/Agent/事件类型过滤）+ "回放"按钮逐条步进重建状态。
- **BridgePanel**（人工桥接）：briefing 一键复制（大按钮，复制后按钮态"已复制，去 Trae 里执行"）→ 回执粘贴框（Markdown）→ 提交即回帖并标 untrusted。

## 6. 高风险确认弹窗（独立组件 ConfirmDanger，不复用普通弹窗）

触发即暂停 run（`awaiting-approval`）。内容必须包含：触发 Agent 名、**完整命令原文**（等宽字体块）、影响路径、倒计时 120s 进度条。按钮：`允许执行`（主按钮，红色描边非实心）/ `拒绝`（普通）。文案模板："Codex 请求执行以下命令，未在 120 秒内选择将默认拒绝。" 视觉上与系统内其他弹窗共享骨架但强制红色描边 + 左侧 alert-triangle 图标，杜绝无脑点确认。

## 7. 组件清单与 5 态覆盖

组件（M5 交付面）：AgentCard、StatusPill、TaskNode、CapabilityTag、RiskBadge、LogStream、DiffViewer、FileTree、ConfirmDanger、AuditTimeline、BridgePanel、MetricStrip（P1 成本条）。每组件 5 态齐备：Loading（骨架屏 + 预计时长）、Empty（真实引导文案，禁 "Welcome"）、Error（分类：网络/权限/模型 + 重试入口）、Populated（数据 + 操作）、Edge（超长输出截断展开、空 diff、0 字节日志）。动效仅两处：状态色过渡 200ms、面板进出场 120ms；缓动统一 `--ease`，禁止弹跳曲线。
