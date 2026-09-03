// ui/app.mjs — 状态机驱动的 SPA 路由（零框架）
// 视图：home / agents / tasks / task/:id / logs / review / audit / settings
// 状态：{ view, agents[], tasks[], selectedTask, events[], busSeq, dialog } 全局单例

import { setupIcons } from './icons.mjs';

const API = ''; // 走 HTTP 服务，同源
const CLIENT_CONFIG = globalThis.__AWB_CONFIG || {};
const DEFAULT_PORT = CLIENT_CONFIG.port || '7788';
const AGENTS_DIR = CLIENT_CONFIG.agentsDir || 'agents';
const STORE_DIR = CLIENT_CONFIG.store || '.agentbus';

// ── Global state ────────────────────────────────────────────
const S = {
  view: 'home',
  params: {},
  agents: [],
  tasks: [],
  selectedTask: null,
  selectedRun: null,
  events: [],
  busSeq: 0,
  logBuffer: [],
  loading: false,
  dialog: null,
  bridgeSubmitting: false,
  bridgeError: null,
  sseDisconnected: false,
  reviewError: null,
  discovery: { candidates: [], loading: false, error: null },
  selectedDiscovery: null,
  discoveryError: null,
};

// ── Init ────────────────────────────────────────────────────
async function init() {
  setupIcons();
  window._state = S;
  await loadAgents();
  await loadTasks();
  startSSE();
  navigate('home');
}

async function loadAgents() {
  try {
    const r = await fetch(`${API}/api/agents`);
    const d = await r.json();
    S.agents = d.agents || [];
  } catch { S.agents = []; }
  render();
}

async function probeAgents() {
  try { await fetch(`${API}/api/agents/probe`, { method: 'POST' }); } catch { /* refresh below remains available */ }
  await loadAgents();
}

async function loadDiscovery() {
  S.discovery = { ...S.discovery, loading: true, error: null };
  render();
  try {
    const r = await fetch(`${API}/api/agents/discover`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.message || d.error || '发现 Agent 失败');
    S.discovery = { candidates: d.candidates || [], loading: false, error: null };
  } catch (error) {
    S.discovery = { ...S.discovery, loading: false, error: error.message || '发现 Agent 失败' };
  }
  render();
}

function selectDiscovery(id) {
  S.selectedDiscovery = S.discovery.candidates.find(candidate => candidate.id === id) || null;
  S.discoveryError = null;
  render();
}

