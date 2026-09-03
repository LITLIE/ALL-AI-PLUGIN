// core/orchestrator.mjs — 任务编排器（核心引擎：拆解 → 派工 → 执行 → 验收 → 回滚）

import { loadAdapter } from '../adapters/index.mjs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildDiff } from './diff.mjs';
import { assertContained, createSandbox, restoreSnapshot, snapshotTree } from './sandbox.mjs';
import { appendMetric } from './metrics.mjs';
import { parsePlannerPlan, extractPlanText, hashPlannerText } from './planner.mjs';
import { readyChildren, aggregateChildren } from './dag.mjs';

/**
 * 任务状态机
 * States: pending → running → completed / failed / timeout → awaiting-review → applied / rejected / rework
 */
export const TASK_STATES = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  INTERRUPTED: 'interrupted',
  BLOCKED: 'blocked',
  AWAITING_HUMAN: 'awaiting-human',
  AWAITING_REVIEW: 'awaiting-review',
  PASSED: 'passed',
  REJECTED: 'rejected',
  REWORK: 'rework',
};

const SUPPORTED_VERDICTS = new Set([
  TASK_STATES.PASSED,
  TASK_STATES.REJECTED,
  TASK_STATES.REWORK,
]);

const TERMINAL_EVENT_TYPES = new Set([
  'run.completed',
  'run.failed',
  'run.timeout',
  'run.interrupted',
]);

function snapshotIndex(snapshot) {
  return new Map((snapshot?.files || []).map(file => [file.relPath, file.sha256]));
}

function sameSnapshot(left, right) {
  const a = snapshotIndex(left);
  const b = snapshotIndex(right);
  if (a.size !== b.size) return false;
  for (const [relPath, sha256] of a) if (b.get(relPath) !== sha256) return false;
  return true;
}

function changeCounts(diff = {}) {
  return {
    added: (diff.added || []).length,
    modified: (diff.modified || []).length,
    deleted: (diff.deleted || []).length,
  };
}

