// adapters/claude-stream.mjs — Claude Code 原生 stream-json 适配器
// 协议：claude -p --output-format stream-json [--input-format stream-json]
// 白送：total_cost_usd / subagent_stats / permission_denials / modelUsage / ttft_ms
// 注意：Claude 2.1.251 不说 ACP（无 acp 子命令），走原生 stream-json。

import { spawn } from 'node:child_process';
import { resolveCommandSync, buildSpawnArgs, promptToTempFile } from '../core/spawn-helper.mjs';
import { paths } from '../core/paths.mjs';
import { ensureDir, writeFile, readFile } from 'node:fs/promises';

let _seq = 0;

export class ClaudeStreamAdapter {
  /**
   * @param {Object} agent
   * @param {Function} onEvent - (event) => void
   */
  constructor(agent, onEvent) {
    this.agent = agent;
    this.onEvent = onEvent;
    this.proc = null;
    this.running = false;
    this._pending = [];
    this._buf = '';
    this.runId = null;
    this._sessionId = null;
  }

  async probe() {
    const resolved = resolveCommandSync(this.agent.command || 'claude');
    if (!resolved) return { ok: false, error: 'claude not found in PATH' };

    return new Promise((resolve) => {
      const proc = spawn(resolved, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false, windowsHide: true, timeout: 4000
      });
      let out = '';
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.stderr.on('data', (d) => { out += d.toString(); });
      proc.on('close', (code) => {
        resolve({ ok: code === 0, version: out.trim().split('\n')[0] || 'unknown', error: code !== 0 ? 'non-zero exit' : null });
      });
      proc.on('error', (err) => resolve({ ok: false, error: err.message }));
      setTimeout(() => { proc.kill(); resolve({ ok: false, error: 'probe timeout' }); }, 4000);
    });
  }

  async start(run) {
    const resolved = resolveCommandSync(this.agent.command || 'claude');
    if (!resolved) throw new Error('claude not found: PATH lookup failed');

    const workDir = paths.runWorkDir(run.id);
    await ensureDir(workDir);

    // 写入 prompt 文件（避免 shell 元字符问题）
    const promptFile = paths.promptTempFile(run.id);
    await writeFile(promptFile, run.prompt || '(no prompt)', 'utf8');

    const args = [
      '-p', '--output-format', 'stream-json',
      '--include-partial-messages',
      '--no-session-persistence',
      '--verbose',
      promptFile
    ];

    // 若有 resume session
    if (run.sessionId) {
      args.push('--session-id', run.sessionId);
      this._sessionId = run.sessionId;
    }

    this.proc = spawn(resolved, args, {
      cwd: workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        ...Object.fromEntries((this.agent.env || []).map((e) => [e.key, e.value]))
      }
    });

    this.running = true;
    this.runId = run.id;
    this._seq = 0;

    this.proc.stdout.on('data', (d) => this._onStdout(d.toString()));
    this.proc.stderr.on('data', (d) => this._onStderr(d.toString()));
    this.proc.on('exit', (code) => this._onExit(code));
    this.proc.on('error', (err) => this._onError(err));

    this._emit('run_started', { runId: run.id, agentId: this.agent.id });
    return { ok: true };
  }

  async interrupt() {
    if (!this.running) return;
    try { this.proc?.kill('SIGINT'); } catch {}
    await delay(3000);
    this._killProcessTree();
  }

  async stop() {
    this.running = false;
    this._killProcessTree();
  }

  // ── 内部 ────────────────────────────────────────────────────

  _onStdout(raw) {
    this._buf += raw;
    const lines = this._buf.split('\n');
    this._buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { this._handleLine(line); } catch (err) { /* skip malformed */ }
    }
  }

  _handleLine(line) {
    let obj;
    try { obj = JSON.parse(line); } catch { return; }

    const kind = obj.type || obj.subtype || 'unknown';
    const body = obj.message || obj.event || obj;

    const event = {
      kind,
      seq: ++this._seq,
      ts: Date.now(),
      agentId: this.agent.id,
      runId: this.runId,
      body
    };

    // 语义映射
    if (obj.type === 'result') {
      this.running = false;
      this._emit('run_completed', {
        runId: this.runId,
        exitCode: obj.result === 'success' ? 0 : 1,
        cost: obj.total_cost_usd,
        subagent_stats: obj.subagent_stats,
        permission_denials: obj.permission_denials,
        ttft_ms: obj.ttft_ms,
        duration_ms: obj.duration_ms
      });
    } else if (obj.type === 'error') {
      this.running = false;
      this._emit('run_error', { runId: this.runId, error: obj.error || obj.message });
    } else {
      this._emit(kind, body);
    }

    this.onEvent(event);
  }

  _onStderr(raw) {
    // 尝试解析错误行
    try {
      const obj = JSON.parse(raw);
      if (obj.type === 'error') this._handleLine(raw);
    } catch {}
    this._emit('stderr', { runId: this.runId, data: raw.slice(0, 500) });
  }

  _onExit(code) {
    this.running = false;
    if (code !== 0) this._emit('run_exit_non_zero', { runId: this.runId, exitCode: code });
  }

  _onError(err) {
    this._emit('run_error', { runId: this.runId, error: err.message });
    this.running = false;
  }

  _emit(kind, body) {
    this._seq = (this._seq || 0) + 1;
    const event = { kind, seq: this._seq, ts: Date.now(), agentId: this.agent.id, runId: this.runId, body };
    this.onEvent(event);
  }

  _killProcessTree() {
    if (!this.proc?.pid) return;
    try {
      spawn('taskkill', ['/T', '/F', '/PID', String(this.proc.pid)], { windowsHide: true });
    } catch {
      try { this.proc.kill('SIGKILL'); } catch {}
    }
    this.running = false;
  }
}

function delay(ms) { return new Promise((res) => setTimeout(res, ms)); }
