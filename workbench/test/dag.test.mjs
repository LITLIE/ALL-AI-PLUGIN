import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlan, validateDependencies, readyChildren, aggregateChildren } from '../core/dag.mjs';

const parent = {
  taskId: 'task-parent',
  description: 'parent',
  requiredTags: ['write'],
  cwd: 'C:\\workspace',
  sandboxMode: 'workspace-write',
  maxRetries: 1,
};

test('normalizes a bounded plan and inherits parent execution defaults', () => {
  const result = normalizePlan({ tasks: [
    { taskId: 'task-one', title: 'One', description: 'first', requiredTags: ['read'], unknown: 'ignored' },
    { taskId: 'task-two', title: 'Two', description: 'second', dependencies: ['task-one'] },
    { taskId: 'task-three', title: 'Three', description: 'third', sandboxMode: 'read-only' },
  ] }, parent);

  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.order, ['task-one', 'task-two', 'task-three']);
  assert.equal(result.plan.children[1].cwd, parent.cwd);
  assert.deepEqual(result.plan.children[1].requiredTags, parent.requiredTags);
  assert.equal(result.plan.children[2].sandboxMode, 'read-only');
  assert.equal(Object.hasOwn(result.plan.children[0], 'unknown'), false);
});

test('rejects duplicate, unknown, self, cyclic, oversized, invalid capability, and unsafe risk plans', () => {
  const cases = [
    [{ tasks: [{ taskId: 'task-a' }, { taskId: 'task-a' }] }, 'duplicate_task_id'],
    [{ tasks: [{ taskId: 'task-a', dependencies: ['task-missing'] }] }, 'unknown_dependency'],
    [{ tasks: [{ taskId: 'task-a', dependencies: ['task-a'] }] }, 'self_dependency'],
    [{ tasks: [{ taskId: 'task-a', dependencies: ['task-b'] }, { taskId: 'task-b', dependencies: ['task-a'] }] }, 'dependency_cycle'],
    [{ tasks: Array.from({ length: 65 }, (_, i) => ({ taskId: `task-${i}` })) }, 'too_many_tasks'],
    [{ tasks: [{ taskId: 'task-a', requiredTags: ['unknown'] }] }, 'unknown_capability'],
    [{ tasks: [{ taskId: 'task-a', sandboxMode: 'read-only' }] }, 'risk_downgrade'],
  ];

  for (const [raw, code] of cases) {
    const result = normalizePlan(raw, { ...parent, sandboxMode: code === 'risk_downgrade' ? 'high-risk' : parent.sandboxMode });
    assert.equal(result.ok, false, code);
    assert.equal(result.error.code, code);
  }
});

test('validates dependencies, selects ready children, and aggregates child outcomes', () => {
  const children = [
    { taskId: 'task-a', dependencies: [], state: 'awaiting-review' },
    { taskId: 'task-b', dependencies: ['task-a'], state: 'pending' },
    { taskId: 'task-c', dependencies: [], state: 'blocked' },
  ];

  assert.deepEqual(validateDependencies(children), { ok: true, order: ['task-a', 'task-b', 'task-c'] });
  assert.deepEqual(readyChildren(children, { children: ['task-a', 'task-b', 'task-c'] }).map(task => task.taskId), ['task-b']);
  assert.deepEqual(aggregateChildren(new Map(children.map(task => [task.taskId, task])), ['task-a', 'task-b', 'task-c']), {
    total: 3, completed: 1, failed: 0, timeout: 0, interrupted: 0, blocked: 1,
  });
});