async function importDiscovery() {
  const candidate = S.selectedDiscovery;
  if (!candidate?.configDraft) return;
  const configText = getDiscoveryConfigFromForm();
  const fileName = document.getElementById('discovery-file')?.value || undefined;
  if (!configText) {
    S.discoveryError = '配置草稿不是有效 JSON';
    render();
    return;
  }
  const config = JSON.parse(configText);
  try {
    const response = await fetch(`${API}/api/agents/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, ...(fileName ? { fileName } : {}) }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || body.error || '导入 Agent 失败');
    S.selectedDiscovery = null;
    S.discoveryError = null;
    await loadAgents();
  } catch (error) {
    S.discoveryError = error.message || '导入 Agent 失败';
    render();
  }
}

const DISCOVERY_CAPABILITIES = ['read', 'write', 'refactor', 'analyze', 'test', 'review', 'design'];

function getDiscoveryConfigFromForm() {
  syncDiscoveryFormToJson();
  const text = document.getElementById('discovery-config')?.value || '';
  try { JSON.parse(text); return text; } catch { return ''; }
}

function syncDiscoveryFormToJson() {
  const textarea = document.getElementById('discovery-config');
  if (!textarea) return;
  let config;
  try { config = JSON.parse(textarea.value); } catch { config = { ...(S.selectedDiscovery?.configDraft || {}) }; }
  const displayName = document.getElementById('discovery-displayName')?.value;
  const command = document.getElementById('discovery-command')?.value;
  const args = document.getElementById('discovery-args')?.value;
  const risk = document.getElementById('discovery-risk')?.value;
  if (displayName !== undefined) config.displayName = displayName;
  if (command !== undefined) {
    if (command.trim()) config.command = command.trim();
    else delete config.command;
  }
  if (args !== undefined) {
    const values = args.split(/\r?\n|,/).map(value => value.trim()).filter(Boolean);
    if (values.length) config.args = values;
    else delete config.args;
  }
  if (risk) config.riskLevel = risk;
  const capabilities = Array.from(document.querySelectorAll('[data-discovery-capability]:checked')).map(input => input.value);
  if (capabilities.length) config.capabilityTags = capabilities;
  const enabled = document.getElementById('discovery-enabled');
  if (enabled) config.enabled = enabled.checked;
  textarea.value = JSON.stringify(config, null, 2);
  if (S.selectedDiscovery) S.selectedDiscovery.configDraft = config;
  const impact = document.getElementById('discovery-routing-impact');
  if (impact) impact.textContent = routingImpact(config, S.selectedDiscovery);
}

function syncDiscoveryJsonToForm() {
  const textarea = document.getElementById('discovery-config');
  if (!textarea) return;
  let config;
  try { config = JSON.parse(textarea.value); } catch { return; }
  const setValue = (id, value) => { const element = document.getElementById(id); if (element && value !== undefined) element.value = value; };
  setValue('discovery-displayName', config.displayName || '');
  setValue('discovery-command', config.command || '');
  setValue('discovery-args', Array.isArray(config.args) ? config.args.join('\n') : '');
  setValue('discovery-risk', config.riskLevel || 'read-only');
  const enabled = document.getElementById('discovery-enabled');
  if (enabled && config.enabled !== undefined) enabled.checked = config.enabled !== false;
  document.querySelectorAll('[data-discovery-capability]').forEach(input => {
    input.checked = Array.isArray(config.capabilityTags) && config.capabilityTags.includes(input.value);
  });
  const impact = document.getElementById('discovery-routing-impact');
  if (impact) impact.textContent = routingImpact(config, S.selectedDiscovery);
}

function routingImpact(draft, candidate) {
  if (draft.enabled === false) return '禁用：不会参与自动路由';
  if (candidate?.source !== 'known-gui' && candidate?.status !== 'available') return '待探活：导入后保持 unknown，不会参与自动路由';
  return `可匹配能力：${(draft.capabilityTags || []).join(', ') || '无'}`;
}

function renderDiscoveryEditor(state) {
  const candidate = state.selectedDiscovery;
  if (!candidate) return '';
  const draft = candidate.configDraft || {};
  const selectedCapabilities = new Set(draft.capabilityTags || []);
  return `
    <div class="card" style="border-color:var(--accent-dim)">
      <div class="card-title">配置草稿：${escHtml(candidate.displayName || candidate.id)}</div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">来源：${escHtml(candidate.source)} · 置信度：${escHtml(candidate.confidence)}。导入前请确认命令、权限和风险等级。</div>
      <div class="form-group"><label class="form-label">文件名</label><input class="form-input" id="discovery-file" value="${escHtml(`${candidate.id}.json`)}"></div>
      <div class="form-group"><label class="form-label">显示名称</label><input class="form-input" id="discovery-displayName" data-discovery-field value="${escHtml(draft.displayName || candidate.displayName || candidate.id)}"></div>
      <div class="form-group"><label class="form-label">命令</label><input class="form-input" id="discovery-command" data-discovery-field value="${escHtml(draft.command || '')}"></div>
      <div class="form-group"><label class="form-label">参数（每行一个）</label><textarea class="form-textarea" id="discovery-args" data-discovery-field rows="3">${escHtml(Array.isArray(draft.args) ? draft.args.join('\n') : '')}</textarea></div>
      <div class="form-group"><label class="form-label">风险等级</label><select class="form-select" id="discovery-risk" data-discovery-field>${['read-only', 'workspace-write', 'high-risk'].map(level => `<option value="${level}" ${draft.riskLevel === level ? 'selected' : ''}>${level}</option>`).join('')}</select></div>
      <div class="form-group"><span class="form-label" id="discovery-capabilities">能力标签</span><div style="display:flex;flex-wrap:wrap;gap:8px">${DISCOVERY_CAPABILITIES.map(tag => `<label style="font-size:12px;color:var(--text-secondary)"><input type="checkbox" data-discovery-capability value="${tag}" ${selectedCapabilities.has(tag) ? 'checked' : ''}> ${tag}</label>`).join('')}</div></div>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-secondary);margin-bottom:10px"><input type="checkbox" id="discovery-enabled" data-discovery-field ${draft.enabled !== false ? 'checked' : ''}> 启用配置</label>
      <div style="padding:10px;margin-bottom:10px;border:1px solid var(--border-default);border-radius:var(--radius-sm)"><div class="form-label">路由影响</div><div id="discovery-routing-impact" style="font-size:12px;color:var(--text-secondary);margin-top:4px">${escHtml(routingImpact(draft, candidate))}</div></div>
      <div class="form-group"><label class="form-label">高级 JSON 配置（与上方字段同步）</label><textarea class="form-textarea" id="discovery-config" rows="12">${escHtml(JSON.stringify(draft, null, 2))}</textarea></div>
      ${state.discoveryError ? `<div style="color:#fca5a5;font-size:12px;margin-bottom:8px">${escHtml(state.discoveryError)}</div>` : ''}
      <div class="flex gap-2">
        <button class="btn btn-primary" data-action="confirmDiscoveryImport"><span class="icon" data-icon="check"></span>确认导入</button>
        <button class="btn btn-ghost" data-action="clearDiscoverySelection">取消</button>
      </div>
    </div>
  `;
}

async function loadTasks() {
  try {
    const r = await fetch(`${API}/api/tasks`);
    const d = await r.json();
    S.tasks = d.tasks || [];
  } catch { S.tasks = []; }
  render();
}

// ── SSE ─────────────────────────────────────────────────────
let _es;
function startSSE() {
  if (_es) _es.close();
  _es = new EventSource(`${API}/api/events?since=${S.busSeq}`);
  _es.onopen = () => { S.sseDisconnected = false; render(); };
  _es.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.seq && ev.seq <= S.busSeq) return;
      S.events.push(ev);
      if (ev.seq) S.busSeq = ev.seq;

      const eventType = ev.payload?.type || ev.payload?.action;

      // 实时更新 agents / tasks 状态
      if (eventType === 'run.started' || eventType === 'run.completed' || eventType === 'run.failed'
        || eventType === 'run.awaiting-human' || eventType === 'run.briefing-ready'
        || eventType === 'bridge.requested' || eventType === 'bridge.submitted') {
        loadAgents(); loadTasks();
        if (S.selectedTask?.taskId) loadTaskDetail(S.selectedTask.taskId);
      }
      if (eventType === 'task.created') loadTasks();
      if (ev.kind === 'verdict') {
        loadTasks();
        if (S.selectedTask) loadTaskDetail(S.selectedTask.taskId);
      }
      // 日志行
      if (eventType === 'run.thinking' || eventType === 'run.stdout' || eventType === 'run.failed') {
        S.logBuffer.push({ ...ev, ts: ev.ts || Date.now() });
        if (S.logBuffer.length > 1000) S.logBuffer.shift();
        if (S.view === 'logs') render();
      }
      render();
    } catch {}
  };
  _es.onerror = () => {
    S.sseDisconnected = true;
    render();
    _es.close();
    setTimeout(startSSE, 3000); // 3s 重连
  };
}

// ── Router ───────────────────────────────────────────────────
export function navigate(view, params = {}) {
  S.view = view;
  S.params = params;
  S.dialog = null;
  if (view === 'task' && params.id) loadTaskDetail(params.id);
  if (view === 'review' && params.runId) loadRunReview(params.runId);
  if (view === 'logs' && params.runId) loadLogStream(params.runId);
  history.pushState({ view, params }, '', `#${view}${params.id ? '/' + encodeURIComponent(params.id) : ''}`);
  render();
  window.scrollTo(0, 0);
}
window.navigate = navigate;

window.addEventListener('popstate', (e) => {
  if (e.state) { S.view = e.state.view; S.params = e.state.params; render(); }
});

// ── Dialogs ───────────────────────────────────────────────────
function showConfirm({ title, body, danger = false, onConfirm, onCancel }) {
  S.dialog = { type: 'confirm', title, body, danger, onConfirm, onCancel };
  render();
}

// ── API calls ─────────────────────────────────────────────────
async function createTask(form) {
  const r = await fetch(`${API}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
  const d = await r.json();
  await loadTasks();
  navigate('task', { id: d.taskId });
}

async function dispatchTask(taskId, agentId) {
  const r = await fetch(`${API}/api/tasks/${encodeURIComponent(taskId)}/dispatch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId }) });
  return r.json();
}

