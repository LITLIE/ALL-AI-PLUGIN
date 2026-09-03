import { spawn } from 'node:child_process';
import { spawnPlan } from './resolve.mjs';

const DEFAULT_TIMEOUT_MS = 4_000;
const DEFAULT_OUTPUT_LIMIT = 4_096;

function result({ ok, status, resolved = null, version = null, code = null, error = null, checkedAt = Date.now() }) {
  return { ok, status, resolved, version, code, error, checkedAt };
}

function envObject(value) {
  if (!value || typeof value !== 'object') return {};
  if (Array.isArray(value)) return Object.fromEntries(value.filter(item => item && typeof item.key === 'string').map(item => [item.key, String(item.value ?? '')]));
  return value;
}

function truncate(value, limit) {
  const text = String(value || '');
  return text.length > limit ? text.slice(0, limit) : text;
}

function terminateTree(pid) {
  if (!pid) return Promise.resolve();
  if (process.platform !== 'win32') {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true });
    killer.once('close', resolve);
    killer.once('error', resolve);
  });
}

export function normalizeProbeResult(value, fallback = {}) {
  const ok = value?.ok === true;
  const status = ['available', 'unavailable', 'unknown'].includes(value?.status)
    ? value.status
    : (ok ? 'available' : 'unavailable');
  return {
    ok,
    status,
    resolved: value?.resolved ?? null,
    version: value?.version ?? null,
    code: value?.code ?? (ok ? 0 : null),
    error: value?.error ?? fallback.error ?? null,
    checkedAt: typeof value?.checkedAt === 'number' ? value.checkedAt : Date.now(),
  };
}

/** Execute a configured health command and return a stable availability result. */
export function probeCommand(agentConfig = {}, options = {}) {
  const health = agentConfig.healthCheck || {};
  const command = health.command || agentConfig.command;
  if (typeof command !== 'string' || command.trim() === '') {
    return Promise.resolve(result({ ok: false, status: 'unavailable', error: 'probe command is not configured' }));
  }

  const args = Array.isArray(health.args)
    ? health.args.map(String)
    : (Array.isArray(agentConfig.args) && agentConfig.args.length && health.command ? agentConfig.args.map(String) : ['--version']);
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, options.timeoutMs)
    : (Number.isFinite(health.timeoutMs)
      ? Math.max(1, health.timeoutMs)
      : (Number.isFinite(agentConfig.probeTimeoutMs) ? Math.max(1, agentConfig.probeTimeoutMs) : DEFAULT_TIMEOUT_MS));
  const outputLimit = Number.isFinite(options.outputLimit)
    ? Math.max(1, options.outputLimit)
    : (Number.isFinite(health.outputLimit) ? Math.max(1, health.outputLimit) : DEFAULT_OUTPUT_LIMIT);
  let plan;
  try {
    plan = spawnPlan(command, args);
  } catch (error) {
    return Promise.resolve(result({ ok: false, status: 'unavailable', error: error.message }));
  }

  return new Promise(resolve => {
    let settled = false;
    let timer;
    let output = '';
    const finish = value => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(normalizeProbeResult(value));
    };
    let proc;
    try {
      proc = spawn(plan.file, plan.args, {
        cwd: health.cwd || agentConfig.cwd || process.cwd(),
        env: { ...process.env, ...envObject(agentConfig.env), ...envObject(health.env) },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ ok: false, status: 'unavailable', resolved: plan.resolved, error: error.message });
      return;
    }

    const collect = chunk => {
      if (output.length < outputLimit) output += truncate(chunk.toString(), outputLimit - output.length);
    };
    proc.stdout?.on('data', collect);
    proc.stderr?.on('data', collect);
    proc.once('error', error => finish({ ok: false, status: 'unavailable', resolved: plan.resolved, error: error.message }));
    proc.once('close', code => {
      const diagnostic = truncate(output, outputLimit);
      const expected = health.expect == null ? null : String(health.expect);
      const version = diagnostic.split(/\r?\n/)[0] || null;
      if (code !== 0) {
        finish({ ok: false, status: 'unavailable', resolved: plan.resolved, version, code, error: `probe command exited with code ${code}` });
        return;
      }
      if (expected && !diagnostic.includes(expected)) {
        finish({ ok: false, status: 'unavailable', resolved: plan.resolved, version, code, error: `probe output did not contain expected string: ${expected}` });
        return;
      }
      finish({ ok: true, status: 'available', resolved: plan.resolved, version, code: 0, error: null });
    });
    timer = setTimeout(() => {
      void terminateTree(proc.pid);
      finish({ ok: false, status: 'unavailable', resolved: plan.resolved, error: `probe timeout after ${timeoutMs}ms` });
    }, timeoutMs);
  });
}

export const PROBE_DEFAULTS = { timeoutMs: DEFAULT_TIMEOUT_MS, outputLimit: DEFAULT_OUTPUT_LIMIT };

export default { probeCommand, normalizeProbeResult, PROBE_DEFAULTS };
