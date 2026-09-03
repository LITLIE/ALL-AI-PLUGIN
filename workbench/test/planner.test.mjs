import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRuntime } from './helpers.mjs';
import { extractPlanText, parsePlannerPlan } from '../core/planner.mjs';

function plannerAdapter(output) {
  return {
    async *run({ taskId, runId }) {
      yield { type: 'run.started', taskId, runId, ts: Date.now() };
      yield { type: 'run.completed', taskId, runId, text: output, cost: 0, duration: 1, ts: Date.now() };
    },
  };
}

function addPlanner(runtime, output) {
  runtime.registry.agents.set('planner-test', {
    id: 'planner-test',
    type: 'echo',
    enabled: true,
    capabilityTags: ['design'],
    riskLevel: 'read-only',
    adapterInstance: plannerAdapter(output),
  });
  runtime.registry._probed.set('planner-test', { ok: true });
}

test('extracts fenced JSON and accepts a Planner plan into parent and child Tasks', async () => {
  const output = '```json\n{"tasks":[{"taskId":"task-child-a","title":"A","description":"first","requiredTags":["read"]},{"taskId":"task-child-b","title":"B","description":"second","dependencies":["task-child-a"],"requiredTags":["test"]}]}\n```';
  assert.equal(extractPlanText({ text: output }), '{"tasks":[{"taskId":"task-child-a","title":"A","description":"first","requiredTags":["read"]},{"taskId":"task-child-b","title":"B","description":"second","dependencies":["task-child-a"],"requiredTags":["test"]}]}');

  const runtime = await createRuntime();
  addPlanner(runtime, output);
  try {
    const parent = await runtime.orchestrator.createTask({ taskId: 'task-plan-parent', description: 'plan me', requiredTags: ['read'] });
    const result = await runtime.orchestrator.decomposeTask(parent.taskId, 'planner-test', 'break this down');
    assert.equal(result.ok, true);
    assert.equal(result.children.length, 2);
    assert.deepEqual(runtime.orchestrator.tasks.get(parent.taskId).children, ['task-child-a', 'task-child-b']);
    assert.equal(runtime.orchestrator.tasks.get('task-child-b').dependencies[0], 'task-child-a');

    const events = await runtime.bus.readAll();
    const planEvents = events.filter(event => event.payload?.type?.startsWith('task.plan.'));
    assert.deepEqual(planEvents.map(event => event.payload.type), ['task.plan.requested', 'task.plan.accepted']);
    assert.equal(Object.hasOwn(planEvents[0].payload, 'prompt'), false);
    assert.equal(Object.hasOwn(planEvents[1].payload, 'output'), false);
  } finally {
    await runtime.bus.close();
  }
});

test('rejects malformed or cyclic Planner output without creating children and conflicts on repeat decomposition', async () => {
  const runtime = await createRuntime();
  addPlanner(runtime, '{"tasks":[{"taskId":"task-a","dependencies":["task-b"]},{"taskId":"task-b","dependencies":["task-a"]}]}');
  try {
    const parent = await runtime.orchestrator.createTask({ taskId: 'task-plan-reject', description: 'reject me', requiredTags: ['read'] });
    const rejected = await runtime.orchestrator.decomposeTask(parent.taskId, 'planner-test');
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'dependency_cycle');
    assert.deepEqual(runtime.orchestrator.tasks.get(parent.taskId).children, []);
    assert.equal([...runtime.orchestrator.tasks.keys()].some(id => id === 'task-a' || id === 'task-b'), false);

    runtime.registry.agents.get('planner-test').adapterInstance = plannerAdapter('{"tasks":[{"taskId":"task-child","requiredTags":["read"]}]}');
    const accepted = await runtime.orchestrator.decomposeTask(parent.taskId, 'planner-test');
    assert.equal(accepted.ok, true);
    await assert.rejects(() => runtime.orchestrator.decomposeTask(parent.taskId, 'planner-test'), error => error.code === 'plan_conflict');
    const planHash = createHash('sha256').update('{"tasks":[{"taskId":"task-child","requiredTags":["read"]}]}').digest('hex');
    assert.equal(runtime.orchestrator.tasks.get(parent.taskId).planHash, planHash);
  } finally {
    await runtime.bus.close();
  }
});

test('parsePlannerPlan delegates schema validation to DAG normalization', () => {
  const parsed = parsePlannerPlan('{"tasks":[{"taskId":"task-child","requiredTags":["read"]}]}', {
    taskId: 'task-parent', description: 'parent', requiredTags: ['write'], cwd: 'C:\\workspace', sandboxMode: 'workspace-write',
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.plan.children[0].cwd, 'C:\\workspace');
});
