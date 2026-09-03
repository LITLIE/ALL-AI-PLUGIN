import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from './helpers.mjs';
import { aggregateMetrics } from '../core/metrics.mjs';

test('orchestrator emits lifecycle metrics for successful runs', async () => {
  const { bus, orchestrator } = await createRuntime();
  try {
    const task = await orchestrator.createTask({ taskId: 'task-metric-success', description: 'metrics', requiredTags: ['read'] });
    const run = await orchestrator.dispatch(task.taskId, 'echo-test', 'metrics');
    await orchestrator.waitForRun(run.runId);
    const events = await bus.readAll();
    const metricEvents = events.filter(event => event.kind === 'metric' && event.taskId === task.taskId);
    assert.ok(metricEvents.some(event => event.payload.name === 'run.started'));
    assert.ok(metricEvents.some(event => event.payload.name === 'run.completed'));
    assert.ok(metricEvents.some(event => event.payload.name === 'run.duration_ms'));
    assert.ok(metricEvents.some(event => event.payload.name === 'run.cost'));
    assert.equal(orchestrator.tasks.get(task.taskId).state, 'awaiting-review');
  } finally {
    await bus.close();
  }
});

test('aggregateMetrics reports retry and timeout lifecycle outcomes', () => {
  const now = new Date().toISOString();
  const metrics = aggregateMetrics([
    { kind: 'metric', ts: now, payload: { name: 'run.failed', value: 1, agentId: 'fixture', dimensions: { outcome: 'failed' } } },
    { kind: 'metric', ts: now, payload: { name: 'run.retry', value: 1, agentId: 'fixture' } },
    { kind: 'metric', ts: now, payload: { name: 'run.timeout', value: 1, agentId: 'fixture', dimensions: { outcome: 'timeout' } } },
  ]);
  assert.deepEqual(metrics.counts, { 'run.failed': 1, 'run.timeout': 1 });
  assert.equal(metrics.retries, 1);
  assert.deepEqual(metrics.agents.fixture, { completed: 0, failed: 1, timeout: 1, interrupted: 0 });
});
