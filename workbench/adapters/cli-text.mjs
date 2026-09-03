// adapters/cli-text.mjs — 通用 CLI 文本适配器（降级通道：非结构化输出）

import { spawn } from 'node:child_process';
import { spawnPlan } from '../core/utils.mjs';
import { probeCommand } from '../core/probe.mjs';

const activeProcesses = new Map();

/**
 * CLI 文本适配器（降级兜底）
 * 适用于：无原生结构化协议、不走 ACP、不走 app-server 的 CLI agent
 * 解析策略：stdout 全量读，按行或 JSONL 解析（输出协议配置决定）
 */
export default {
  id: 'cli-text',
  displayName: 'Generic CLI Agent',
  outputProtocol: 'cli-text',
  capabilityTags: ['general'],

  async probe(agentConfig = {}) {
    return probeCommand(agentConfig);
  },

  async *run({ taskId, runId, prompt, cwd, timeoutMs = 120000, onEvent, agentConfig = {} }) {
    const startTs = Date.now();
    yield { type: 'run.started', taskId, runId, agentId: 'cli-text', ts: startTs };

    if (typeof agentConfig.command !== 'string' || !agentConfig.command.trim()) {
      yield { type: 'run.failed', taskId, runId, agentId: 'cli-text', error: 'CLI command is not configured', ts: Date.now() };
      return;
    }
    const vars = { prompt: prompt || '', cwd: cwd || process.cwd(), taskId, runId };
    const templates = Array.isArray(agentConfig.args) ? agentConfig.args : ['{{prompt}}'];
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
      yield { type: 'run.failed', taskId, runId, agentId: 'cli-text', error: error.message, ts: Date.now() };
      return;
    }
    activeProcesses.set(runId, proc);

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
    }, timeoutMs);

    const stdoutChunks = [];
    const stderrChunks = [];

    proc.stdout?.on('data', d => {
      const text = d.toString();
      stdoutChunks.push(text);
      onEvent?.({ type: 'run.stdout', taskId, runId, text });
    });

    proc.stderr?.on('data', d => {
      const text = d.toString();
      stderrChunks.push(text);
      onEvent?.({ type: 'run.stderr', taskId, runId, text });
    });

    proc.on('error', error => onEvent?.({ type: 'run.error', taskId, runId, error: error.message }));
    if (agentConfig.inputProtocol !== 'args' && !args.some(arg => arg.includes(prompt || ''))) proc.stdin?.end(prompt || '');
    else proc.stdin?.end();

    const { code } = await new Promise(resolve => proc.once('close', (exitCode, signal) => resolve({ code: exitCode, signal })));
    activeProcesses.delete(runId);
    clearTimeout(timer);

    const duration = Date.now() - startTs;
    if (code === 0) {
      yield { type: 'run.completed', taskId, runId, agentId: 'cli-text', cost: 0, duration, text: stdoutChunks.join(''), ts: Date.now() };
    } else {
      yield { type: 'run.failed', taskId, runId, agentId: 'cli-text', code, stderr: stderrChunks.join(''), ts: Date.now() };
    }
  },

  async interrupt({ runId } = {}) {
    const proc = activeProcesses.get(runId);
    if (proc?.pid) proc.kill('SIGTERM');
    return { ok: true };
  },

  async terminate({ runId } = {}) {
    const proc = activeProcesses.get(runId);
    if (!proc?.pid) return { ok: true, termination: 'cooperative' };
    proc.kill('SIGKILL');
    return { ok: true, termination: 'process-tree' };
  },
};
