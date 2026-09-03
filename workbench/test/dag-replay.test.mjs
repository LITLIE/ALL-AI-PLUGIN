import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from './helpers.mjs';

function plannerOutput() {
  return '{"tasks":[{"taskId":"task-replay-a","requiredTags":["read"]},{"taskId":"task-replay-b","requiredTags":["test"],"dependencies":["task-replay-a"]}]}';
}

function addPlanner(runtime) {
  runtime.registry.agents.set('planner-test', {
    id: 'planner-test', type: 'echo', enabled: true, capabilityTags: ['design'], riskLevel: 'read-only',
    adapterInstance: {
      async *run({ taskId, runId }) {
        yield { type: 'run.started', taskId, runId, ts: Date.now() };
        yield { type: 'run.completed', taskId, runId, text: plannerOutput(), ts: Date.now() };
      },
    },
  });
  runtime.registry._probed.set('planner-test', { ok: true });
}

test('replay restores accepted parent-child DAG relationships and dependencies', async () => {
  const first = await createRuntime();
  addPlanner(first);
  const parent = await first.orchestrator.createTask({ taskId: 'task-replay-parent', description: 'parent', requiredTags: ['read'] });
  await first.orchestrator.decomposeTask(parent.taskId, 'planner-test');
  await first.bus.close();

  const second = await createRuntime({ storeDir: first.storeDir });
  try {
    await second.orchestrator.replay();
    const restored = second.orchestrator.getTaskSnapshot(parent.taskId);
    assert.deepEqual(restored.children, ['task-replay-a', 'task-replay-b']);
    assert.equal(restored.planVersion, 1);
    assert.equal(restored.planStatus, 'accepted');
    assert.equal(restored.runs.length, 1);
    assert.equal(restored.childTasks.length, 2);
    assert.deepEqual(second.orchestrator.tasks.get('task-replay-b').dependencies, ['task-replay-a']);
  } finally {
    await second.bus.close();
  }
});

test('replay restores blocked reason and parent aggregate without dispatching a Run', async () => {
  const runtime = await createRuntime();
  try {
    const parent = await runtime.orchestrator.createTask({ taskId: 'task-replay-blocked-parent', description: 'parent', requiredTags: ['read'] });
    const child = await runtime.orchestrator.createTask({ taskId: 'task-replay-blocked-child', description: 'child', requiredTags: ['missing'], parentTaskId: parent.taskId });
    parent.children = [child.taskId];
    await runtime.bus.append('task', { type: 'task.plan.accepted', taskId: parent.taskId, planVersion: 1, childIds: [child.taskId], planHash: 'hash', ts: Date.now() }, { taskId: parent.taskId });
    await runtime.bus.append('task', { type: 'task.blocked', taskId: child.taskId, reason: { code: 'missing_capability', message: 'missing', missingTags: ['missing'] }, ts: Date.now() }, { taskId: child.taskId });
    await runtime.bus.append('task', { type: 'task.aggregate.updated', taskId: parent.taskId, aggregate: { total: 1, completed: 0, failed: 0, timeout: 0, interrupted: 0, blocked: 1 }, ts: Date.now() }, { taskId: parent.taskId });
    await runtime.bus.close();

    const replayed = await createRuntime({ storeDir: runtime.storeDir });
    try {
      await replayed.orchestrator.replay();
      assert.equal(replayed.orchestrator.tasks.get(child.taskId).state, 'blocked');
      assert.deepEqual(replayed.orchestrator.tasks.get(child.taskId).blockedReason, { code: 'missing_capability', message: 'missing', missingTags: ['missing'] });
      assert.deepEqual(replayed.orchestrator.tasks.get(parent.taskId).aggregate, { total: 1, completed: 0, failed: 0, timeout: 0, interrupted: 0, blocked: 1 });
      assert.equal(replayed.orchestrator.tasks.get(parent.taskId).state, 'blocked');
      assert.equal(replayed.orchestrator.runs.size, 0);
    } finally {
      await replayed.bus.close();
    }
  } finally {
    if (runtime.bus._writer) await runtime.bus.close();
  }
});

test('refreshGraphState propagates dependency blocks and persists aggregate changes', async () => {
  const runtime = await createRuntime();
  try {
    const parent = await runtime.orchestrator.createTask({ taskId: 'task-refresh-parent', description: 'parent', requiredTags: ['read'] });
    const blocked = await runtime.orchestrator.createTask({ taskId: 'task-refresh-a', description: 'blocked', requiredTags: ['missing'], parentTaskId: parent.taskId });
    const dependent = await runtime.orchestrator.createTask({ taskId: 'task-refresh-b', description: 'dependent', requiredTags: ['read'], dependencies: [blocked.taskId], parentTaskId: parent.taskId });
    parent.children = [blocked.taskId, dependent.taskId];
    blocked.state = 'blocked';
    blocked.blockedReason = { code: 'missing_capability', message: 'missing', missingTags: ['missing'] };

    const result = await runtime.orchestrator.refreshGraphState(parent.taskId);
    assert.equal(result.aggregate.blocked, 2);
    assert.equal(dependent.state, 'blocked');
    assert.equal(dependent.blockedReason.code, 'dependency_blocked');
    const events = await runtime.bus.readAll();
    assert.ok(events.some(event => event.payload?.type === 'task.blocked' && event.taskId === dependent.taskId));
    assert.ok(events.some(event => event.payload?.type === 'task.aggregate.updated' && event.taskId === parent.taskId));
  } finally {
    await runtime.bus.close();
  }
});
