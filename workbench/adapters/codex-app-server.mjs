// Codex CLI app-server adapter (JSON-RPC over stdio).

import { spawn } from 'node:child_process';
import { spawnPlan, killProcessTree } from '../core/utils.mjs';
import { probeCommand } from '../core/probe.mjs';

const activeSessions = new Map();
const TERMINAL_TYPES = new Set(['run.completed', 'run.failed', 'run.timeout', 'run.interrupted']);

function substitute(value, vars) {
  return String(value).replace(/\{\{(prompt|cwd|taskId|runId)\}\}/g, (_, key) => String(vars[key] ?? ''));
}

function commandPlan(agentConfig, vars, fallbackArgs) {
  const command = agentConfig?.command || 'codex';
  const templates = Array.isArray(agentConfig?.args) && agentConfig.args.length ? agentConfig.args : fallbackArgs;
  const args = templates.map(value => substitute(value, vars));
  // 保留 spawnPlan 产出的完整 spawn 参数（Windows shim 的 /d /s /c 路由），
  // 替换后的原始模板单独放 templates 备用。
  const plan = spawnPlan(command, args);
  plan.templates = args;
  plan.command = command;
  return plan;
}

function probe(agentConfig = {}) {
  return probeCommand(agentConfig);
}

async function connect({ cwd, agentConfig = {} }) {
  const plan = commandPlan(agentConfig, { cwd }, ['app-server']);
  const proc = spawn(plan.file, plan.args, { cwd: cwd || process.cwd(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...(agentConfig.env || {}) } });
  let nextId = 1;
  let buffer = '';
  let closed = false;
  let exitError = null;
  const pending = new Map();
  const notifications = [];
  const waiters = [];
  const notify = message => {
    notifications.push(message);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (!waiters[i].predicate(message)) continue;
      const waiter = waiters.splice(i, 1)[0];
      waiter.resolve(message);
    }
  };
  const failPending = error => {
    if (closed) return;
    closed = true; exitError = error;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  };
  const processLine = raw => {
    if (!raw.trim()) return;
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (message.id != null && pending.has(message.id)) {
      const request = pending.get(message.id); pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message || 'Codex JSON-RPC error')); else request.resolve(message.result || message);
    } else notify(message);
  };
  proc.stdout?.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
    for (const line of lines) processLine(line);
  });
  proc.stderr?.on('data', chunk => notify({ method: 'codex/stderr', params: { text: chunk.toString() } }));
  proc.on('error', error => failPending(error));
  proc.on('close', code => { if (!closed) failPending(new Error(`Codex app-server exited with code ${code}`)); });
  const send = (method, params = {}) => {
    if (closed) return Promise.reject(exitError || new Error('Codex app-server is closed'));
    const id = nextId++;
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const waitFor = (predicate, timeoutMs) => new Promise((resolve, reject) => {
    const existing = notifications.find(predicate);
    if (existing) { resolve(existing); return; }
    const waiter = {
      predicate,
      resolve: value => { if (waiter.timer) clearTimeout(waiter.timer); resolve(value); },
      reject: error => { if (waiter.timer) clearTimeout(waiter.timer); reject(error); },
    };
    waiters.push(waiter);
    if (timeoutMs) waiter.timer = setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(new Error(`Timed out waiting for Codex notification after ${timeoutMs}ms`)); }, timeoutMs);
  });
  const close = async () => { if (closed) return; try { proc.stdin.end(); } catch {} if (proc.pid) await killProcessTree(proc.pid).catch(() => proc.kill()); };
  return { proc, send, notifications, waitFor, close, plan };
}