async function interruptRun(runId) {
  await fetch(`${API}/api/runs/${encodeURIComponent(runId)}/interrupt`, { method: 'POST' });
  await loadTasks();
}

async function recordVerdict({ action, note }) {
  const verdicts = { approve: 'passed', reject: 'rejected', redispatch: 'rework' };
  await fetch(`${API}/api/runs/${encodeURIComponent(S.selectedRun)}/verdict`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verdict: verdicts[action], reviewerId: 'human', reason: note })
  });
  S.selectedRun = null;
  navigate('tasks');
}

async function submitBridgeReceipt(runId) {
  const receiptText = document.getElementById('bridge-receipt')?.value || '';
  S.bridgeSubmitting = true;
  S.bridgeError = null;
  render();
  try {
    const response = await fetch(`${API}/api/bridges/${encodeURIComponent(runId)}/submit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receiptText }),
    });
    const body = await response.json();
    if (!response.ok) {
      S.bridgeError = body.message || body.error || '回执提交失败';
      return;
    }
    S.bridgeError = null;
    if (S.selectedTask?.taskId) await loadTaskDetail(S.selectedTask.taskId);
  } catch (error) {
    S.bridgeError = error.message || '网络错误，请重试';
  } finally {
    S.bridgeSubmitting = false;
    render();
  }
}

async function copyBriefing(runId) {
  const run = S.selectedTask?.runs?.find(item => item.runId === runId);
  if (!run?.briefing || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    S.bridgeError = '当前环境不支持剪贴板，请手动复制 briefing';
    render();
    return;
  }
  try {
    await navigator.clipboard.writeText(run.briefing);
    S.bridgeError = 'briefing 已复制';
  } catch {
    S.bridgeError = '复制失败，请手动复制 briefing';
  }
  render();
}

async function runReviewAction(runId, action) {
  S.reviewError = null;
  try {
    const response = await fetch(`${API}/api/runs/${encodeURIComponent(runId)}/${action}`, { method: 'POST' });
    const body = await response.json();
    if (!response.ok) {
      S.reviewError = body.message || body.error || `${action} 失败`;
      return;
    }
    await loadRunReview(runId);
  } catch (error) {
    S.reviewError = error.message || '网络错误，请重试';
  }
  render();
}

async function loadTaskDetail(id) {
  const r = await fetch(`${API}/api/tasks/${encodeURIComponent(id)}`);
  const d = await r.json();
  S.selectedTask = d;
  render();
}

async function loadRunReview(runId) {
  const runResponse = await fetch(`${API}/api/runs/${encodeURIComponent(runId)}`);
  const run = await runResponse.json();
  S.selectedRun = runId;
  S._reviewData = { run };
  render();
}

async function loadLogStream(runId) {
  const r = await fetch(`${API}/api/bus/recent?since=0`);
  const d = await r.json();
  S.logBuffer = d.events?.filter((e) => e.runId === runId || e.payload?.runId === runId) || [];
  S.params.runId = runId;
  render();
}

// ── Render ────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');
  if (!app) return;
  const v = views[S.view] || views.home;
  app.innerHTML = v(S);
  attachListeners();
}

const views = {
  home: (S) => `
    ${shell(S, `
      <div class="section-header">
        <span class="section-title">概览</span>
      </div>
      <div class="metric-row">
        <div class="metric-card">
          <div class="metric-value">${S.agents.length}</div>
          <div class="metric-label">已注册 Agent</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">${S.tasks.length}</div>
          <div class="metric-label">任务</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">${S.tasks.filter(t => t.state === 'running').length}</div>
          <div class="metric-label">运行中</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">${S.tasks.filter(t => t.state === 'awaiting-review').length}</div>
          <div class="metric-label">待验收</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">${S.tasks.filter(t => t.state === 'passed').length}</div>
          <div class="metric-label">已通过</div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">快速开始</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <button class="btn btn-primary" data-action="navigate" data-view="agents">
            <span class="icon" data-icon="agent"></span> 注册 Agent
          </button>
          <button class="btn btn-primary" data-action="navigate" data-view="tasks">
            <span class="icon" data-icon="task"></span> 创建任务
          </button>
          <button class="btn btn-ghost" data-action="navigate" data-view="audit">
            <span class="icon" data-icon="audit"></span> 审计日志
          </button>
        </div>
      </div>
      ${S.agents.length === 0 ? `<div class="empty-state"><div class="icon" data-icon="agent"></div><h3>还没有注册 Agent</h3><p>添加 Echo 配置后即可开始本地验证。</p></div>` : ''}
    `)}
  `,

  agents: (S) => shell(S, `
    <div class="section-header">
      <span class="section-title">Agent 注册</span>
      <span class="section-subtitle">配置驱动，新增只改 JSON</span>
      <button class="btn btn-primary btn-sm" data-action="discoverAgents" style="margin-left:auto"><span class="icon" data-icon="search"></span>发现 Agent</button>
    </div>
    ${S.discovery.loading ? `<div class="card"><div class="card-title">正在发现 Agent…</div></div>` : ''}
    ${S.discovery.error ? `<div class="card" style="border-color:var(--status-failed);color:#fca5a5">${escHtml(S.discovery.error)}</div>` : ''}
    ${S.discovery.candidates.length ? `
      <div class="card">
        <div class="card-title">发现候选</div>
        <div class="agent-grid">
          ${S.discovery.candidates.map(candidate => `
            <div class="agent-card ${S.selectedDiscovery?.id === candidate.id ? 'selected' : ''}">
              <div class="agent-card-header">
                <span class="agent-card-name">${escHtml(candidate.displayName || candidate.id)}</span>
                <span class="pill ${candidate.status === 'available' ? 'success' : 'idle'}"><span class="dot"></span>${candidate.status === 'available' ? '可用' : escHtml(candidate.status || '未知')}</span>
              </div>
              <div class="agent-card-type">${escHtml(candidate.id)} · source=${escHtml(candidate.source || 'unknown')} · confidence=${escHtml(candidate.confidence || 'unknown')}</div>
              ${candidate.resolved ? `<div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis">${escHtml(candidate.resolved)}</div>` : ''}
              <button class="btn btn-ghost btn-sm" data-action="selectDiscovery" data-id="${escHtml(candidate.id)}">查看配置草稿</button>
            </div>
          `).join('')}
        </div>
      </div>
    ` : ''}
    ${S.selectedDiscovery ? renderDiscoveryEditor(S) : ''}
    <div class="agent-grid">
      ${S.agents.length === 0 ? `<div class="empty-state"><div class="icon" data-icon="agent"></div><h3>还没有注册 Agent</h3><p>在 agents/ 目录添加 JSON 配置文件。</p></div>` : ''}
      ${S.agents.map(a => `
        <div class="agent-card">
          <div class="agent-card-header">
            <span class="agent-card-name">${escHtml(a.displayName || a.id)}</span>
            <span class="pill ${agentStatusPill(a)}">
              <span class="dot"></span>${agentStatusLabel(a)}
            </span>
          </div>
          <div class="agent-card-type">${escHtml(a.type)} · ${escHtml(a.id)}</div>
          <div class="agent-card-tags">
            ${(a.capabilityTags || []).map(t => `<span class="tag">${escHtml(t)}</span>`).join('')}
          </div>
          ${a.version ? `<div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">${escHtml(a.version)}</div>` : ''}
          ${a.riskLevel ? `<div style="font-size:11px;color:${a.riskLevel === 'high-risk' ? 'var(--status-failed)' : a.riskLevel === 'workspace-write' ? 'var(--status-waiting)' : 'var(--text-muted)'};">风险: ${a.riskLevel}</div>` : ''}
        </div>
      `).join('')}
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-title">添加新 Agent</div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">在 <code style="background:var(--bg-input);padding:2px 6px;border-radius:3px">workbench/agents/</code> 目录添加 JSON 文件，刷新页面即可见。</div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-ghost btn-sm" data-action="openAgentsDir">打开 agents 目录</button>
        <button class="btn btn-ghost btn-sm" data-action="probeAgents"><span class="icon" data-icon="rotate-ccw"></span>重新探活</button>
      </div>
    </div>
  `),

  tasks: (S) => shell(S, `
    <div class="section-header">
      <span class="section-title">任务看板</span>
      <span class="section-subtitle">${S.tasks.length} 个任务</span>
      <button class="btn btn-primary btn-sm" data-action="showCreateTask" style="margin-left:auto">+ 新建任务</button>
    </div>
    <div class="task-board">
      ${S.tasks.length === 0 ? `<div class="empty-state"><div class="icon" data-icon="task"></div><h3>还没有任务</h3><p>点击「新建任务」开始第一个派工。</p></div>` : ''}
      ${S.tasks.map(t => `
        <div class="task-row ${S.params.id === t.taskId ? 'selected' : ''}" data-action="navigate" data-view="task" data-id="${escHtml(t.taskId)}">
          <span class="task-id">${escHtml(t.taskId?.slice(0,8) || '')}</span>
          <span class="task-title">${escHtml(t.title || t.description || '无标题')}</span>
          <span class="pill ${statusPill(t.state)}"><span class="dot"></span>${statusLabel(t.state)}</span>
          <span class="task-meta">${t.agentId ? escHtml(t.agentId) : ''}</span>
          ${t.state === 'running' ? `<button class="btn btn-ghost btn-sm" data-action="interruptTask" data-id="${escHtml(t.taskId)}">中止</button>` : ''}
        </div>
      `).join('')}
    </div>
  `),

  'task/new': (S) => shell(S, `
    <div class="section-header">
      <span class="section-title">新建任务</span>
    </div>
    <div class="card" style="max-width:600px">
      <div class="form-group">
        <label class="form-label">任务标题</label>
        <input class="form-input" id="f-title" placeholder="例如：实现用户登录 API" autofocus>
      </div>
      <div class="form-group">
        <label class="form-label">任务描述（给 Agent 的 briefing）</label>
        <textarea class="form-textarea" id="f-desc" placeholder="详细描述任务目标、约束与验收标准..." rows="6"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">要求的能力标签（逗号分隔）</label>
        <input class="form-input" id="f-tags" placeholder="例如：write, refactor, test">
      </div>
      <div class="form-group">
        <label class="form-label">工作目录（绝对路径）</label>
        <input class="form-input" id="f-cwd" placeholder="例如：D:\\my-project" value="">
      </div>
      <div class="flex gap-2">
        <button class="btn btn-primary" data-action="doCreateTask">创建</button>
        <button class="btn btn-ghost" data-action="navigate" data-view="tasks">取消</button>
      </div>
    </div>
  `),

  task: (S) => {
    const t = S.selectedTask;
    if (!t) return shell(S, `<div class="empty-state"><p>加载中…</p></div>`);
    const bridgeRun = t.runs?.find(run => run.state === 'awaiting-human' || run.briefing);
    return shell(S, `
      <div class="section-header">
        <button class="btn btn-ghost btn-sm" data-action="navigate" data-view="tasks">← 任务列表</button>
        <span class="section-title" style="margin-left:8px">${escHtml(t.title || t.description?.slice(0,50) || '任务详情')}</span>
        <span class="pill ${statusPill(t.state)}" style="margin-left:8px"><span class="dot"></span>${statusLabel(t.state)}</span>
      </div>
      <div class="card">
        <div class="card-title">任务信息</div>
        <div style="display:grid;grid-template-columns:120px 1fr;gap:8px;font-size:12px;">
          <div style="color:var(--text-muted)">ID</div><div class="mono">${escHtml(t.taskId || '')}</div>
          <div style="color:var(--text-muted)">描述</div><div style="word-break:break-all">${escHtml(t.description || '-')}</div>
          <div style="color:var(--text-muted)">状态</div><div>${statusLabel(t.state || 'pending')}</div>
          <div style="color:var(--text-muted)">Agent</div><div>${escHtml(t.runs?.at(-1)?.agentId || '未派工')}</div>
          <div style="color:var(--text-muted)">创建</div><div>${t.createdAt ? new Date(t.createdAt).toLocaleString('zh-CN') : '-'}</div>
        </div>
      </div>
      ${bridgeRun ? `
        <div class="card bridge-panel">
          <div class="card-title"><span class="icon" data-icon="user"></span> 人工桥接</div>
          <div class="section-subtitle">${escHtml(bridgeRun.agentId || 'Human Bridge')} · ${statusLabel(bridgeRun.state)}</div>
          ${bridgeRun.briefing ? `<pre class="bridge-briefing">${escHtml(bridgeRun.briefing)}</pre>` : '<div class="empty-state">等待 briefing…</div>'}
          <div class="flex gap-2">
            <button class="btn btn-ghost btn-sm" data-action="copyBriefing" data-id="${escHtml(bridgeRun.runId)}"><span class="icon" data-icon="copy"></span>复制 briefing</button>
          </div>
          ${bridgeRun.state === 'awaiting-human' ? `
            <div class="form-group" style="margin-top:12px">
              <label class="form-label" for="bridge-receipt">粘贴人工回执</label>
              <textarea class="form-textarea" id="bridge-receipt" rows="6" placeholder="粘贴 Trae、WorkBuddy 或其他 GUI Agent 的执行结果"></textarea>
            </div>
            <button class="btn btn-primary" data-action="submitBridge" data-id="${escHtml(bridgeRun.runId)}" ${S.bridgeSubmitting ? 'disabled' : ''}>
              ${S.bridgeSubmitting ? '提交中…' : '提交回执'}
            </button>
            ${S.bridgeError ? `<div class="bridge-feedback">${escHtml(S.bridgeError)}</div>` : ''}
          ` : ''}
        </div>
      ` : ''}
      ${t.state === 'pending' ? `
        <div class="card">
          <div class="card-title">派工</div>
          <div style="display:flex;flex-direction:column;gap:8px;max-width:400px">
            <div class="form-group">
              <label class="form-label">选择 Agent</label>
              <select class="form-select" id="dispatch-agent">
                <option value="">自动（按能力标签匹配）</option>
                ${S.agents.filter(a => a.type === 'echo' && a.available).map(a => `<option value="${escHtml(a.id)}">${escHtml(a.displayName || a.id)} (${escHtml(a.type)})</option>`).join('')}
              </select>
            </div>
            <button class="btn btn-primary" data-action="doDispatch" data-id="${escHtml(t.taskId)}">分派</button>
          </div>
        </div>
      ` : ''}
      ${t.runs?.length ? `
        <div class="card">
          <div class="card-title">执行历史</div>
          <div style="display:flex;flex-direction:column;gap:6px">
            ${t.runs.map(run => {
              const runId = run.runId;
              return `
                <div style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--bg-base);border-radius:6px;font-size:12px">
                  <span class="mono" style="color:var(--text-muted)">${runId.slice(0,8)}</span>
                  <span>${escHtml(run.agentId || '')}</span>
                  ${run.state ? `<span class="pill ${statusPill(run.state)}"><span class="dot"></span>${statusLabel(run.state)}</span>` : ''}
                  <button class="btn btn-ghost btn-sm" data-action="navigate" data-view="review" data-run-id="${escHtml(runId)}">验收</button>
                  <button class="btn btn-ghost btn-sm" data-action="navigate" data-view="logs" data-run-id="${escHtml(runId)}">日志</button>
                  ${run.state === 'running' ? `<button class="btn btn-ghost btn-sm" data-action="interruptRun" data-id="${escHtml(runId)}">中止</button>` : ''}
                </div>
              `;
            }).join('')}
          </div>
        </div>
      ` : ''}
    `);
  },

  logs: (S) => shell(S, `
    <div class="section-header">
      <button class="btn btn-ghost btn-sm" data-action="navigate" data-view="tasks">← 返回</button>
      <span class="section-title" style="margin-left:8px">运行日志</span>
      <span class="section-subtitle">${S.params.runId?.slice(0,8) || ''}</span>
      <button class="btn btn-ghost btn-sm" data-action="clearLogs" style="margin-left:auto">清屏</button>
    </div>
    <div class="log-container" id="log-container" style="flex:1;height:auto">
      ${S.logBuffer.length === 0 ? `<div class="log-line dim">等待日志流…</div>` : ''}
      ${S.logBuffer.map(e => `
        <div class="log-line ${logClass(e.kind)}">
          <span class="ts">${new Date(e.ts || e.payload?.ts || 0).toLocaleTimeString('zh-CN')}</span>
          <span style="color:var(--accent)">[${escHtml(e.kind)}]</span>
          ${escHtml(typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload)?.slice(0,200))}
        </div>
      `).join('')}
    </div>
  `, /* no right panel */ true),

  review: (S) => {
    const d = S._reviewData;
    if (!d) return shell(S, `<div class="empty-state"><p>加载中…</p></div>`);
    const run = d.run || {};
    const diff = run.diff || {};
    const changeCount = (diff.added || []).length + (diff.modified || []).length + (diff.deleted || []).length;
    return shell(S, `
      <div class="section-header">
        <button class="btn btn-ghost btn-sm" data-action="navigate" data-view="tasks">← 返回</button>
        <span class="section-title" style="margin-left:8px">Run 验收</span>
      </div>
      <div class="card">
        <div class="card-title">Agent 输出</div>
        <div class="section-subtitle">${escHtml(run.agentId || '')} · ${statusLabel(run.state)}</div>
        <pre style="white-space:pre-wrap;word-break:break-word">${escHtml(run.text || run.error || '无输出')}</pre>
      </div>
      <div class="card">
        <div class="card-title"><span class="icon" data-icon="diff"></span>变更文件 (${changeCount})</div>
        ${changeCount === 0 ? '<div class="section-subtitle">此 Run 没有文件变更</div>' : `
          <div class="diff-summary">
            ${(diff.added || []).map(item => `<div class="diff-item added">+ ${escHtml(item.relPath)}</div>`).join('')}
            ${(diff.modified || []).map(item => `<div class="diff-item modified">~ ${escHtml(item.relPath)}</div>`).join('')}
            ${(diff.deleted || []).map(item => `<div class="diff-item deleted">- ${escHtml(item.relPath)}</div>`).join('')}
          </div>
        `}
      </div>
      <div class="flex gap-2">
        <button class="btn btn-primary" data-action="applyRun" data-id="${escHtml(run.runId || '')}" ${run.verdict === 'passed' && !run.appliedAt ? '' : 'disabled'}>应用变更</button>
        <button class="btn btn-ghost" data-action="rollbackRun" data-id="${escHtml(run.runId || '')}" ${run.appliedAt && !run.rolledBackAt ? '' : 'disabled'}>回滚</button>
        ${S.reviewError ? `<span class="bridge-feedback">${escHtml(S.reviewError)}</span>` : ''}
      </div>
      <div class="flex gap-2" style="margin-top:12px">
        <button class="btn btn-primary" data-action="doVerdict" data-action-type="approve">通过</button>
        <button class="btn btn-danger" data-action="doVerdict" data-action-type="reject">驳回</button>
        <button class="btn btn-ghost" data-action="doVerdict" data-action-type="redispatch">重新分派</button>
      </div>
      <div class="form-group" style="margin-top:12px">
        <label class="form-label">验收备注</label>
        <textarea class="form-textarea" id="verdict-note" rows="3" placeholder="可选：填写驳回/重新分派的原因，供下一个 Agent 参考…"></textarea>
      </div>
    `);
  },

  audit: (S) => shell(S, `
    <div class="section-header">
      <span class="section-title">审计日志</span>
      <span class="section-subtitle">事件总线可追溯</span>
      <button class="btn btn-ghost btn-sm" data-action="loadAudit" style="margin-left:auto">刷新</button>
    </div>
    <div class="audit-timeline" id="audit-timeline">
      ${S.events.slice(-50).reverse().map(e => `
        <div class="audit-item ${e.seq === S.busSeq ? 'latest' : ''}">
          <span class="audit-ts">${new Date(e.ts).toLocaleString('zh-CN')}</span>
          <span class="audit-kind">${escHtml(e.kind)}</span>
          ${e.payload ? `<span style="color:var(--text-muted);font-family:var(--font-mono);font-size:10px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(JSON.stringify(e.payload)?.slice(0,100))}</span>` : ''}
        </div>
      `).join('')}
    </div>
  `),

  settings: (S) => shell(S, `
    <div class="section-header"><span class="section-title">设置</span></div>
    <div class="card">
      <div class="card-title">工作台配置</div>
      <div class="form-group">
        <label class="form-label">总线目录（.agentbus/）</label>
            <input class="form-input" value="${escHtml(STORE_DIR)}" readonly style="opacity:.6">
      </div>
      <div class="form-group">
        <label class="form-label">Agent 配置目录</label>
            <input class="form-input" value="${escHtml(AGENTS_DIR)}" readonly style="opacity:.6">
      </div>
      <div class="form-group">
        <label class="form-label">服务端口</label>
            <input class="form-input" value="${escHtml(DEFAULT_PORT)}" readonly style="opacity:.6">
      </div>
    </div>
  `),
};

function shell(S, main, noRight = false) {
  const cls = noRight ? 'app-shell no-right' : 'app-shell';
  return `
    <header class="header">
      <span class="logo">AWB</span>
      <span class="tag">Workbench</span>
      <span class="spacer"></span>
          <span style="font-size:11px;color:var(--text-muted)">127.0.0.1:${escHtml(DEFAULT_PORT)}</span>
    </header>
    <nav class="nav-sidebar">
      <div class="nav-section">
        <div class="nav-label">导航</div>
        <button class="nav-item ${S.view === 'home' ? 'active' : ''}" data-action="navigate" data-view="home">
          <span class="icon" data-icon="home"></span> 概览
        </button>
        <button class="nav-item ${S.view === 'agents' ? 'active' : ''}" data-action="navigate" data-view="agents">
          <span class="icon" data-icon="agent"></span> Agent 注册
          ${S.agents.length ? `<span class="pill" style="margin-left:auto;font-size:10px;padding:1px 5px">${S.agents.length}</span>` : ''}
        </button>
        <button class="nav-item ${S.view === 'tasks' || S.view === 'task' || S.view === 'task/new' ? 'active' : ''}" data-action="navigate" data-view="tasks">
          <span class="icon" data-icon="task"></span> 任务看板
          ${S.tasks.length ? `<span class="pill" style="margin-left:auto;font-size:10px;padding:1px 5px">${S.tasks.length}</span>` : ''}
        </button>
        <button class="nav-item ${S.view === 'logs' ? 'active' : ''}" data-action="navigate" data-view="logs">
          <span class="icon" data-icon="logs"></span> 日志流
        </button>
        <button class="nav-item ${S.view === 'audit' ? 'active' : ''}" data-action="navigate" data-view="audit">
          <span class="icon" data-icon="audit"></span> 审计日志
        </button>
        <button class="nav-item ${S.view === 'settings' ? 'active' : ''}" data-action="navigate" data-view="settings">
          <span class="icon" data-icon="settings"></span> 设置
        </button>
      </div>
    </nav>
    <main class="main-content">${main}</main>
    ${!noRight ? `
    <aside class="right-panel">
      <div class="card-title" style="font-size:12px;color:var(--text-muted);margin-bottom:8px">实时事件流</div>
      ${S.events.slice(-20).reverse().map(e => `
        <div style="font-size:11px;padding:4px 0;border-bottom:1px solid var(--border-subtle)">
          <span style="color:var(--text-muted);font-family:var(--font-mono)">${e.seq}</span>
          <span style="color:var(--accent)"> ${escHtml(e.kind)}</span>
        </div>
      `).join('')}
    </aside>` : ''}
    ${S.dialog ? renderDialog(S.dialog) : ''}
  `;
}

function renderDialog(d) {
  if (d.type === 'confirm') {
    return `
      <div class="dialog-overlay">
        <div class="dialog">
          <div class="dialog-title">${escHtml(d.title)}</div>
          <div class="dialog-body">${typeof d.body === 'string' ? escHtml(d.body) : d.body}</div>
          <div class="dialog-actions">
            <button class="btn btn-ghost" data-action="closeDialog">取消</button>
            <button class="btn ${d.danger ? 'btn-danger' : 'btn-primary'}" data-action="doConfirm">确认</button>
          </div>
        </div>
      </div>
    `;
  }
  return '';
}

// ── Event handling ────────────────────────────────────────────
function attachListeners() {
  document.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', handleAction);
  });
  const discoveryConfig = document.getElementById('discovery-config');
  if (discoveryConfig) discoveryConfig.addEventListener('input', syncDiscoveryJsonToForm);
  document.querySelectorAll('[data-discovery-field], [data-discovery-capability]').forEach((el) => {
    el.addEventListener('input', syncDiscoveryFormToJson);
    el.addEventListener('change', syncDiscoveryFormToJson);
  });
  const lc = document.getElementById('log-container');
  if (lc) lc.scrollTop = lc.scrollHeight;
}

