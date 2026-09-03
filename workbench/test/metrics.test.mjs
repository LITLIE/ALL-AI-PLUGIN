import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../core/bus.mjs';
import { aggregateMetrics, appendMetric, metricPayload } from '../core/metrics.mjs';

test('metricPayload validates finite values and keeps only metric metadata', () => {
  assert.deepEqual(metricPayload('run.completed', 1, {
    runId: 'run-1', taskId: 'task-1', agentId: 'echo-test', attempt: 0,
    dimensions: { outcome: 'success' }, prompt: 'secret prompt',
  }), {
    name: 'run.completed',
    value: 1,
    unit: 'count',
    runId: 'run-1',
    taskId: 'task-1',
    agentId: 'echo-test',
    attempt: 0,
    dimensions: { outcome: 'success' },
  });
  assert.throws(() => metricPayload('run.failed', Number.NaN), /finite number/i);
});

test('appendMetric persists a metric event without prompt text', async () => {
  const store = await mkdtemp(join(tmpdir(), 'awb-metrics-'));
  const bus = new EventBus(join(store, 'eventbus'));
  await bus.init();
  try {
    await appendMetric(bus, 'run.duration_ms', 42, {
      runId: 'run-1', taskId: 'task-1', agentId: 'echo-test', prompt: 'do not persist',
    });
    const [event] = await bus.readAll();
    assert.equal(event.kind, 'metric');
    assert.deepEqual(event.payload, {
      name: 'run.duration_ms', value: 42, unit: 'ms',
      runId: 'run-1', taskId: 'task-1', agentId: 'echo-test',
    });
    assert.doesNotMatch(JSON.stringify(event), /do not persist/);
  } finally {
    await bus.close();
  }
});

test('aggregateMetrics filters by timestamp and summarizes outcomes, durations, and retries', () => {
  const now = Date.now();
  const events = [
    { kind: 'metric', ts: new Date(now - 1000).toISOString(), payload: { name: 'run.completed', value: 1, unit: 'count', agentId: 'echo-test', dimensions: { outcome: 'success' } } },
    { kind: 'metric', ts: new Date(now - 900).toISOString(), payload: { name: 'run.duration_ms', value: 20, unit: 'ms', agentId: 'echo-test' } },
    { kind: 'metric', ts: new Date(now - 800).toISOString(), payload: { name: 'run.duration_ms', value: 40, unit: 'ms', agentId: 'echo-test' } },
    { kind: 'metric', ts: new Date(now - 700).toISOString(), payload: { name: 'run.retry', value: 1, unit: 'count', agentId: 'echo-test' } },
    { kind: 'metric', ts: new Date(now - 600).toISOString(), payload: { name: 'run.failed', value: 1, unit: 'count', agentId: 'echo-test', dimensions: { outcome: 'failed' } } },
    { kind: 'metric', ts: new Date(now - 90_000).toISOString(), payload: { name: 'run.completed', value: 1, unit: 'count', agentId: 'old-agent', dimensions: { outcome: 'success' } } },
  ];
  assert.deepEqual(aggregateMetrics(events, { sinceMs: 10_000 }), {
    counts: { 'run.completed': 1, 'run.failed': 1 },
    durations: { count: 2, totalMs: 60, averageMs: 30 },
    retries: 1,
    agents: {
      'echo-test': { completed: 1, failed: 1, timeout: 0, interrupted: 0 },
    },
  });
});
