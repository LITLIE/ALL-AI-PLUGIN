import { CAPABILITY_TAGS, RISK_LEVELS } from '../config/schema.mjs';

const TASK_ID_PATTERN = /^task-[A-Za-z0-9][A-Za-z0-9_-]{0,126}$/;
const EXECUTION_SUCCESS_STATES = new Set(['awaiting-review', 'passed']);

function failure(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } };
}

function normalizeTags(value, fallback) {
  const tags = value === undefined ? fallback : value;
  if (!Array.isArray(tags) || tags.length === 0 || tags.some(tag => typeof tag !== 'string' || !CAPABILITY_TAGS.has(tag))) return null;
  return [...new Set(tags)];
}

export function validateDependencies(children = []) {
  const byId = new Map(children.map(child => [child.taskId, child]));
  const indegree = new Map(children.map(child => [child.taskId, 0]));
  const edges = new Map(children.map(child => [child.taskId, []]));

  for (const child of children) {
    for (const dependency of child.dependencies || []) {
      if (!byId.has(dependency)) return failure('unknown_dependency', `Unknown dependency: ${dependency}`);
      if (dependency === child.taskId) return failure('self_dependency', `Task cannot depend on itself: ${child.taskId}`);
      edges.get(dependency).push(child.taskId);
      indegree.set(child.taskId, indegree.get(child.taskId) + 1);
    }
  }

  const position = new Map(children.map((child, index) => [child.taskId, index]));
  const queue = children.filter(child => indegree.get(child.taskId) === 0).map(child => child.taskId);
  queue.sort((left, right) => position.get(left) - position.get(right));
  const order = [];
  while (queue.length > 0) {
    const taskId = queue.shift();
    order.push(taskId);
    for (const dependent of edges.get(taskId)) {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) {
        queue.push(dependent);
        queue.sort((left, right) => position.get(left) - position.get(right));
      }
    }
  }
  if (order.length !== children.length) return failure('dependency_cycle', 'Task dependencies contain a cycle');
  return { ok: true, order };
}

export function normalizePlan(rawPlan, parentTask, { maxChildren = 64 } = {}) {
  if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan) || !Array.isArray(rawPlan.tasks)) {
    return failure('invalid_plan', 'Planner output must be an object with a tasks array');
  }
  if (rawPlan.tasks.length < 1) return failure('empty_plan', 'Planner plan must contain at least one task');
  if (rawPlan.tasks.length > maxChildren) return failure('too_many_tasks', `Planner plan cannot contain more than ${maxChildren} tasks`);

  const seen = new Set();
  const children = [];
  for (const raw of rawPlan.tasks) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return failure('invalid_task', 'Each planned task must be an object');
    const taskId = raw.taskId;
    if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) return failure('invalid_task_id', `Invalid task ID: ${taskId}`);
    if (seen.has(taskId)) return failure('duplicate_task_id', `Duplicate task ID: ${taskId}`);
    seen.add(taskId);

    const requiredTags = normalizeTags(raw.requiredTags, parentTask.requiredTags || []);
    if (!requiredTags) return failure('unknown_capability', `Invalid capability tags for task: ${taskId}`);

    const sandboxMode = raw.sandboxMode || parentTask.sandboxMode || 'workspace-write';
    if (!RISK_LEVELS.includes(sandboxMode)) return failure('invalid_sandbox_mode', `Invalid sandbox mode: ${sandboxMode}`);
    if (parentTask.sandboxMode === 'high-risk' && sandboxMode !== 'high-risk') {
      return failure('risk_downgrade', `High-risk parent cannot create lower-risk task: ${taskId}`);
    }

    const dependencies = raw.dependencies === undefined ? [] : raw.dependencies;
    if (!Array.isArray(dependencies) || dependencies.some(value => typeof value !== 'string')) {
      return failure('invalid_dependencies', `Dependencies must be string IDs: ${taskId}`);
    }

    children.push({
      taskId,
      title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : taskId,
      description: typeof raw.description === 'string' ? raw.description : parentTask.description || '',
      requiredTags,
      dependencies: [...new Set(dependencies)],
      cwd: parentTask.cwd,
      sandboxMode,
      scope: raw.scope === undefined ? parentTask.scope || null : raw.scope,
      maxRetries: parentTask.maxRetries,
      retryBaseDelayMs: parentTask.retryBaseDelayMs,
      retryMaxDelayMs: parentTask.retryMaxDelayMs,
      timeoutMs: parentTask.timeoutMs,
      interruptGraceMs: parentTask.interruptGraceMs,
    });
  }

  const dependencyResult = validateDependencies(children);
  if (!dependencyResult.ok) return dependencyResult;
  return { ok: true, plan: { children, order: dependencyResult.order } };
}

function asTaskMap(tasks) {
  return tasks instanceof Map ? tasks : new Map((tasks || []).map(task => [task.taskId, task]));
}

export function readyChildren(tasks, parentTask) {
  const byId = asTaskMap(tasks);
  return (parentTask.children || [])
    .map(taskId => byId.get(taskId))
    .filter(Boolean)
    .filter(task => ['pending', 'ready'].includes(task.state))
    .filter(task => (task.dependencies || []).every(dependency => EXECUTION_SUCCESS_STATES.has(byId.get(dependency)?.state)));
}

export function aggregateChildren(tasks, childIds = []) {
  const byId = asTaskMap(tasks);
  const aggregate = { total: childIds.length, completed: 0, failed: 0, timeout: 0, interrupted: 0, blocked: 0 };
  for (const taskId of childIds) {
    const state = byId.get(taskId)?.state;
    if (EXECUTION_SUCCESS_STATES.has(state) || state === 'completed') aggregate.completed += 1;
    else if (state === 'failed' || state === 'rejected' || state === 'rework') aggregate.failed += 1;
    else if (state === 'timeout') aggregate.timeout += 1;
    else if (state === 'interrupted') aggregate.interrupted += 1;
    else if (state === 'blocked') aggregate.blocked += 1;
  }
  return aggregate;
}

export default { normalizePlan, validateDependencies, readyChildren, aggregateChildren };