async function handleAction(e) {
  const el = e.currentTarget;
  const action = el.dataset.action;
  const view = el.dataset.view;
  const id = el.dataset.id;
  const runId = el.dataset.runId;
  const actionType = el.dataset.actionType;

  if (action === 'navigate' && view) return navigate(view, { id, runId });

  if (action === 'loadAgents') { await loadAgents(); return; }

  if (action === 'probeAgents') { await probeAgents(); return; }

  if (action === 'discoverAgents') { await loadDiscovery(); return; }

  if (action === 'selectDiscovery' && id) { selectDiscovery(id); return; }

  if (action === 'clearDiscoverySelection') {
    S.selectedDiscovery = null;
    S.discoveryError = null;
    render();
    return;
  }

  if (action === 'confirmDiscoveryImport') {
    const configText = getDiscoveryConfigFromForm();
    if (!configText) {
      S.discoveryError = '配置草稿不是有效 JSON';
      render();
      return;
    }
    const config = JSON.parse(configText);
    const summary = `Agent: ${config.displayName || config.id || '未命名'}\n命令: ${config.command || '无（内置或人工桥接）'}\n风险: ${config.riskLevel || '未设置'}\n能力: ${(config.capabilityTags || []).join(', ') || '无'}\n导入后仍需重新探活。`;
    showConfirm({
      title: '确认导入 Agent 配置？',
      body: summary,
      onConfirm: () => { void importDiscovery(); },
    });
    return;
  }

      if (action === 'openAgentsDir') {
        alert('请在服务器所在环境中打开 agents 目录：' + AGENTS_DIR);
        return;
      }

  if (action === 'showCreateTask') return navigate('task/new');

  if (action === 'doCreateTask') {
    const title = document.getElementById('f-title')?.value || '';
    const description = document.getElementById('f-desc')?.value || '';
    const tags = (document.getElementById('f-tags')?.value || '').split(',').map(s => s.trim()).filter(Boolean);
    const cwd = document.getElementById('f-cwd')?.value || '';
    if (!title) return alert('请填写任务标题');
    await createTask({ title, description, requiredTags: tags, cwd });
    return;
  }

  if (action === 'doDispatch') {
    const agentId = document.getElementById('dispatch-agent')?.value || '';
    if (!id) return;
    const r = await dispatchTask(id, agentId || undefined);
    if (r.error) alert('分派失败：' + r.error);
    else { await loadTasks(); navigate('tasks'); }
    return;
  }

  if (action === 'interruptTask' && id) {
    e.stopPropagation();
    // 从 task 找 runId
    const t = S.tasks.find(tt => tt.taskId === id);
    if (t?.assignedRuns?.[0]) await interruptRun(t.assignedRuns[0]);
    return;
  }

  if (action === 'interruptRun' && id) { await interruptRun(id); return; }

  if (action === 'copyBriefing' && id) { await copyBriefing(id); return; }

  if (action === 'submitBridge' && id) { await submitBridgeReceipt(id); return; }

  if (action === 'applyRun' && id) { await runReviewAction(id, 'apply'); return; }

  if (action === 'rollbackRun' && id) { await runReviewAction(id, 'rollback'); return; }

  if (action === 'doVerdict' && actionType) {
    const note = document.getElementById('verdict-note')?.value || '';
    await recordVerdict({ action: actionType, note });
    return;
  }

  if (action === 'doConfirm') {
    const d = S.dialog;
    if (d?.onConfirm) d.onConfirm();
    S.dialog = null;
    render();
    return;
  }

  if (action === 'closeDialog') {
    const d = S.dialog;
    if (d?.onCancel) d.onCancel();
    S.dialog = null;
    render();
    return;
  }

  if (action === 'clearLogs') { S.logBuffer = []; render(); return; }

  if (action === 'loadAudit') { render(); return; }
}

