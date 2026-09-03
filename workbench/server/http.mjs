// server/http.mjs — HTTP + SSE 服务（仅监听 127.0.0.1，零框架，零 npm 依赖）

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { EventBus } from '../core/bus.mjs';
import { AgentRegistry } from '../core/registry.mjs';
import { Orchestrator } from '../core/orchestrator.mjs';
import { aggregateMetrics } from '../core/metrics.mjs';
import { sseHandler } from './sse.mjs';
import { discoverAgents } from '../../shared/agent-runtime/discovery.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = resolve(__dirname, '..', 'ui');
const STORE_DIR = process.env.AWB_STORE || resolve(process.cwd(), '.awb');
const TASK_ID_PATTERN = /^task-[A-Za-z0-9][A-Za-z0-9_-]{0,126}$/;
const RUN_ID_PATTERN = /^run-[A-Za-z0-9][A-Za-z0-9_-]{0,126}$/;
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * 启动工作台服务
 * @param {Object} options
 * @param {string} options.host — 默认 '127.0.0.1'
 * @param {number} options.port — 默认 7788
 * @param {string} options.agentsDir — 默认 ./agents
 * @returns {Promise<{ server, bus, registry, orchestrator, url }>}
 */
export async function startServer({ host = '127.0.0.1', port = 7788, agentsDir, discoveryOptions = {} } = {}) {
  if (host !== '127.0.0.1') {
    throw new Error('HTTP server only supports loopback host 127.0.0.1');
  }
  // 初始化核心组件
  const bus = new EventBus(resolve(STORE_DIR, 'eventbus'));
  await bus.init();

  const registry = new AgentRegistry(agentsDir);
  registry.load();
  await registry.probeAll();

  const orchestrator = new Orchestrator(bus, registry);
  await orchestrator.replay();

  // 写启动事件
  await bus.append('system', { action: 'workbench.started', port, host, agents: registry.listAll().length }, { agentId: 'workbench' });

  // HTTP 服务
  const server = createServer((req, res) => {
      handleRequest(req, res, { bus, registry, orchestrator, discoveryOptions }).catch(error => {
      if (!res.headersSent) {
        const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        send(res, statusCode, {
          error: error?.code || (statusCode === 500 ? 'internal_error' : 'request_failed'),
          message: error?.message || String(error),
        });
      }
      else res.destroy(error);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      const url = `http://${host}:${actualPort}`;
      console.log(`[workbench] Web UI: ${url}`);
      console.log(`[workbench] API: ${url}/api/agents | /api/tasks | /api/events`);
      console.log(`[workbench] Store: ${STORE_DIR}`);
      console.log(`[workbench] Agents: ${registry.listAll().map(a => a.id).join(', ')}`);

      // 优雅关闭
      const onSignal = () => { void shutdown(server, bus); };
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      server.once('close', () => {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      });

      resolve({ server, bus, registry, orchestrator, url });
    });
  });
}

async function shutdown(server, bus) {
  console.log('\n[workbench] Shutting down...');
  await bus.append('system', { action: 'workbench.shutdown' }, { agentId: 'workbench' });
  await new Promise(resolve => server.close(resolve));
  await bus.close();
}

/**
 * HTTP 请求路由
 * /api/agents                  GET — 列出所有 agent
 * /api/agents/discover         GET — 只读发现本地 Agent
 * /api/agents/import           POST — 显式导入 Agent 配置草稿
 * /api/agents/probe            POST — 重新探测所有 agent
 * /api/tasks                   GET — 列出所有任务
 * /api/tasks                   POST — 创建任务
 * /api/tasks/:taskId/dispatch  POST — 派发任务
 * /api/runs/:runId             GET — 获取 run 状态
 * /api/runs/:runId/interrupt   POST — 中断 run
 * /api/runs/:runId/verdict     POST — 提交验收
 * /api/events                  GET — SSE 事件流
 * /api/audit                   GET — 验证审计完整性
 * /api/metrics                 GET — 聚合生命周期指标
 * /api/health                  GET — 健康检查
 * /                             GET — 静态 UI
 */