function makeRunId() {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function invalidReviewerError() {
  const error = new Error('Reviewer ID must be a non-empty string');
  error.code = 'invalid_reviewer';
  error.statusCode = 400;
  return error;
}

function workflowError(code, message, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

/**
 * Orchestrator — 核心编排引擎
 * 职责：
 * 1. 任务创建与状态管理
 * 2. 按能力标签选派 Agent（打分规则）
 * 3. 串行 / 并行执行调度
 * 4. 超时中断 + 失败重试（指数退避）
 * 5. 变更采集（快照比对）
 * 6. 验收流程（maker-checker 强制）
 * 7. 应用与回滚
 */
export class Orchestrator {
  /**
   * @param {EventBus} bus — 事件总线
   * @param {AgentRegistry} registry — Agent 注册表
   */
  constructor(bus, registry) {
    this.bus = bus;
    this.registry = registry;
    this.tasks = new Map(); // taskId -> task
    this.runs = new Map(); // runId -> run
    this._running = new Map(); // runId -> { promise, controller, adapter, iterator }
  }

  async _recordMetric(run, name, value, dimensions) {
    if (!Number.isFinite(value)) return;
    try {
      await appendMetric(this.bus, name, value, {
        runId: run.runId,
        taskId: run.taskId,
        agentId: run.agentId,
        attempt: run.attempt,
        dimensions,
      });
    } catch {
      // Metrics are observability only and must never change Run outcome.
    }
  }

  /** 创建任务 */
  async createTask({ taskId, description, requiredTags, agentHints, dependencies, cwd, sandboxMode, scope, maxRetries, retryBaseDelayMs, retryMaxDelayMs, timeoutMs, interruptGraceMs, parentTaskId = null }) {
    const task = {
      taskId,
      description,
      requiredTags: requiredTags || [],
      agentHints: agentHints || [],
      dependencies: dependencies || [], // 依赖的 taskId[]
      cwd: cwd || process.cwd(),
      sandboxMode: sandboxMode || 'workspace-write', // "read-only" | "workspace-write" | "high-risk"
      scope: scope || null,
      maxRetries: Number.isInteger(maxRetries) ? Math.max(0, maxRetries) : 0,
      retryBaseDelayMs: Number.isFinite(retryBaseDelayMs) ? Math.max(0, retryBaseDelayMs) : 250,
      retryMaxDelayMs: Number.isFinite(retryMaxDelayMs) ? Math.max(0, retryMaxDelayMs) : 10_000,
      timeoutMs: Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : null,
      interruptGraceMs: Number.isFinite(interruptGraceMs) ? Math.max(0, interruptGraceMs) : 3_000,
      approval: {
        status: sandboxMode === 'high-risk' ? 'pending' : 'not_required',
        reviewerId: null,
        agentId: null,
        reason: null,
        decidedAt: null,
      },
      state: TASK_STATES.PENDING,
      parentTaskId,
      children: [],
      planVersion: 0,
      planStatus: 'none',
      blockedReason: null,
      aggregate: null,
      createdAt: Date.now(),
      assignedRuns: [],
    };
    this.tasks.set(taskId, task);
    await this.bus.append('dispatch', { action: 'task.created', task }, { taskId });
    return task;
  }

  /** 使用已注册 Planner 生成并接受一个子任务 DAG */
  async decomposeTask(taskId, plannerAgentId, prompt) {
    const parent = this.tasks.get(taskId);
    if (!parent) throw workflowError('task_not_found', `Task not found: ${taskId}`, 404);
    if (parent.planStatus === 'accepted' || (parent.children || []).length > 0) {
      throw workflowError('plan_conflict', `Task already has an accepted plan: ${taskId}`, 409);
    }

    const planner = this.registry.agents.get(plannerAgentId);
    if (!planner) throw workflowError('planner_not_found', `Planner Agent not found: ${plannerAgentId}`, 404);
    if (!planner.enabled || !['design', 'analyze'].some(tag => (planner.capabilityTags || []).includes(tag))) {
      throw workflowError('planner_unavailable', `Agent is not a Planner: ${plannerAgentId}`, 409);
    }
    const probe = this.registry._probed.get(plannerAgentId);
    if (probe?.ok !== true) throw workflowError('planner_unavailable', `Planner unavailable: ${plannerAgentId}`, 409);

    const requestPrompt = typeof prompt === 'string' && prompt.trim()
      ? prompt
      : `Decompose this task into a dependency DAG. Return JSON only with a tasks array.\nTask: ${parent.description}`;
    const planVersion = (parent.planVersion || 0) + 1;
    const promptText = String(requestPrompt);
    parent.planStatus = 'pending';
    await this.bus.append('task', {
      type: 'task.plan.requested',
      taskId,
      plannerAgentId,
      planVersion,
      promptLength: promptText.length,
      promptSha256: hashPlannerText(promptText),
      ts: Date.now(),
    }, { taskId, agentId: plannerAgentId });

    let plannerRun;
    try {
      plannerRun = await this.dispatch(taskId, plannerAgentId, promptText);
      plannerRun = await this.waitForRun(plannerRun.runId);
    } catch (error) {
      parent.planStatus = 'rejected';
      const rejection = { type: 'task.plan.rejected', taskId, planVersion, code: error.code || 'planner_failed', message: error.message, ts: Date.now() };
      await this.bus.append('task', rejection, { taskId, agentId: plannerAgentId });
      throw error;
    }

    const planText = extractPlanText(plannerRun);
    const parsed = parsePlannerPlan(planText, parent);
    if (!parsed.ok) {
      parent.planStatus = 'rejected';
      const rejection = { type: 'task.plan.rejected', taskId, planVersion, code: parsed.error.code, message: parsed.error.message, ts: Date.now() };
      await this.bus.append('task', rejection, { taskId, agentId: plannerAgentId });
      return { ok: false, error: parsed.error, task: parent, children: [] };
    }

    const planHash = hashPlannerText(planText);
    parent.planVersion = planVersion;
    parent.planStatus = 'accepted';
    parent.planHash = planHash;
    parent.plannerRunId = plannerRun.runId;
    parent.children = parsed.plan.children.map(child => child.taskId);
    parent.blockedReason = null;
    parent.aggregate = null;
    await this.bus.append('task', {
      type: 'task.plan.accepted',
      taskId,
      plannerAgentId,
      plannerRunId: plannerRun.runId,
      planVersion,
      planHash,
      childIds: parent.children,
      ts: Date.now(),
    }, { taskId, agentId: plannerAgentId });

    const children = [];
    for (const child of parsed.plan.children) {
      const created = await this.createTask({ ...child, parentTaskId: taskId });
      children.push(created);
    }
    parent.state = 'pending';
    return { ok: true, task: parent, children, planVersion, plannerRunId: plannerRun.runId };
  }

  /** 选择执行者（按能力标签打分） */
  selectAgent(task) {
    const candidates = this.registry.findByCapability(task.requiredTags);
    if (candidates.length === 0) {
      return {
        ok: false,
        reason: 'no executable Echo agent matches the task',
        missingTags: task.requiredTags,
      };
    }
    // 简单打分：标签匹配数 * 10 + agentHints 命中加分
    const scored = candidates.map(a => {
      let score = (a.capabilityTags || []).filter(t => task.requiredTags.includes(t)).length * 10;
      if (task.agentHints.includes(a.id)) score += 50;
      return { ...a, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return { ok: true, agent: scored[0] };
  }

  /** 创建 Run 并执行 */
  async dispatch(taskId, agentId, prompt, options = {}) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    if (task.sandboxMode === 'high-risk') {
      if (task.approval?.status !== 'approved') {
        throw workflowError('approval_required', `Task approval is ${task.approval?.status || 'pending'}`, 409);
      }
      if (task.approval.agentId && task.approval.agentId !== agentId) {
        throw workflowError('approval_agent_mismatch', `Approval is bound to Agent: ${task.approval.agentId}`, 409);
      }
    }

    const agentConfig = this.registry.agents.get(agentId);
    if (!agentConfig) throw new Error(`Agent not found: ${agentId}`);
    if (!agentConfig.enabled) throw new Error(`Agent is disabled: ${agentId}`);
    const adapter = await loadAdapter(agentConfig);
    if (!adapter) throw new Error(`No adapter configured for Agent: ${agentId}`);
    const probe = this.registry._probed.get(agentId);
    if (probe?.ok !== true) {
      throw new Error(`Agent unavailable: ${agentId}${probe?.error ? ` (${probe.error})` : ''}`);
    }

    const runId = options.runId || makeRunId();
    const run = {
      runId,
      taskId,
      agentId,
      prompt,
      promptLength: String(prompt || '').length,
      promptSha256: createHash('sha256').update(String(prompt || '')).digest('hex'),
      state: TASK_STATES.RUNNING,
      startedAt: Date.now(),
      completedAt: null,
      snapshotBefore: null,
      snapshotAfter: null,
      diff: null,
      targetCwd: task.cwd,
      executionCwd: null,
      appliedAt: null,
      rolledBackAt: null,
      verdict: null,
      reviewerId: null,
      verdictReason: null,
      verdictAt: null,
      retries: 0,
      maxRetries: task.maxRetries ?? agentConfig.maxRetries ?? 0,
      attempt: options.retryCount || 0,
      retryOf: options.retryOf || null,
      retryCount: options.retryCount || 0,
      retryPolicy: {
        baseDelayMs: task.retryBaseDelayMs ?? 250,
        maxDelayMs: task.retryMaxDelayMs ?? 10_000,
      },
      cost: null,
      text: null,
      error: null,
    };

    const persistedRun = { ...run };
    delete persistedRun.prompt;
    await this.bus.append('run', {
      type: 'run.created',
      run: persistedRun,
    }, { runId, taskId, agentId });

    this.runs.set(runId, run);
    task.assignedRuns.push(runId);
    task.state = TASK_STATES.RUNNING;

    const active = {
      promise: null,
      controller: new AbortController(),
      adapter: null,
      iterator: null,
    };
      this._running.set(runId, active);
    const execution = this._executeRun(run, task, agentConfig, active);
    active.promise = execution;
    const clearRunning = () => this._running.delete(runId);
    execution.then(clearRunning, clearRunning);

    return run;
  }

  /** 提交高风险任务审批 */
  async submitApproval(taskId, decision, reviewerId, agentId, reason) {
    if (!['approved', 'rejected'].includes(decision)) {
      throw workflowError('invalid_approval', `Unsupported approval decision: ${decision}`, 400);
    }
    if (typeof reviewerId !== 'string' || reviewerId.trim() === '') {
      const error = new Error('Reviewer ID must be a non-empty string');
      error.code = 'invalid_reviewer';
      error.statusCode = 400;
      throw error;
    }
    const task = this.tasks.get(taskId);
    if (!task) throw workflowError('task_not_found', `Task not found: ${taskId}`, 404);
    if (task.sandboxMode !== 'high-risk') {
      throw workflowError('approval_not_required', 'Approval is only required for high-risk tasks', 409);
    }
    if (task.approval?.status === 'approved' || task.approval?.status === 'rejected') {
      throw workflowError('approval_conflict', 'Task approval is already terminal', 409);
    }
    const normalizedReviewer = reviewerId.trim();
    const boundAgent = agentId || null;
    if (boundAgent && normalizedReviewer === boundAgent) {
      const approval = {
        status: 'rejected', reviewerId: normalizedReviewer, agentId: boundAgent,
        reason: 'maker-checker violation', decidedAt: Date.now(),
      };
      task.approval = approval;
      await this.bus.append('approval', {
        type: 'approval.denied', taskId, decision, ...approval, attemptedDecision: decision,
      }, { taskId, agentId: normalizedReviewer });
      return { ok: false, reason: 'maker-checker violation' };
    }

    const approval = {
      status: decision,
      reviewerId: normalizedReviewer,
      agentId: boundAgent,
      reason: reason || '',
      decidedAt: Date.now(),
    };
    task.approval = approval;
    await this.bus.append('approval', {
      type: decision === 'approved' ? 'approval.granted' : 'approval.denied',
      taskId, decision, ...approval,
    }, { taskId, agentId: normalizedReviewer });
    return { ok: true, task, approval };
  }

  /** 等待 Run 到达终态 */
  async waitForRun(runId) {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    const active = this._running.get(runId);
    if (active?.promise) {
      const result = await active.promise;
      return result || run;
    }
    return run;
  }

  /** 执行单个 Run（消费并持久化 adapter 事件流） */
  async _executeRun(run, task, agentConfig, active) {
    let sandbox;
    let timeoutTimer;
    let timedOut = false;
    try {
      sandbox = await createSandbox({ runId: run.runId, targetCwd: task.cwd, storeRoot: this._storeRoot(), scope: task.scope });
      run.targetCwd = sandbox.targetCwd;
      run.executionCwd = sandbox.workspace;
      run.scope = sandbox.scope;
      const runRoot = path.dirname(sandbox.workspace);
      const beforeBackupDir = path.join(runRoot, 'snapshot-before');
      run.snapshotBefore = await snapshotTree(sandbox.workspace, { scope: sandbox.scope, backupDir: beforeBackupDir });
      await this.bus.append('run', { type: 'run.snapshot.created', runId: run.runId, phase: 'before', snapshot: run.snapshotBefore, ts: Date.now() }, { runId: run.runId, taskId: run.taskId, agentId: run.agentId });

      const adapter = await loadAdapter(agentConfig);
      if (!adapter) {
        await this._failRun(run, task, `No adapter: ${run.agentId}`);
        return;
      }
      active.adapter = adapter;

      const configuredDefault = Number(agentConfig.timeoutDefault || 0);
      const configuredMax = Number(agentConfig.timeoutMax || 0);
      const requestedTimeout = Number(task.timeoutMs || configuredDefault || 180000);
      const timeoutMs = configuredMax > 0 ? Math.min(requestedTimeout, configuredMax) : requestedTimeout;
      const stream = adapter.run({
        taskId: run.taskId,
        runId: run.runId,
        prompt: run.prompt,
        cwd: sandbox.workspace,
        timeoutMs,
        signal: active.controller.signal,
        agentConfig,
      });
      const iterator = stream?.[Symbol.asyncIterator]?.();
      if (!iterator) {
        await this._failRun(run, task, `Adapter did not return an async iterator: ${run.agentId}`);
        return;
      }
      active.iterator = iterator;

      const timeoutPromise = new Promise(resolve => {
        timeoutTimer = setTimeout(() => resolve({ timeout: true }), timeoutMs);
      });

      while ([TASK_STATES.RUNNING, TASK_STATES.AWAITING_HUMAN].includes(run.state)) {
        const nextResult = await Promise.race([
          iterator.next().then(result => ({ result })),
          timeoutPromise,
        ]);
        if (nextResult.timeout) {
          timedOut = true;
          const context = { runId: run.runId, taskId: run.taskId, agentId: run.agentId, reason: 'timeout' };
          await this.bus.append('run', { type: 'run.timeout.requested', ...context, ts: Date.now() }, { runId: run.runId, taskId: run.taskId, agentId: run.agentId });
          active.controller.abort();
          await active.adapter?.interrupt?.(context).catch?.(() => {});
          const graceMs = task.interruptGraceMs ?? 3_000;
          if (graceMs > 0) await new Promise(resolve => setTimeout(resolve, graceMs));
          if (active.adapter?.terminate) {
            const termination = await active.adapter.terminate(context).catch(error => ({ ok: false, error: error.message }));
            await this.bus.append('run', { type: 'run.terminated', ...context, termination, ts: Date.now() }, { runId: run.runId, taskId: run.taskId, agentId: run.agentId });
          }
          const timeoutEvent = { type: 'run.timeout', ...context, error: `timeout after ${timeoutMs}ms`, ts: Date.now() };
          await this.bus.append('run', timeoutEvent, { runId: run.runId, taskId: run.taskId, agentId: run.agentId });
          this._applyRunEvent(run, task, timeoutEvent);
          await this._recordMetric(run, 'run.timeout', 1, { outcome: 'timeout' });
          await this._recordMetric(run, 'run.duration_ms', run.completedAt - run.startedAt);
          break;
        }
        const { value: event, done } = nextResult.result;
        if (done) break;
        if (![TASK_STATES.RUNNING, TASK_STATES.AWAITING_HUMAN].includes(run.state) || active.controller.signal.aborted) break;

        if (TERMINAL_EVENT_TYPES.has(event.type) && run.state !== TASK_STATES.RUNNING) break;

        // 事件实时写入总线
        await this.bus.append('run', event, { runId: run.runId, taskId: run.taskId, agentId: run.agentId });
        this._applyRunEvent(run, task, event);
        if (event.type === 'run.briefing-ready' && typeof event.briefing === 'string' && event.briefing.trim()) {
          run.briefing = event.briefing;
          run.bridgeRequestedAt = event.ts ?? Date.now();
          await this.bus.append('bridge', {
            type: 'bridge.requested',
            runId: run.runId,
            taskId: run.taskId,
            agentId: run.agentId,
            briefing: event.briefing,
            ts: run.bridgeRequestedAt,
          }, { runId: run.runId, taskId: run.taskId, agentId: run.agentId });
        }
        if (event.type === 'run.started') await this._recordMetric(run, 'run.started', 1, { outcome: 'started' });
        if (event.type === 'run.completed') {
          await this._recordMetric(run, 'run.completed', 1, { outcome: 'success' });
          await this._recordMetric(run, 'run.duration_ms', Number(event.duration || run.duration || (run.completedAt - run.startedAt)));
          if (Number.isFinite(Number(event.cost))) await this._recordMetric(run, 'run.cost', Number(event.cost));
        }
        if (event.type === 'run.failed') await this._recordMetric(run, 'run.failed', 1, { outcome: 'failed' });
        if (event.type === 'run.timeout') await this._recordMetric(run, 'run.timeout', 1, { outcome: 'timeout' });
        if (event.type === 'run.interrupted') await this._recordMetric(run, 'run.interrupted', 1, { outcome: 'interrupted' });
        if (TERMINAL_EVENT_TYPES.has(event.type)) break;
      }

      if (run.snapshotBefore && sandbox) {
        run.snapshotAfter = await snapshotTree(sandbox.workspace, { scope: sandbox.scope });
        run.diff = await buildDiff(run.snapshotBefore, run.snapshotAfter, beforeBackupDir, sandbox.workspace);
        await this.bus.append('run', { type: 'run.snapshot.created', runId: run.runId, phase: 'after', snapshot: run.snapshotAfter, ts: Date.now() }, { runId: run.runId, taskId: run.taskId, agentId: run.agentId });
        await this.bus.append('run', { type: 'run.diff.created', runId: run.runId, diff: run.diff, ts: Date.now() }, { runId: run.runId, taskId: run.taskId, agentId: run.agentId });
      }

      if (run.state === TASK_STATES.RUNNING) {
        await this._failRun(run, task, `Adapter stream ended without terminal event: ${run.agentId}`);
      }

      if ((run.state === TASK_STATES.FAILED || run.state === TASK_STATES.TIMEOUT)
        && run.retryCount < run.maxRetries
        && !run.manualInterrupted) {
        const retryCount = run.retryCount + 1;
        const delayMs = Math.min(
          run.retryPolicy?.maxDelayMs ?? task.retryMaxDelayMs ?? 10_000,
          (run.retryPolicy?.baseDelayMs ?? task.retryBaseDelayMs ?? 250) * (2 ** (retryCount - 1)),
        );
        const nextRunId = makeRunId();
        await this.bus.append('run', {
          type: 'run.retry.scheduled',
          runId: run.runId,
          nextRunId,
          retryCount,
          delayMs,
          reason: run.error || run.state,
          ts: Date.now(),
        }, { runId: run.runId, taskId: run.taskId, agentId: run.agentId });
        await this._recordMetric(run, 'run.retry', 1, { retryCount, reason: run.error || run.state });
        task.state = TASK_STATES.RUNNING;
        if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
        try {
          const nextRun = await this.dispatch(run.taskId, run.agentId, run.prompt, {
            runId: nextRunId,
            retryOf: run.runId,
            retryCount,
          });
          const nextActive = this._running.get(nextRun.runId);
          if (nextActive?.promise) return (await nextActive.promise) || nextRun;
          return nextRun;
        } catch (error) {
          await this.bus.append('run', {
            type: 'run.retry.failed',
            runId: run.runId,
            retryCount,
            error: error.message,
            ts: Date.now(),
          }, { runId: run.runId, taskId: run.taskId, agentId: run.agentId });
          task.state = TASK_STATES.FAILED;
        }
      }
    } catch (err) {
      if (run.state === TASK_STATES.INTERRUPTED || active.controller.signal.aborted) return;
      await this._failRun(run, task, err?.message || String(err));
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      try {
        const cleanup = active.iterator?.return?.();
        if (!timedOut) await cleanup;
      } catch {
        // The terminal Run event remains authoritative if iterator cleanup fails.
      }
    }
  }

  _applyRunEvent(run, task, event) {
    if (event.type === 'run.started') {
      run.state = TASK_STATES.RUNNING;
      run.startedAt = event.ts ?? run.startedAt;
    }
    if (event.type === 'run.completed') {
      run.state = TASK_STATES.COMPLETED;
      run.completedAt = event.ts ?? Date.now();
      if (Object.hasOwn(event, 'cost')) run.cost = event.cost;
      if (Object.hasOwn(event, 'duration')) run.duration = event.duration;
      if (Object.hasOwn(event, 'text')) run.text = event.text;
      task.state = TASK_STATES.AWAITING_REVIEW;
    }
    if (event.type === 'run.awaiting-human') {
      run.state = TASK_STATES.AWAITING_HUMAN;
      run.bridgeRequestedAt ||= event.ts ?? Date.now();
      task.state = TASK_STATES.AWAITING_HUMAN;
    }
    if (event.type === 'run.briefing-ready' && typeof event.briefing === 'string') {
      run.briefing = event.briefing;
    }
    if (event.type === 'run.failed' || event.type === 'run.timeout') {
      run.state = event.type === 'run.timeout' ? TASK_STATES.TIMEOUT : TASK_STATES.FAILED;
      run.completedAt = event.ts ?? Date.now();
      run.error = event.error || event.text || event.stderr;
      task.state = run.state;
    }
    if (event.type === 'run.interrupted') {
      run.state = TASK_STATES.INTERRUPTED;
      run.completedAt = event.ts ?? Date.now();
      run.error = event.error || event.reason || event.text || 'interrupted';
      task.state = TASK_STATES.INTERRUPTED;
    }
  }

  /** 将仍在运行的 Run 终结为失败，并持久化一次失败事件 */
  async _failRun(run, task, error) {
    if (run.state !== TASK_STATES.RUNNING) return;

    const event = { type: 'run.failed', runId: run.runId, error, ts: Date.now() };
    await this.bus.append('run', event, {
      runId: run.runId,
      taskId: run.taskId,
      agentId: run.agentId,
    });
    this._applyRunEvent(run, task, event);
    await this._recordMetric(run, 'run.failed', 1, { outcome: 'failed' });
    await this._recordMetric(run, 'run.duration_ms', run.completedAt - run.startedAt);
  }

  /** 提交 Human Bridge 回执并恢复 Run 生命周期 */
  async submitBridgeReceipt(runId, receiptText) {
    const run = this.runs.get(runId);
    if (!run) throw workflowError('run_not_found', `Run not found: ${runId}`, 404);
    const agentConfig = this.registry.agents.get(run.agentId);
    if (agentConfig?.type !== 'human-bridge') {
      throw workflowError('bridge_not_supported', `Run is not a Human Bridge Run: ${runId}`, 409);
    }
    if (run.state === TASK_STATES.COMPLETED || run.bridgeSubmittedAt || run.untrusted === true) {
      throw workflowError('bridge_already_submitted', `Human Bridge receipt already submitted: ${runId}`, 409);
    }
    if (run.state !== TASK_STATES.AWAITING_HUMAN) {
      throw workflowError('bridge_not_waiting', `Run is not awaiting a Human Bridge receipt: ${runId}`, 409);
    }
    if (typeof receiptText !== 'string' || receiptText.trim() === '') {
      throw workflowError('invalid_receipt', 'receiptText must be a non-empty string', 400);
    }

    const receipt = String(receiptText);
    const submittedAt = Date.now();
    const receiptSha256 = createHash('sha256').update(receipt).digest('hex');
    await this.bus.append('bridge', {
      type: 'bridge.submitted',
      runId,
      taskId: run.taskId,
      agentId: run.agentId,
      receiptLength: receipt.length,
      receiptSha256,
      untrusted: true,
      via: 'human-bridge',
      ts: submittedAt,
    }, { runId, taskId: run.taskId, agentId: run.agentId });

    const adapter = await loadAdapter(agentConfig);
    const completion = adapter?.processReceipt?.({ taskId: run.taskId, runId, receiptText: receipt }) || {
      type: 'run.completed',
      taskId: run.taskId,
      runId,
      text: receipt,
      cost: 0,
      duration: 0,
      ts: submittedAt,
      meta: { untrusted: true, via: 'human-bridge' },
    };
    completion.type = 'run.completed';
    completion.taskId = run.taskId;
    completion.runId = runId;
    completion.agentId = run.agentId;
    completion.text = receipt;
    completion.ts ||= submittedAt;
    completion.meta = { ...(completion.meta || {}), untrusted: true, via: 'human-bridge' };
    await this.bus.append('run', completion, { runId, taskId: run.taskId, agentId: run.agentId });
    this._applyRunEvent(run, this.tasks.get(run.taskId), completion);
    run.bridgeSubmittedAt = submittedAt;
    run.untrusted = true;
    run.via = 'human-bridge';
    return { ok: true, run };
  }

  /** 中断运行中的 Run */
  async interrupt(runId) {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: 'Run not found' };
    if (run.state !== TASK_STATES.RUNNING) return { ok: false, error: 'Run is not running' };

    const task = this.tasks.get(run.taskId);
    const active = this._running.get(runId);
    const signal = active?.controller.signal;
    const interruptedAt = Date.now();
    const event = {
      type: 'run.interrupted',
      runId,
      taskId: run.taskId,
      agentId: run.agentId,
      reason: 'interrupted',
      ts: interruptedAt,
    };

    run.state = TASK_STATES.INTERRUPTED;
    run.completedAt = interruptedAt;
    run.error = event.reason;
    if (task) task.state = TASK_STATES.INTERRUPTED;
    active?.controller.abort();

    const adapter = active?.adapter || await loadAdapter(this.registry.agents.get(run.agentId));
    if (adapter?.interrupt) {
      await adapter.interrupt({
        runId: run.runId,
        taskId: run.taskId,
        agentId: run.agentId,
        signal,
      });
    }

    const stop = active?.iterator?.return?.();
    await this.bus.append('run', event, {
      runId,
      taskId: run.taskId,
      agentId: run.agentId,
    });
    await this._recordMetric(run, 'run.interrupted', 1, { outcome: 'interrupted' });
    await this._recordMetric(run, 'run.duration_ms', run.completedAt - run.startedAt);
    try {
      await stop;
    } catch {
      // Interruption is already persisted and terminal.
    }
    return { ok: true };
  }

  /** 提交验收判定 */
  async submitVerdict(runId, verdict, reviewerId, reason) {
    if (typeof reviewerId !== 'string' || reviewerId.trim() === '') {
      throw invalidReviewerError();
    }
    reviewerId = reviewerId.trim();

    if (!SUPPORTED_VERDICTS.has(verdict)) {
      throw new Error(`Unsupported verdict: ${verdict}`);
    }

    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    // maker-checker 强制分离
    if (reviewerId === run.agentId) {
      await this.bus.append('verdict', {
        type: 'verdict.denied',
        runId,
        attemptedVerdict: verdict,
        reviewerId,
        reason: 'maker-checker violation',
      }, { runId, taskId: run.taskId, agentId: reviewerId });
      return { ok: false, reason: 'maker-checker violation' };
    }

    const task = this.tasks.get(run.taskId);
    if (task?.state !== TASK_STATES.AWAITING_REVIEW) {
      return { ok: false, reason: 'run is not awaiting review' };
    }

    const verdictAt = Date.now();
    await this.bus.append('verdict', {
      type: `verdict.${verdict}`,
      runId,
      verdict,
      reviewerId,
      reason,
      verdictAt,
    }, { runId, taskId: run.taskId, agentId: reviewerId });

    run.verdict = verdict;
    run.reviewerId = reviewerId;
    run.verdictReason = reason;
    run.verdictAt = verdictAt;
    task.state = verdict;
    return { ok: true };
  }

  /** 应用变更（快照还原前的可回滚提交） */
  async apply(runId) {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, status: 404, error: 'run_not_found' };
    if (run.state !== TASK_STATES.COMPLETED) return { ok: false, status: 409, error: 'run_not_completed' };
    if (run.verdict !== TASK_STATES.PASSED) return { ok: false, status: 409, error: 'verdict_required' };
    if (run.appliedAt) return { ok: false, status: 409, error: 'already_applied' };
    if (!run.snapshotBefore || !run.diff || !run.executionCwd || !run.targetCwd) return { ok: false, status: 409, error: 'diff_unavailable' };

    const current = await snapshotTree(run.targetCwd, { scope: run.scope });
    if (!sameSnapshot(run.snapshotBefore, current)) {
      await this.bus.append('run', { type: 'run.apply.conflict', runId, error: 'target_conflict', ts: Date.now() }, { runId, taskId: run.taskId, agentId: run.agentId });
      return { ok: false, status: 409, error: 'target_conflict' };
    }

    const applyBackupDir = path.join(this._runRoot(runId), 'snapshot-apply-before');
    const applySnapshot = await snapshotTree(run.targetCwd, { scope: run.scope, backupDir: applyBackupDir });
    for (const item of [...(run.diff.added || []), ...(run.diff.modified || [])]) {
      const source = assertContained(run.executionCwd, path.join(run.executionCwd, item.relPath));
      const destination = assertContained(run.targetCwd, path.join(run.targetCwd, item.relPath));
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }
    for (const item of run.diff.deleted || []) {
      await rm(assertContained(run.targetCwd, path.join(run.targetCwd, item.relPath)), { force: true });
    }
    run.applySnapshot = applySnapshot;
    run.appliedAt = Date.now();
    await this.bus.append('run', { type: 'run.applied', runId, appliedAt: run.appliedAt, applySnapshot, changes: changeCounts(run.diff), ts: run.appliedAt }, { runId, taskId: run.taskId, agentId: run.agentId });
    return { ok: true, appliedAt: run.appliedAt, changes: changeCounts(run.diff) };
  }

  /** 回滚（恢复快照） */
  async rollback(runId) {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, status: 404, error: 'run_not_found' };
    if (!run.appliedAt || !run.applySnapshot) return { ok: false, status: 409, error: 'not_applied' };
    if (run.rolledBackAt) return { ok: false, status: 409, error: 'already_rolled_back' };
    const applyBackupDir = path.join(this._runRoot(runId), 'snapshot-apply-before');
    await restoreSnapshot(run.applySnapshot, applyBackupDir, run.targetCwd);
    run.rolledBackAt = Date.now();
    await this.bus.append('run', { type: 'run.rolled-back', runId, rolledBackAt: run.rolledBackAt, ts: run.rolledBackAt }, { runId, taskId: run.taskId, agentId: run.agentId });
    return { ok: true, rolledBackAt: run.rolledBackAt };
  }

  _storeRoot() {
    return path.basename(this.bus.basePath) === 'eventbus' ? path.dirname(this.bus.basePath) : this.bus.basePath;
  }

  _runRoot(runId) {
    return path.join(this._storeRoot(), 'runs', runId);
  }

  /** 获取任务状态快照 */
  getTaskSnapshot(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    return {
      ...task,
      runs: (task.assignedRuns || []).map(rid => this.runs.get(rid)).filter(Boolean),
      childTasks: (task.children || []).map(childId => this.getTaskSnapshot(childId)).filter(Boolean),
    };
  }

  /** 重新计算父任务的就绪、阻塞和聚合状态，不派发 Run */
  async refreshGraphState(parentTaskId) {
    const parent = this.tasks.get(parentTaskId);
    if (!parent) throw workflowError('task_not_found', `Task not found: ${parentTaskId}`, 404);
    const childIds = parent.children || [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const childId of childIds) {
        const child = this.tasks.get(childId);
        if (!child || child.state === TASK_STATES.BLOCKED) continue;
        const blockedDependency = (child.dependencies || [])
          .map(dependency => this.tasks.get(dependency))
          .find(dependency => dependency?.state === TASK_STATES.BLOCKED);
        if (blockedDependency && ['pending', 'ready'].includes(child.state)) {
          child.state = TASK_STATES.BLOCKED;
          child.blockedReason = {
            code: 'dependency_blocked',
            message: `Dependency is blocked: ${blockedDependency.taskId}`,
            dependencyTaskId: blockedDependency.taskId,
          };
          await this.bus.append('task', {
            type: 'task.blocked',
            taskId: child.taskId,
            reason: child.blockedReason,
            ts: Date.now(),
          }, { taskId: child.taskId });
          changed = true;
        }
      }
    }

    for (const child of readyChildren(this.tasks, parent)) {
      if (child.state !== 'ready') {
        child.state = 'ready';
        await this.bus.append('task', {
          type: 'task.ready',
          taskId: child.taskId,
          dependencies: child.dependencies || [],
          ts: Date.now(),
        }, { taskId: child.taskId });
      }
    }

    const aggregate = aggregateChildren(this.tasks, childIds);
    if (JSON.stringify(parent.aggregate) !== JSON.stringify(aggregate)) {
      parent.aggregate = aggregate;
      await this.bus.append('task', {
        type: 'task.aggregate.updated',
        taskId: parent.taskId,
        aggregate,
        childStates: childIds.map(childId => ({ taskId: childId, state: this.tasks.get(childId)?.state || 'missing' })),
        ts: Date.now(),
      }, { taskId: parent.taskId });
    }
    if (aggregate.total > 0 && aggregate.completed === aggregate.total) parent.state = TASK_STATES.AWAITING_REVIEW;
    else if (aggregate.blocked > 0 && aggregate.blocked + aggregate.failed + aggregate.timeout + aggregate.interrupted === aggregate.total) parent.state = TASK_STATES.BLOCKED;
    else if (aggregate.total > 0) parent.state = TASK_STATES.RUNNING;
    return { task: parent, aggregate, children: childIds.map(childId => this.tasks.get(childId)).filter(Boolean) };
  }

  /** 执行一个已接受计划，按依赖和并发上限调度子任务 */
  async runTaskGraph(parentTaskId, { maxParallel = 4, continueOnFailure = false } = {}) {
    if (!Number.isInteger(maxParallel) || maxParallel <= 0) {
      throw workflowError('invalid_max_parallel', 'maxParallel must be a positive integer', 400);
    }
    const parent = this.tasks.get(parentTaskId);
    if (!parent) throw workflowError('task_not_found', `Task not found: ${parentTaskId}`, 404);
    if (!(parent.children || []).length) throw workflowError('plan_required', `Task has no accepted child plan: ${parentTaskId}`, 409);

    const scheduledRunIds = [];
    await this.bus.append('scheduler', {
      type: 'scheduler.started',
      taskId: parentTaskId,
      maxParallel,
      continueOnFailure,
      ts: Date.now(),
    }, { taskId: parentTaskId });

    while (true) {
      await this.refreshGraphState(parentTaskId);
      const children = parent.children.map(childId => this.tasks.get(childId)).filter(Boolean);
      const failedDependency = new Map();
      for (const child of children) {
        const dependency = (child.dependencies || [])
          .map(dependencyId => this.tasks.get(dependencyId))
          .find(dependencyTask => ['failed', 'timeout', 'interrupted', 'blocked'].includes(dependencyTask?.state));
        if (dependency && ['pending', 'ready'].includes(child.state)) failedDependency.set(child.taskId, dependency);
      }
      for (const child of children) {
        const dependency = failedDependency.get(child.taskId);
        if (!dependency) continue;
        child.state = TASK_STATES.BLOCKED;
        child.blockedReason = {
          code: dependency.state === TASK_STATES.BLOCKED ? 'dependency_blocked' : 'dependency_failed',
          message: `Dependency is ${dependency.state}: ${dependency.taskId}`,
          dependencyTaskId: dependency.taskId,
        };
        await this.bus.append('task', { type: 'task.blocked', taskId: child.taskId, reason: child.blockedReason, ts: Date.now() }, { taskId: child.taskId });
      }

      const ready = readyChildren(this.tasks, parent).filter(child => !child.assignedRuns?.length).slice(0, maxParallel);
      for (const child of ready) {
        const selection = this.selectAgent(child);
        if (!selection.ok) {
          child.state = TASK_STATES.BLOCKED;
          child.blockedReason = { code: 'missing_capability', message: selection.reason, missingTags: selection.missingTags };
          await this.bus.append('task', { type: 'task.blocked', taskId: child.taskId, reason: child.blockedReason, ts: Date.now() }, { taskId: child.taskId });
        }
      }

      const runnable = ready.filter(child => child.state !== TASK_STATES.BLOCKED);
      if (runnable.length > 0) {
        const settled = await Promise.allSettled(runnable.map(async child => {
          const run = await this.dispatch(child.taskId, this.selectAgent(child).agent.id, child.description);
          const finalRun = await this.waitForRun(run.runId);
          return { child, run: finalRun };
        }));
        for (const result of settled) {
          if (result.status === 'fulfilled') {
            scheduledRunIds.push(result.value.run.runId);
          } else {
            const child = runnable[settled.indexOf(result)];
            if (child && ['pending', 'ready', 'running'].includes(child.state)) {
              child.state = TASK_STATES.BLOCKED;
              child.blockedReason = { code: result.reason?.code || 'dispatch_failed', message: result.reason?.message || String(result.reason) };
              await this.bus.append('task', { type: 'task.blocked', taskId: child.taskId, reason: child.blockedReason, ts: Date.now() }, { taskId: child.taskId });
            }
          }
        }
        continue;
      }

      await this.refreshGraphState(parentTaskId);
      const finalChildren = parent.children.map(childId => this.tasks.get(childId)).filter(Boolean);
      const active = finalChildren.some(child => child.state === TASK_STATES.RUNNING || this._running.has(child.assignedRuns?.at(-1)));
      const pending = finalChildren.some(child => ['pending', 'ready'].includes(child.state));
      if (!active && !pending) break;
      if (!continueOnFailure && finalChildren.some(child => ['failed', 'timeout', 'interrupted'].includes(child.state))) {
        for (const child of finalChildren) {
          if (['pending', 'ready'].includes(child.state)) {
            child.state = TASK_STATES.BLOCKED;
            child.blockedReason = { code: 'scheduler_fail_fast', message: 'Blocked after a failed dependency branch' };
            await this.bus.append('task', { type: 'task.blocked', taskId: child.taskId, reason: child.blockedReason, ts: Date.now() }, { taskId: child.taskId });
          }
        }
        await this.refreshGraphState(parentTaskId);
        break;
      }
      break;
    }

    const finalState = await this.refreshGraphState(parentTaskId);
    await this.bus.append('scheduler', {
      type: 'scheduler.completed',
      taskId: parentTaskId,
      aggregate: finalState.aggregate,
      scheduledRunIds,
      ts: Date.now(),
    }, { taskId: parentTaskId });
    return {
      ok: finalState.aggregate.failed === 0 && finalState.aggregate.timeout === 0 && finalState.aggregate.interrupted === 0 && finalState.aggregate.blocked === 0,
      task: parent,
      children: finalState.children,
      aggregate: finalState.aggregate,
      scheduledRunIds,
    };
  }

  /** 从总线 replay 恢复状态 */
  async replay(seq = 1) {
    this.tasks.clear();
    this.runs.clear();
    this._running.clear();

    const events = await this.bus.readFrom(seq);
    for (const ev of events) {
      if (ev.kind === 'dispatch' && ev.payload?.action === 'task.created') {
        const task = ev.payload.task;
        this.tasks.set(task.taskId, {
          ...task,
          assignedRuns: [...(task.assignedRuns || [])],
          approval: task.approval || {
            status: task.sandboxMode === 'high-risk' ? 'pending' : 'not_required',
            reviewerId: null,
            agentId: null,
            reason: null,
            decidedAt: null,
          },
        });
      }

      if (ev.kind === 'approval') {
        const payload = ev.payload || {};
        const task = this.tasks.get(ev.taskId || payload.taskId);
        if (task && (payload.type === 'approval.granted' || payload.type === 'approval.denied')) {
          task.approval = {
            status: payload.type === 'approval.granted' ? 'approved' : 'rejected',
            reviewerId: payload.reviewerId || null,
            agentId: payload.agentId || null,
            reason: payload.reason || '',
            decidedAt: payload.decidedAt || ev.ts,
          };
        }
      }

      if (ev.kind === 'task') {
        const payload = ev.payload || {};
        const taskId = ev.taskId || payload.taskId;
        const task = this.tasks.get(taskId);
        if (payload.type === 'task.plan.accepted' && task) {
          task.planVersion = payload.planVersion || task.planVersion || 0;
          task.planStatus = 'accepted';
          task.planHash = payload.planHash || task.planHash || null;
          task.plannerRunId = payload.plannerRunId || task.plannerRunId || null;
          task.children = [...(payload.childIds || task.children || [])];
          task.blockedReason = null;
          task.aggregate = task.aggregate || null;
          task.state = TASK_STATES.PENDING;
        }
        if (payload.type === 'task.plan.rejected' && task) {
          task.planStatus = 'rejected';
          task.planRejection = { code: payload.code, message: payload.message };
        }
        if (payload.type === 'task.blocked' && task) {
          task.state = TASK_STATES.BLOCKED;
          task.blockedReason = payload.reason || { code: payload.code, message: payload.message, missingTags: payload.missingTags };
        }
        if (payload.type === 'task.ready' && task && task.state === TASK_STATES.PENDING) task.state = 'ready';
        if (payload.type === 'task.aggregate.updated' && task) {
          task.aggregate = payload.aggregate || null;
          const aggregate = task.aggregate;
          if (aggregate?.total > 0 && aggregate.completed === aggregate.total) task.state = TASK_STATES.AWAITING_REVIEW;
          else if (aggregate?.total > 0 && aggregate.blocked + aggregate.failed + aggregate.timeout + aggregate.interrupted === aggregate.total) {
            task.state = aggregate.blocked > 0 ? TASK_STATES.BLOCKED : TASK_STATES.FAILED;
          }
          else if (aggregate?.total > 0) task.state = TASK_STATES.RUNNING;
        }
      }

      if (ev.kind === 'bridge') {
        const payload = ev.payload || {};
        const runId = ev.runId || payload.runId;
        const run = this.runs.get(runId);
        const task = this.tasks.get(ev.taskId || payload.taskId || run?.taskId);
        if (run && payload.type === 'bridge.requested') {
          run.briefing = payload.briefing;
          run.bridgeRequestedAt = payload.ts || ev.ts;
          run.state = TASK_STATES.AWAITING_HUMAN;
          if (task) task.state = TASK_STATES.AWAITING_HUMAN;
        }
        if (run && payload.type === 'bridge.submitted') {
          run.bridgeSubmittedAt = payload.ts || ev.ts;
          run.untrusted = payload.untrusted === true;
          run.via = payload.via || 'human-bridge';
        }
      }

      if (ev.kind === 'run') {
        const payload = ev.payload || {};
        const runId = ev.runId || payload.runId;
        if (!runId) continue;

        const taskId = ev.taskId || payload.taskId;
        const agentId = ev.agentId || payload.agentId;
        const eventType = payload.type || payload.action;
        let run = this.runs.get(runId);
        if (eventType === 'run.created' && payload.run && typeof payload.run === 'object') {
          run = { ...payload.run };
          this.runs.set(runId, run);

          const task = this.tasks.get(run.taskId);
          if (task) {
            task.assignedRuns ||= [];
            if (!task.assignedRuns.includes(runId)) task.assignedRuns.push(runId);
            task.state = TASK_STATES.RUNNING;
          }
          continue;
        }

        if (!run) {
          run = { runId, taskId, agentId, state: TASK_STATES.RUNNING };
          this.runs.set(runId, run);

          const task = this.tasks.get(taskId);
          if (task) {
            task.assignedRuns ||= [];
            if (!task.assignedRuns.includes(runId)) task.assignedRuns.push(runId);
          }
        }

        const task = this.tasks.get(run.taskId);
        if (eventType === 'run.started') {
          run.state = TASK_STATES.RUNNING;
          run.startedAt = payload.ts ?? ev.ts;
        }
        if (eventType === 'run.completed') {
          run.state = TASK_STATES.COMPLETED;
          run.completedAt = payload.ts ?? ev.ts;
          if (Object.hasOwn(payload, 'text')) run.text = payload.text;
          if (Object.hasOwn(payload, 'cost')) run.cost = payload.cost;
          if (Object.hasOwn(payload, 'duration')) run.duration = payload.duration;
          if (payload.meta?.untrusted === true) run.untrusted = true;
          if (payload.meta?.via) run.via = payload.meta.via;
          if (task) task.state = TASK_STATES.AWAITING_REVIEW;
        }
        if (eventType === 'run.awaiting-human') {
          run.state = TASK_STATES.AWAITING_HUMAN;
          run.bridgeRequestedAt ||= payload.ts ?? ev.ts;
          if (task) task.state = TASK_STATES.AWAITING_HUMAN;
        }
        if (eventType === 'run.briefing-ready' && typeof payload.briefing === 'string') {
          run.briefing = payload.briefing;
        }
        if (eventType === 'run.failed') {
          run.state = TASK_STATES.FAILED;
          run.completedAt = payload.ts ?? ev.ts;
          run.error = payload.error || payload.text || payload.stderr;
          if (task) task.state = TASK_STATES.FAILED;
        }
        if (eventType === 'run.timeout') {
          run.state = TASK_STATES.TIMEOUT;
          run.completedAt = payload.ts ?? ev.ts;
          run.error = payload.error || payload.text;
          if (task) task.state = TASK_STATES.TIMEOUT;
        }
        if (eventType === 'run.interrupted') {
          run.state = TASK_STATES.INTERRUPTED;
          run.completedAt = payload.ts ?? ev.ts;
          run.error = payload.error || payload.reason || payload.text;
          if (task) task.state = TASK_STATES.INTERRUPTED;
        }
        if (eventType === 'run.snapshot.created') {
          if (payload.phase === 'before') run.snapshotBefore = payload.snapshot;
          if (payload.phase === 'after') run.snapshotAfter = payload.snapshot;
          if (payload.snapshot?.root) run.executionCwd = payload.snapshot.root;
          if (payload.snapshot?.scope) run.scope = payload.snapshot.scope;
        }
        if (eventType === 'run.diff.created') run.diff = payload.diff || null;
        if (eventType === 'run.applied') {
          run.appliedAt = payload.appliedAt || payload.ts || ev.ts;
          run.applySnapshot = payload.applySnapshot || null;
        }
        if (eventType === 'run.rolled-back') {
          run.rolledBackAt = payload.rolledBackAt || payload.ts || ev.ts;
        }
        if (eventType === 'run.apply.conflict') run.applyConflict = true;
      }

      if (ev.kind === 'verdict') {
        const payload = ev.payload || {};
        const eventType = payload.type;
        const verdict = eventType?.startsWith('verdict.') ? eventType.slice('verdict.'.length) : null;
        if (!SUPPORTED_VERDICTS.has(verdict)) continue;

        const runId = ev.runId || payload.runId;
        const run = this.runs.get(runId);
        if (!run) continue;

        run.verdict = verdict;
        run.reviewerId = payload.reviewerId;
        run.verdictReason = payload.reason;
        run.verdictAt = payload.verdictAt;

        const task = this.tasks.get(run.taskId);
        if (task) task.state = verdict;
      }
    }
  }
}

export default Orchestrator;