// ── Helpers ───────────────────────────────────────────────────
function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function agentStatusLabel(agent) {
  const status = agent.probe?.status || (agent.available ? 'available' : 'unknown');
  return { available: '就绪', unavailable: '不可用', unknown: '未探活' }[status] || status;
}

function agentStatusPill(agent) {
  const status = agent.probe?.status || (agent.available ? 'available' : 'unknown');
  return { available: 'success', unavailable: 'idle', unknown: 'waiting' }[status] || 'idle';
}

function statusLabel(s) {
  const m = { pending:'待派工', ready:'就绪', running:'运行中', completed:'完成', failed:'失败', timeout:'超时', interrupted:'已中止', 'awaiting-human':'等待人工', 'awaiting-review':'待验收', passed:'已通过', rejected:'已驳回', rework:'待返工', blocked:'阻塞' };
  return m[s] || s || '未知';
}

function statusPill(s) {
  const m = { pending:'idle', ready:'idle', running:'running', completed:'success', failed:'failed', timeout:'failed', interrupted:'failed', 'awaiting-human':'waiting', 'awaiting-review':'review', passed:'success', rejected:'failed', rework:'waiting', blocked:'failed' };
  return m[s] || 'idle';
}

function logClass(kind) {
  if (kind === 'run_error' || kind === 'stderr') return 'err';
  if (kind === 'run_completed') return 'ok';
  return 'info';
}

// ── Boot ─────────────────────────────────────────────────────
init();
