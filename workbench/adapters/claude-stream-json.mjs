// Claude Code stream-json adapter.

import { spawn } from 'node:child_process';
import { spawnPlan, killProcessTree } from '../core/utils.mjs';
import { probeCommand } from '../core/probe.mjs';

const activeProcesses = new Map();
const TERMINAL_TYPES = new Set(['run.completed', 'run.failed', 'run.timeout', 'run.interrupted']);

class AsyncQueue {
  constructor() { this.items = []; this.waiters = []; this.closed = false; this.error = null; }
  push(item) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false }); else this.items.push(item);
  }
  close(error = null) {
    if (this.closed) return;
    this.closed = true; this.error = error;
    while (this.waiters.length) {
      const waiter = this.waiters.shift();
      if (error) waiter(Promise.reject(error)); else waiter({ value: undefined, done: true });
    }
  }
  next() {
    if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
    if (this.closed) return this.error ? Promise.reject(this.error) : Promise.resolve({ value: undefined, done: true });
    return new Promise(resolve => this.waiters.push(resolve));
  }
}

function substitute(value, vars) {
  return String(value).replace(/\{\{(prompt|cwd|taskId|runId)\}\}/g, (_, key) => String(vars[key] ?? ''));
}

function configuredPlan(agentConfig, vars) {
  const command = agentConfig?.command || 'claude';
  const templates = Array.isArray(agentConfig?.args) ? agentConfig.args : [
    '-p', '--output-format', 'stream-json', '--include-partial-messages',
    '--no-session-persistence', '--verbose', '--output-last-message',
  ];
  const args = templates.map(value => substitute(value, vars));
  // 保留 spawnPlan 产出的完整 spawn 参数（Windows shim 的 /d /s /c 路由），
  // 替换后的原始模板单独放 templates 供 stdin 注入判断使用。
  const plan = spawnPlan(command, args);
  plan.templates = args;
  plan.command = command;
  return plan;
}

function mapMessage(msg, ctx) {
  if (!msg?.type) return null;
  if (msg.type === 'system' && msg.subtype === 'init') {
    return { type: 'run.init', ...ctx, sessionId: msg.session_id, model: msg.model, tools: (msg.tools || []).length, ts: Date.now() };
  }
  if (msg.type === 'assistant' && msg.message) {
    const text = (msg.message.content || []).map(part => part?.text || '').join('');
    return text ? { type: 'run.stdout', ...ctx, text, ts: Date.now() } : null;
  }
  if (msg.type === 'result') {
    const success = msg.subtype === 'success' || !msg.subtype || msg.is_error === false;
    return success
      ? { type: 'run.completed', ...ctx, cost: Number(msg.total_cost_usd || 0), duration: Number(msg.duration_ms || 0), text: msg.result || '', usage: msg.usage, sessionId: msg.session_id, subagent_stats: msg.subagent_stats, permission_denials: msg.permission_denials || [], ts: Date.now() }
      : { type: 'run.failed', ...ctx, error: msg.result || msg.error || 'Claude returned an error', ts: Date.now() };
  }
  return null;
}

async function probe(agentConfig = {}) {
  return probeCommand(agentConfig);
}

const adapter = {
  id: 'claude-stream-json', displayName: 'Claude Code CLI', outputProtocol: 'stream-json',
  capabilityTags: ['write', 'refactor', 'analyze', 'test', 'review', 'read'], probe,
  async *run({ taskId, runId, prompt, cwd, timeoutMs = 180000, signal, agentConfig = {} }) {
    const startTs = Date.now();
    const queue = new AsyncQueue();
    const ctx = { taskId, runId, agentId: agentConfig.id || this.id };
    let terminal = false; let lineBuffer = '';
    const plan = configuredPlan(agentConfig, { prompt: prompt || '', cwd: cwd || process.cwd(), taskId, runId });
    const proc = spawn(plan.file, plan.args, { cwd: cwd || process.cwd(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...(agentConfig.env || {}) } });
    activeProcesses.set(runId, proc);
    const emit = event => {
      if (!event || (terminal && !TERMINAL_TYPES.has(event.type))) return;
      if (TERMINAL_TYPES.has(event.type)) { if (terminal) return; terminal = true; }
      queue.push(event); if (TERMINAL_TYPES.has(event.type)) queue.close();
    };
    const consume = chunk => {
      lineBuffer += chunk.toString(); const lines = lineBuffer.split(/\r?\n/); lineBuffer = lines.pop() || '';
      for (const raw of lines) {
        if (!raw.trim()) continue;
        try { emit(mapMessage(JSON.parse(raw), ctx)); } catch { emit({ type: 'run.stdout', ...ctx, text: raw, ts: Date.now() }); }
      }
    };
    proc.stdout?.on('data', consume);
    proc.stderr?.on('data', data => emit({ type: 'run.stderr', ...ctx, text: data.toString(), ts: Date.now() }));
    proc.on('error', error => { if (!terminal) emit({ type: 'run.failed', ...ctx, error: error.message, ts: Date.now() }); queue.close(); });
    proc.on('close', code => {
      if (lineBuffer.trim() && !terminal) { try { emit(mapMessage(JSON.parse(lineBuffer), ctx)); } catch { emit({ type: 'run.stdout', ...ctx, text: lineBuffer, ts: Date.now() }); } }
      if (!terminal) emit(code === 0 ? { type: 'run.failed', ...ctx, error: 'Claude exited without a result event', ts: Date.now() } : { type: 'run.failed', ...ctx, code, error: `Claude exited with code ${code}`, ts: Date.now() });
      queue.close(); activeProcesses.delete(runId);
    });
    const timer = setTimeout(async () => { if (!terminal) { emit({ type: 'run.timeout', ...ctx, error: `timeout after ${timeoutMs}ms`, ts: Date.now() }); if (proc.pid) await killProcessTree(proc.pid).catch(() => proc.kill()); } }, timeoutMs);
    const onAbort = async () => { if (!terminal) { emit({ type: 'run.interrupted', ...ctx, reason: 'interrupted', ts: Date.now() }); if (proc.pid) await killProcessTree(proc.pid).catch(() => proc.kill()); } };
    signal?.addEventListener('abort', onAbort, { once: true });
    yield { type: 'run.started', ...ctx, ts: startTs };
    if (agentConfig.inputProtocol !== 'args' && !plan.templates.some(arg => String(arg).includes(prompt || ''))) proc.stdin?.end(prompt || ''); else proc.stdin?.end();
    try { while (true) { const next = await queue.next(); if (next.done) break; yield next.value; } }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); activeProcesses.delete(runId); }
  },
  async interrupt({ runId }) { const proc = activeProcesses.get(runId); if (!proc?.pid) return { ok: true }; await killProcessTree(proc.pid).catch(() => proc.kill()); return { ok: true }; },
  async terminate({ runId }) {
    const proc = activeProcesses.get(runId);
    if (!proc?.pid) return { ok: true, termination: 'cooperative' };
    await killProcessTree(proc.pid).catch(() => proc.kill());
    return { ok: true, termination: 'process-tree' };
  },
};

export { configuredPlan };
export default adapter;