async function handleRequest(req, res, ctx) {
  const host = req.headers.host?.toLowerCase();
  if (!isAllowedHost(req, host)) {
    send(res, 403, { error: 'invalid_host' });
    return;
  }

  const { url, method } = req;
  const path = url.split('?')[0];

  const origin = req.headers.origin;
  if (MUTATION_METHODS.has(method) && origin && origin !== `http://${host}`) {
    send(res, 403, { error: 'invalid_origin' });
    return;
  }

  // ── API 路由 ──────────────────────────────────────────────
  if (path === '/api/health') return send(res, 200, { ok: true, ts: Date.now() });

  if (path === '/api/agents' && method === 'GET') {
    return send(res, 200, { agents: ctx.registry.listAll() });
  }
  if (path === '/api/agents/discover' && method === 'GET') {
    const query = new URL(url, 'http://localhost').searchParams;
    const rawCommands = query.get('commands');
    const commands = rawCommands === null
      ? undefined
      : rawCommands.split(',').map(value => value.trim()).filter(Boolean);
    if (rawCommands !== null && (!commands.length || commands.some(value => !/^[a-z0-9][a-z0-9-]*$/i.test(value)))) {
      return send(res, 400, { error: 'invalid_commands' });
    }
    const result = await discoverAgents({
      ...ctx.discoveryOptions,
      ...(commands ? { commands } : {}),
    });
    return send(res, 200, result);
  }
  if (path === '/api/agents/import' && method === 'POST') {
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !body.config || typeof body.config !== 'object' || Array.isArray(body.config)) {
      return send(res, 400, { error: 'invalid_import_body' });
    }
    try {
      const imported = ctx.registry.importConfig(body.config, body.fileName);
      return send(res, 201, imported);
    } catch (error) {
      const statusCode = error.code === 'duplicate_agent_id' || error.code === 'config_exists' ? 409
        : (error.code === 'invalid_config' || error.code === 'invalid_filename' ? 400 : 500);
      return send(res, statusCode, { error: error.code || 'import_failed', message: error.message, ...(error.errors ? { errors: error.errors } : {}) });
    }
  }
  if (path === '/api/agents/probe' && method === 'POST') {
    const results = await ctx.registry.probeAll();
    return send(res, 200, { results });
  }

  if (path === '/api/tasks' && method === 'GET') {
    const tasks = Array.from(ctx.orchestrator.tasks.values());
    return send(res, 200, { tasks });
  }
  if (path === '/api/tasks' && method === 'POST') {
    const body = await readBody(req);
    const taskId = Object.hasOwn(body, 'taskId') ? body.taskId : makeTaskId();
    if (!isValidTaskId(taskId)) {
      return send(res, 400, { error: 'invalid_task_id' });
    }
    if (ctx.orchestrator.tasks.has(taskId)) {
      return send(res, 409, { error: 'task_exists' });
    }
    const task = await ctx.orchestrator.createTask({
      ...body,
      taskId,
      description: body.description || body.title || '',
    });
    return send(res, 201, task);
  }

  const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch && method === 'GET') {
    if (!isValidTaskId(taskMatch[1])) return send(res, 400, { error: 'invalid_task_id' });
    const task = ctx.orchestrator.getTaskSnapshot(taskMatch[1]);
    return task ? send(res, 200, task) : send(res, 404, { error: 'Task not found' });
  }

  const decomposeMatch = path.match(/^\/api\/tasks\/([^/]+)\/decompose$/);
  if (decomposeMatch && method === 'POST') {
    const taskId = decomposeMatch[1];
    if (!isValidTaskId(taskId)) return send(res, 400, { error: 'invalid_task_id' });
    const body = await readBody(req);
    if (typeof body.plannerAgentId !== 'string' || body.plannerAgentId.trim() === '') {
      return send(res, 400, { error: 'planner_required' });
    }
    const result = await ctx.orchestrator.decomposeTask(taskId, body.plannerAgentId, body.prompt);
    return send(res, 201, result);
  }

  const graphRunMatch = path.match(/^\/api\/tasks\/([^/]+)\/run$/);
  if (graphRunMatch && method === 'POST') {
    const taskId = graphRunMatch[1];
    if (!isValidTaskId(taskId)) return send(res, 400, { error: 'invalid_task_id' });
    const body = await readBody(req);
    const maxParallel = body.maxParallel === undefined ? 4 : Number(body.maxParallel);
    if (!Number.isInteger(maxParallel) || maxParallel <= 0) return send(res, 400, { error: 'invalid_max_parallel' });
    if (body.continueOnFailure !== undefined && typeof body.continueOnFailure !== 'boolean') {
      return send(res, 400, { error: 'invalid_continue_on_failure' });
    }
    const result = await ctx.orchestrator.runTaskGraph(taskId, {
      maxParallel,
      continueOnFailure: body.continueOnFailure === true,
    });
    return send(res, 200, result);
  }

  // /api/tasks/:taskId/dispatch
  const dispatchMatch = path.match(/^\/api\/tasks\/([^/]+)\/dispatch$/);
  if (dispatchMatch && method === 'POST') {
    const taskId = dispatchMatch[1];
    if (!isValidTaskId(taskId)) return send(res, 400, { error: 'invalid_task_id' });
    const body = await readBody(req);
    const task = ctx.orchestrator.tasks.get(taskId);
    if (!task) return send(res, 404, { error: 'Task not found' });

    const selection = body.agentId
      ? selectExplicitAgent(ctx.registry, body.agentId)
      : ctx.orchestrator.selectAgent(task);
    if (!selection.ok) return send(res, 400, { error: selection.reason, missingTags: selection.missingTags });

    const run = await ctx.orchestrator.dispatch(taskId, selection.agent.id, body.prompt || task.description);
    // Inline Execution returns a terminal Run so callers can immediately inspect
    // lifecycle metrics and snapshots without racing the adapter stream.
    const terminalRun = await ctx.orchestrator.waitForRun(run.runId);
    return send(res, 201, terminalRun);
  }

  const runMatch = path.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch && method === 'GET') {
    const run = ctx.orchestrator.runs.get(runMatch[1]);
    return run ? send(res, 200, run) : send(res, 404, { error: 'Run not found' });
  }

  // /api/runs/:runId/interrupt
  const interruptMatch = path.match(/^\/api\/runs\/([^/]+)\/interrupt$/);
  if (interruptMatch && method === 'POST') {
    const result = await ctx.orchestrator.interrupt(interruptMatch[1]);
    return send(res, 200, result);
  }

  // /api/runs/:runId/verdict
  const verdictMatch = path.match(/^\/api\/runs\/([^/]+)\/verdict$/);
  if (verdictMatch && method === 'POST') {
    const body = await readBody(req);
    const { verdict, reviewerId, reason } = body;
    const result = await ctx.orchestrator.submitVerdict(verdictMatch[1], verdict, reviewerId, reason);
    return send(res, 200, result);
  }

  // /api/approval
  if (path === '/api/approval' && method === 'POST') {
    const body = await readBody(req);
    const result = await ctx.orchestrator.submitApproval(
      body.taskId,
      body.decision,
      body.reviewerId,
      body.agentId,
      body.reason,
    );
    return send(res, 200, result);
  }

  // Run diff/apply/rollback surfaces delegate to the event-sourced orchestrator.
  const applyMatch = path.match(/^\/api\/runs\/([^/]+)\/apply$/);
  if (applyMatch && method === 'POST') {
    const result = await ctx.orchestrator.apply(applyMatch[1]);
    return send(res, result.status || (result.ok ? 200 : 409), result);
  }

  const rollbackMatch = path.match(/^\/api\/runs\/([^/]+)\/rollback$/);
  if (rollbackMatch && method === 'POST') {
    const result = await ctx.orchestrator.rollback(rollbackMatch[1]);
    return send(res, result.status || (result.ok ? 200 : 409), result);
  }

  const diffMatch = path.match(/^\/api\/runs\/([^/]+)\/diff$/);
  if (diffMatch && method === 'GET') {
    const run = ctx.orchestrator.runs.get(diffMatch[1]);
    if (!run) return send(res, 404, { ok: false, error: 'run_not_found' });
    if (!run.diff) return send(res, 409, { ok: false, error: 'diff_unavailable' });
    return send(res, 200, { ok: true, runId: run.runId, diff: run.diff });
  }

  // /api/events — SSE
  if (path === '/api/events' && method === 'GET') {
    return sseHandler(req, res, ctx.bus);
  }

  // /api/audit
  if (path === '/api/audit' && method === 'GET') {
    const integrity = await ctx.bus.integrityCheck();
    const all = await ctx.bus.readAll();
    const lastSeq = all.length > 0 ? all[all.length - 1].seq : 0;
    return send(res, 200, { integrity, lastSeq, total: all.length });
  }

  // /api/metrics — 聚合 metric 事件，默认最近一小时
  if (path === '/api/metrics' && method === 'GET') {
    const query = new URL(url, 'http://localhost').searchParams;
    const rawWindow = query.get('windowMs');
    const windowMs = rawWindow === null ? 3600000 : Number(rawWindow);
    if (!Number.isInteger(windowMs) || windowMs <= 0) {
      return send(res, 400, { error: 'invalid_window', message: 'windowMs must be a positive integer' });
    }
    const events = await ctx.bus.readAll();
    return send(res, 200, {
      ok: true,
      windowMs,
      metrics: aggregateMetrics(events, { sinceMs: windowMs }),
    });
  }

  // /api/bus/recent — 拉取最近事件
  if (path === '/api/bus/recent' && method === 'GET') {
    const since = parseInt(new URL(url, 'http://localhost').searchParams.get('since') || '0');
    const events = (await ctx.bus.readFrom(since + 1)).filter(event => event.seq > since);
    return send(res, 200, { events: events.slice(-100) });
  }

  // /api/bridges/:bridgeId/submit
  const bridgeMatch = path.match(/^\/api\/bridges\/([^/]+)\/submit$/);
  if (bridgeMatch && method === 'POST') {
    const runId = bridgeMatch[1];
    if (!isValidRunId(runId)) return send(res, 400, { error: 'invalid_run_id' });
    const body = await readBody(req);
    const result = await ctx.orchestrator.submitBridgeReceipt(runId, body.receiptText);
    return send(res, 200, result.run);
  }

  // ── 静态 UI ──────────────────────────────────────────────
  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    return serveStatic(res, resolve(UI_DIR, 'index.html'), 'text/html; charset=utf-8');
  }
  if (method === 'GET') {
    const filePath = resolveUiPath(path);
    if (filePath && existsSync(filePath)) {
      const ext = extname(filePath);
      const mime = MIME[ext] || 'application/octet-stream';
      return serveStatic(res, filePath, mime);
    }
  }

  // 404
  send(res, 404, { error: 'not found', path });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function makeTaskId() {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function isValidTaskId(taskId) {
  return typeof taskId === 'string' && TASK_ID_PATTERN.test(taskId);
}

function isValidRunId(runId) {
  return typeof runId === 'string' && RUN_ID_PATTERN.test(runId);
}

function isAllowedHost(req, host) {
  if (!host) return false;
  const port = req.socket.localPort;
  const allowed = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
  ]);
  if (port === 80) {
    allowed.add('127.0.0.1');
    allowed.add('localhost');
  }
  return allowed.has(host);
}

function selectExplicitAgent(registry, agentId) {
  const agent = registry.listAll().find(candidate => candidate.id === agentId);
  if (!agent) return { ok: false, reason: `Agent not found: ${agentId}` };
  if (!agent.enabled) return { ok: false, reason: `Agent is disabled: ${agentId}` };
  if (!agent.type) return { ok: false, reason: `Agent has no adapter type: ${agentId}` };
  if (agent.probe?.ok !== true) return { ok: false, reason: `Agent unavailable: ${agentId}` };
  return { ok: true, agent };
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch {
        const error = new Error('Request body must be valid JSON');
        error.code = 'invalid_json';
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function resolveUiPath(rawPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (!(decoded.startsWith('/views/')
    || decoded.startsWith('/components/')
    || decoded.endsWith('.mjs')
    || decoded.endsWith('.css')
    || decoded.endsWith('.json'))) {
    return null;
  }

  const candidate = resolve(UI_DIR, `.${decoded}`);
  const root = `${UI_DIR}${sep}`.toLowerCase();
  return candidate.toLowerCase().startsWith(root) ? candidate : null;
}

async function serveStatic(res, filePath, mime) {
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`500: ${err.message}`);
  }
}

export default startServer;
