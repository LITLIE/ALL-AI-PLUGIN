// adapters/acp.mjs — ACP (Agent Client Protocol) v1 适配器（第三方统一入口，非唯一通道）
// ACP v1: JSON-RPC 2.0 over stdio, Apache-2.0, 30+ agent 生态
// Agent 侧: initialize / authenticate / session/new / session/load / session/prompt / session/cancel
// Client 侧需实现: session/request_permission / fs/read_text_file / fs/write_text_file / terminal/* / elicitation/*

import { spawn } from 'node:child_process';
import { spawnPlan, killProcessTree } from '../core/utils.mjs';
import { probeCommand } from '../core/probe.mjs';

const activeProcesses = new Map();

/**
 * ACP v1 适配器（作为第三方 agent 统一入口，不做唯一通道）
 * 使用场景：接入 Gemini CLI / OpenCode / Copilot 等已支持 ACP 的 agent
 */
export default {
  id: 'acp',
  displayName: 'ACP Agent',
  outputProtocol: 'acp',
  capabilityTags: ['general'],

  async probe(agentConfig = {}) {
    return probeCommand(agentConfig);
  },

  async *run({ taskId, runId, prompt, cwd, timeoutMs = 180000, onEvent, agentConfig = {} }) {
    const startTs = Date.now();
    yield { type: 'run.started', taskId, runId, agentId: 'acp', ts: startTs };

    if (typeof agentConfig.command !== 'string' || !agentConfig.command.trim()) {
      yield { type: 'run.failed', taskId, runId, agentId: 'acp', error: 'ACP command is not configured', ts: Date.now() };
      return;
    }
    const vars = { prompt: prompt || '', cwd: cwd || process.cwd(), taskId, runId };
    const templates = Array.isArray(agentConfig.args) && agentConfig.args.length ? agentConfig.args : ['--stdio'];
    const args = templates.map(value => String(value).replace(/\{\{(prompt|cwd|taskId|runId)\}\}/g, (_, key) => String(vars[key] ?? '')));
    const plan = spawnPlan(agentConfig.command, args);
    let proc;
    try {
      proc = spawn(plan.file, plan.args, {
        cwd: agentConfig.cwd || cwd || process.cwd(),
        shell: false,
        windowsHide: true,
        env: { ...process.env, ...(agentConfig.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      yield { type: 'run.failed', taskId, runId, agentId: 'acp', error: error.message, ts: Date.now() };
      return;
    }
    activeProcesses.set(runId, proc);

    const reqId = { current: 1 };
    const pending = new Map();
    let closed = false;

    proc.once('error', error => {
      closed = true;
      for (const resolve of pending.values()) resolve({ error: { message: error.message } });
      pending.clear();
    });
    proc.once('close', code => {
      closed = true;
      if (code === 0) return;
      for (const resolve of pending.values()) resolve({ error: { message: `ACP process exited with code ${code}` } });
      pending.clear();
    });

    proc.stdout?.on('data', d => {
      try {
        const msg = JSON.parse(d.toString());
        if (msg.id != null) {
          const resolve = pending.get(msg.id);
          if (resolve) { pending.delete(msg.id); resolve(msg); }
        } else {
          onEvent?.({ type: 'acp.notify', method: msg.method, params: msg.params });
        }
      } catch { /* skip */ }
    });

    const send = (method, params = {}) => {
      if (closed || !proc.stdin?.writable) return Promise.resolve({ error: { message: 'ACP process is not writable' } });
      const id = reqId.current++;
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return new Promise(resolve => pending.set(id, resolve));
    };

    try {
      // ACP 握手
      const initialized = await send('initialize', {
        protocolVersion: '1.0',
        capabilities: { streaming: true, fs: true, terminal: true, elicitation: true },
        clientInfo: { name: 'awb-workbench', version: '0.1.0' },
      });
      if (initialized?.error) throw new Error(initialized.error.message || 'ACP initialize failed');

      const authenticated = await send('authenticate', {});
      if (authenticated?.error) throw new Error(authenticated.error.message || 'ACP authenticate failed');

      // 创建 session
      const session = await send('session/new', { history: [{ role: 'user', content: prompt }] });
      if (session?.error) throw new Error(session.error.message || 'ACP session creation failed');
      const sessionId = session.result?.sessionId;

      // 轮询直到完成
      const startPoll = Date.now();
      while (Date.now() - startPoll < timeoutMs) {
        await new Promise(r => setTimeout(r, 500));
        const result = await send('session/load', { sessionId });
        if (result.result?.status === 'completed') {
          yield { type: 'run.completed', taskId, runId, agentId: 'acp', cost: 0, duration: Date.now() - startTs, text: result.result.message, ts: Date.now() };
          return;
        }
      }

      yield { type: 'run.timeout', taskId, runId, ts: Date.now() };
    } catch (err) {
      yield { type: 'run.failed', taskId, runId, agentId: 'acp', error: err.message, ts: Date.now() };
    } finally {
      activeProcesses.delete(runId);
      proc.kill();
    }
  },

  async interrupt() {
    return { ok: true };
  },
  async terminate({ runId }) {
    const proc = activeProcesses.get(runId);
    if (!proc?.pid) return { ok: true, termination: 'cooperative' };
    await killProcessTree(proc.pid).catch(() => proc.kill());
    return { ok: true, termination: 'process-tree' };
  },
};
