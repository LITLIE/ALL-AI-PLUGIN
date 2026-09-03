import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from './helpers.mjs';

function graphAdapter({ delayMs = 15, failDescriptions = new Set(), tracker }) {
  return {
    async *run({ taskId, runId, prompt }) {
      tracker.active += 1;
      tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
      tracker.events.push(`started:${prompt}`);
      yield { type: 'run.started', taskId, runId, ts: Date.now() };
      await new Promise(resolve => setTimeout(resolve, delayMs));
      if (failDescriptions.has(prompt)) {
        tracker.events.push(`failed:${prompt}`);
        tracker.active -= 1;
        yield { type: 'run.failed', taskId, runId, error: 'fixture failure', ts: Date.now() };
        return;
      }
      tracker.events.push(`completed:${prompt}`);
      tracker.active -= 1;
      yield { type: 'run.completed', taskId, runId, text: prompt, ts: Date.now() };
    },
  };
}

async function makeGraph(runtime, specs) {
  const target = await mkdtemp(join(tmpdir(), 'awb-scheduler-target-'));
  const parent = await runtime.orchestrator.createTask({ taskId: 'task-scheduler-parent', description: 'graph', requiredTags: ['read'], cwd: target });
  parent.planStatus = 'accepted';
  parent.planVersion = 1;
  parent.children = [];
  for (const spec of specs) {
    const child = await runtime.orchestrator.createTask({
      taskId: spec.taskId,
      description: spec.description,
      requiredTags: spec.requiredTags || ['read'],
      dependencies: spec.dependencies || [],
      agentHints: spec.agentHints || ['echo-test'],
      parentTaskId: parent.taskId,
      cwd: parent.cwd,
    });
    parent.children.push(child.taskId);
  }
  return { parent, target };
}

test('runTaskGraph executes independent children in parallel and waits for dependencies', async () => {
  const runtime = await createRuntime();
  const tracker = { active: 0, maxActive: 0, events: [] };
  const agent = runtime.registry.agents.get('echo-test');
  const original = agent.adapterInstance;
  agent.adapterInstance = graphAdapter({ tracker });
  let target;
  try {
    const graph = await makeGraph(runtime, [
      { taskId: 'task-a', description: 'a' },
      { taskId: 'task-b', description: 'b' },
      { taskId: 'task-c', description: 'c', dependencies: ['task-a'] },
    ]);
    target = graph.target;
    const { parent } = graph;
    const result = await runtime.orchestrator.runTaskGraph(parent.taskId, { maxParallel: 2 });
    assert.equal(result.ok, true);
    assert.equal(tracker.maxActive, 2);
    assert.ok(tracker.events.indexOf('completed:a') < tracker.events.indexOf('started:c'));
    assert.equal(result.aggregate.completed, 3);
    assert.equal(new Set(result.scheduledRunIds).size, 3);
  } finally {
    agent.adapterInstance = original;
    await runtime.bus.close();
    await rm(target, { recursive: true, force: true });
  }
});

test('runTaskGraph blocks missing capabilities and is idempotent on repeat calls', async () => {
  const runtime = await createRuntime();
  const tracker = { active: 0, maxActive: 0, events: [] };
  const agent = runtime.registry.agents.get('echo-test');
  const original = agent.adapterInstance;
  agent.adapterInstance = graphAdapter({ tracker });
  let target;
  try {
    const graph = await makeGraph(runtime, [
      { taskId: 'task-missing', description: 'missing', requiredTags: ['does-not-exist'] },
    ]);
    target = graph.target;
    const { parent } = graph;
    const first = await runtime.orchestrator.runTaskGraph(parent.taskId);
    const eventCount = (await runtime.bus.readAll()).length;
    const second = await runtime.orchestrator.runTaskGraph(parent.taskId);
    assert.equal(first.aggregate.blocked, 1);
    assert.equal(second.aggregate.blocked, 1);
    assert.equal(runtime.orchestrator.tasks.get('task-missing').state, 'blocked');
    assert.equal(runtime.orchestrator.runs.size, 0);
    assert.equal((await runtime.bus.readAll()).filter(event => event.payload?.type === 'task.blocked').length, 1);
    assert.ok((await runtime.bus.readAll()).length >= eventCount);
  } finally {
    agent.adapterInstance = original;
    await runtime.bus.close();
    await rm(target, { recursive: true, force: true });
  }
});

test('runTaskGraph fail-fast blocks descendants after a failed child', async () => {
  const runtime = await createRuntime();
  const tracker = { active: 0, maxActive: 0, events: [] };
  const agent = runtime.registry.agents.get('echo-test');
  const original = agent.adapterInstance;
  agent.adapterInstance = graphAdapter({ tracker, failDescriptions: new Set(['fail']) });
  let target;
  try {
    const graph = await makeGraph(runtime, [
      { taskId: 'task-fail', description: 'fail' },
      { taskId: 'task-dependent', description: 'dependent', dependencies: ['task-fail'] },
    ]);
    target = graph.target;
    const { parent } = graph;
    const result = await runtime.orchestrator.runTaskGraph(parent.taskId);
    assert.equal(result.aggregate.failed, 1);
    assert.equal(runtime.orchestrator.tasks.get('task-dependent').state, 'blocked');
    assert.equal(runtime.orchestrator.runs.size, 1);
  } finally {
    agent.adapterInstance = original;
    await runtime.bus.close();
    await rm(target, { recursive: true, force: true });
  }
});
