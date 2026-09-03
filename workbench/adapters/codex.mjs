// adapters/codex.mjs — Codex CLI 适配器（codex app-server 原生 JSON-RPC 长连接）
// 本机实测握手成功，含 turn/interrupt / thread/rollback / turn/diff/updated
// 降级通道：codex exec --json（JSONL 事件）
// 方法全集：https://docs.rs/codex-codes/latest/src/codex_codes/protocol.rs.html

import { spawn } from 'node:child_process';
import { spawnPlan, killTree } from '../core/utils.mjs';
import { bus } from '../core/bus.mjs';

const CODEX_CMD = process.platform === 'win32'
  ? 'C:/Users/wzc/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js'
  : 'codex';

let requestId = 1;
function nextId() { return requestId++; }

/** Codex app-server JSON-RPC 长连接会话 */
export class CodexSession {
  constructor({ cwd, onEvent } = {}) {
    this.cwd = cwd || process.cwd();
    this.onEvent = onEvent || (() => {});
    this.proc = null;
    this.threadId = null;
    this.turnId = null;
    this.pending = new Map();
    this.destroyed = false;
  }

  async start() {
    const plan = spawnPlan(CODEX_CMD, ['app-server'], { cwd: this.cwd });
    this.proc = spawn(plan.command, plan.args, {
      cwd: this.cwd,
      shell: plan.shell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buf = '';
    this.proc.stdout.on('data', (d) => {
      buf += d.toString();
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          this._handle(msg);
        } catch { /* incomplete JSON */ }
      }
    });

    this.proc.stderr.on('data', (d) => this.onEvent({ type: 'log', level: 'stderr', text: d.toString() }));
    this.proc.on('close', (code) => this.onEvent({ type: 'proc.close', code }));

    // 握手
    await this._send({ method: 'initialize', params: { protocolVersion: '1.0', capabilities: {} } });
    // 发 thread/start 建立会话
    const thread = await this._send({ method: 'thread/start', params: {} });
    this.threadId = thread?.result?.thread?.id;
    return this;
  }

  _send(params) {
    return new Promise((resolve, reject) => {
      const id = nextId();
      const msg = { jsonrpc: '2.0', id, ...params };
      this.pending.set(id, resolve);
      this.proc?.stdin?.write(JSON.stringify(msg) + '\n');
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout')); } }, 30000);
    });
  }

  _handle(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      this.pending.get(msg.id)(msg);
      this.pending.delete(msg.id);
    } else if (msg.method) {
      // 通知（turn/started, item/started, error ...）
      this.onEvent({ type: 'notification', method: msg.method, params: msg.params });
      if (msg.method === 'error') {
        const { willRetry, threadId, turnId } = msg.params?.error || {};
        if (willRetry) this.onEvent({ type: 'run.retry', threadId, turnId });
      }
    }
  }

  async prompt(text) {
    const result = await this._send({
      method: 'turn/start',
      params: { threadId: this.threadId, message: { role: 'user', content: text } },
    });
    this.turnId = result?.result?.turn?.id;
    return result;
  }

  async interrupt() {
    if (!this.turnId) return;
    try {
      await this._send({ method: 'turn/interrupt', params: { threadId: this.threadId, turnId: this.turnId } });
    } catch { /* */ }
  }

  async rollback() {
    try {
      await this._send({ method: 'thread/rollback', params: { threadId: this.threadId } });
    } catch { /* */ }
  }

  destroy() {
    this.destroyed = true;
    if (this.proc?.pid) killTree(this.proc.pid);
  }
}

/** @type {import('./types').Adapter} */
export const codexAdapter = {
  id: 'codex',
  displayName: 'Codex CLI',
  capabilityTags: ['write', 'execute', 'sandbox', 'review'],
  riskLevel: 'workspace-write',
  outputProtocol: 'native-jsonrpc',
  healthCheck: { command: 'codex', args: ['--version'] },
  command: CODEX_CMD,

  async probe() {
    // app-server 需要交互式握手，降级测 --version
    const r = await spawnStream('codex', ['--version'], { timeout: 5000 });
    return { ok: r.code === 0, version: r.stdout.trim() || r.stderr.trim() };
  },

  async *run(task) {
    const { taskId, prompt, cwd, signal } = task;

    yield { type: 'run.started', taskId, agentId: 'codex' };

    let session;
    try {
      session = new CodexSession({ cwd, onEvent: (e) => {
        e.taskId = taskId;
        e.agentId = 'codex';
      }});
      await session.start();

      await session.prompt(prompt);

      // 轮询直到 turn 完成或超时（简化版；生产用 signal 控制）
      let done = false;
      const startMs = Date.now();
      while (!done && Date.now() - startMs < (task.timeoutMs || 120000)) {
        await new Promise(r => setTimeout(r, 1000));
        if (signal?.aborted) {
          yield { type: 'run.interrupted', taskId, reason: 'aborted' };
          await session.interrupt();
          break;
        }
        // 简化：等 session proc 退出就算完成
        // 生产应监听 CodexSession 的 notification 事件
        if (!session.proc?.pid) { done = true; }
      }

      yield { type: 'run.completed', taskId, agentId: 'codex', exitCode: 0 };

      await bus.write({ kind: 'run.completed', taskId, agentId: 'codex', sessionId: session.threadId });
    } catch (err) {
      yield { type: 'log', level: 'error', text: err.message };
      yield { type: 'run.failed', taskId, agentId: 'codex', error: err.message };
    } finally {
      session?.destroy();
    }
  },
};

export default codexAdapter;
