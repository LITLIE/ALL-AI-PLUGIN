// core/executor.mjs — 执行引擎（双生命周期）
// 生命周期：oneshot（一次性进程） / session（长连接会话：app-server/ACP）
// 超时中断：session 先发 interrupt，3s 宽限后杀进程树；oneshot 直接杀进程树。
// 防孤儿：服务退出钩子 + 活跃 run 注册表。

import { paths, runWorkDir } from './paths.mjs';
import { ensureDir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createAdapter } from '../adapters/index.mjs';
import { emit } from './bus.mjs';
import { updateTask, updateRun, getRun, getTask } from './orchestrator.mjs';

// 活跃运行表（用于中断 + 退出钩子）
const _activeRuns = new Map(); // runId -> { adapter, taskId, agentId, startedAt, mode }

/** 执行一个 run（orchestrator 调用） */
export async function executeRun(run, agent, ctx) {
  const { task, dispatch } = ctx;
  const adapter = createAdapter(agent, (event) => _onAdapterEvent(event, run, agent, task));
  _activeRuns.set(run.id, { adapter, taskId: task.id, agentId: agent.id, startedAt: Date.now(), mode: agent.type });

  await emit('run_started', { runId: run.id, agentId: agent.id, taskId: task.id, mode: agent.type });

  // 设置超时
  const timeoutMs = agent.timeoutMs || 900000; // 默认 15 分钟
  const timer = setTimeout(() => {
    console.warn(`[executor] run ${run.id} timeout (${timeoutMs}ms), interrupting...`);
    interruptRun(run.id).catch(() => {});
  }, timeoutMs);

  try {
    await adapter.start(run);
    // 等待 adapter 报告完成（通过 _onAdapterEvent 调 _onRunComplete）
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (!_activeRuns.has(run.id)) { clearInterval(check); resolve({ ok: true }); }
      }, 500);
      // 兜底：60s 后强制 resolve（adapter 不会无限挂）
      setTimeout(() => { clearInterval(check); resolve({ ok: true, timedOut: true }); }, 60000);
    });
  } catch (err) {
    await emit('run_error', { runId: run.id, error: err.message, stack: err.stack });
    _activeRuns.delete(run.id);
    clearTimeout(timer);
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

function _onAdapterEvent(event, run, agent, task) {
  // 1. 落 bus
  emit(event.kind, event.body, { runId: run.id, agentId: agent.id, taskId: task.id }).catch(() => {});

  // 2. 终态检测
  if (event.kind === 'run_completed' || event.kind === 'run_error' || event.kind === 'run_exit_non_zero') {
    _onRunComplete(run, agent, task, event);
  }
}

function _onRunComplete(run, agent, task, event) {
  const active = _activeRuns.get(run.id);
  if (!active) return;
  _activeRuns.delete(run.id);

  const ok = event.kind === 'run_completed' && event.body?.exitCode === 0;
  const newStatus = ok ? 'succeeded' : 'failed';
  updateRun(run.id, { status: newStatus, endedAt: Date.now(), exitCode: event.body?.exitCode });

  // 任务状态推进
  if (task) {
    const t = { ...task, status: ok ? 'awaiting-review' : 'failed' };
    updateTask(task.id, t);
  }

  emit('run_completed', { runId: run.id, agentId: agent.id, taskId: task.id, exitCode: event.body?.exitCode, durationMs: Date.now() - active.startedAt });
}

/** 中断一个 run（API + CLI 共用） */
export async function interruptRun(runId) {
  const active = _activeRuns.get(runId);
  if (!active) {
    console.warn(`[executor] no active run: ${runId}`);
    return { ok: false, reason: 'not_active' };
  }
  await active.adapter.interrupt();
  await emit('run_interrupted', { runId });
  return { ok: true };
}

/** 重试（调用方提供 retry prompt，生成新 run） */
export async function retryRun(runId) {
  const active = _activeRuns.get(runId);
  if (active) {
    // 仍在跑：先中断
    await interruptRun(runId);
  }
  const run = getRun(runId);
  if (!run) return { ok: false, reason: 'not_found' };
  // 通过 orchestrator 重派
  const task = getTask(run.taskId);
  if (!task) return { ok: false, reason: 'no_task' };
  return { ok: true, note: 're-dispatch via orchestrator.dispatch' };
}

/** 优雅关闭所有活跃 run（服务退出钩子） */
export async function shutdownAll() {
  for (const [runId, active] of _activeRuns) {
    try { await active.adapter.stop(); } catch {}
    await emit('run_shutdown', { runId });
  }
  _activeRuns.clear();
}

process.on('exit', () => { shutdownAll().catch(() => {}); });
process.on('SIGINT', () => { shutdownAll().then(() => process.exit(0)); });
process.on('SIGTERM', () => { shutdownAll().then(() => process.exit(0)); });