const adapter = {
  id: 'codex-app-server', displayName: 'Codex CLI (app-server)', outputProtocol: 'native-jsonrpc',
  capabilityTags: ['write', 'refactor', 'analyze', 'test', 'review', 'read'], probe,
  async *run({ taskId, runId, prompt, cwd, timeoutMs = 180000, signal, agentConfig = {} }) {
    const startTs = Date.now();
    const ctx = { taskId, runId, agentId: agentConfig.id || this.id };
    let terminal = false;
    let terminalEvent = null;
    let session;
    const emitTerminal = event => { if (terminal) return null; terminal = true; terminalEvent = event; return event; };
    yield { type: 'run.started', ...ctx, ts: startTs };
    try {
      session = await connect({ cwd, agentConfig });
      activeSessions.set(runId, session);
      const init = await session.send('initialize', { protocolVersion: '1.0', capabilities: { streaming: true }, clientInfo: { name: 'awb-workbench', version: '0.1.0' } });
      yield { type: 'run.init', ...ctx, userAgent: init.userAgent, ts: Date.now() };
      const threadResult = await session.send('thread/start', {});
      const threadId = threadResult.thread?.id || threadResult.id;
      session.threadId = threadId;
      yield { type: 'codex.thread.started', ...ctx, threadId, ts: Date.now() };
      const turnResult = await session.send('turn/start', { threadId, message: { role: 'user', content: prompt } });
      const turnId = turnResult.turn?.id || turnResult.id;
      session.turnId = turnId;
      yield { type: 'codex.turn.started', ...ctx, turnId, threadId, status: 'inProgress', ts: Date.now() };
      const onAbort = () => {
        if (terminal) return;
        emitTerminal({ type: 'run.interrupted', ...ctx, threadId, turnId, reason: 'interrupted', ts: Date.now() });
        void session.send('turn/interrupt', { threadId, turnId }).catch(() => {});
        void session.close();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        if (signal?.aborted) onAbort();
        const notification = await session.waitFor(message => {
          const method = String(message.method || '').toLowerCase();
          const params = message.params || {};
          const payload = message.payload || params.payload || params.event?.payload || {};
          const nestedTurn = params.turn || payload.turn || {};
          const notificationTurnId = params.turnId || params.turn_id || nestedTurn.id || payload.turn_id;
          const completionMethod = method === 'turn/completed' || method === 'turn/complete' || method === 'turn.finished';
          return (completionMethod && (!notificationTurnId || notificationTurnId === turnId)
            || params.turnId === turnId && ['completed', 'complete', 'finished'].includes(String(params.status || '').toLowerCase())
            || method === 'event_msg' && payload.type === 'task_complete' && (!payload.turn_id || payload.turn_id === turnId)
            || ['error', 'server/error', 'codex/error'].includes(method)
            || params.error || params.message && method.includes('error'));
        }, timeoutMs);
        if (notification && ['error', 'server/error', 'codex/error'].includes(String(notification.method || '').toLowerCase())) {
          const params = notification.params || {};
          throw new Error(params.message || params.error?.message || notification.error?.message || 'Codex app-server error');
        }
        if (terminal) {
          if (terminalEvent) {
            yield terminalEvent;
            terminalEvent = null;
          }
        } else {
          const params = notification.params || {};
          const payload = notification.payload || params.payload || params.event?.payload || {};
          const turn = params.turn || payload.turn || {};
          yield emitTerminal({ type: 'run.completed', ...ctx, threadId, turnId, text: params.text || params.result || turn.text || turn.result || payload.last_message || '', cost: Number(params.cost || params.totalCost || turn.cost || payload.cost || 0), duration: Date.now() - startTs, ts: Date.now() });
          terminalEvent = null;
        }
      } catch (error) {
        if (!terminal) {
          yield emitTerminal({ type: error.message.startsWith('Timed out') ? 'run.timeout' : 'run.failed', ...ctx, threadId, turnId, error: error.message, ts: Date.now() });
          terminalEvent = null;
        } else if (terminalEvent) {
          yield terminalEvent;
          terminalEvent = null;
        }
        if (!terminal || error.message.startsWith('Timed out')) { await session.send('turn/interrupt', { threadId, turnId }).catch(() => {}); await session.close(); }
      } finally { signal?.removeEventListener('abort', onAbort); }
    } catch (error) {
      if (!terminal) yield emitTerminal({ type: 'run.failed', ...ctx, error: error.message, ts: Date.now() });
    } finally {
      activeSessions.delete(runId);
      await session?.close?.();
    }
  },
  async interrupt({ runId }) {
    const session = activeSessions.get(runId);
    if (!session) return { ok: true };
    await session.send('turn/interrupt', { threadId: session.threadId, turnId: session.turnId }).catch(() => {});
    await session.close();
    return { ok: true };
  },
  async terminate({ runId }) {
    const session = activeSessions.get(runId);
    if (!session?.proc?.pid) return { ok: true, termination: 'cooperative' };
    await killProcessTree(session.proc.pid).catch(() => session.proc.kill());
    return { ok: true, termination: 'process-tree' };
  },
};

export { connect, commandPlan };
export default adapter;
