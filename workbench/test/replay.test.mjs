import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile as readText, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventBus } from '../core/bus.mjs';
import { createRuntime, tempWorkspace } from './helpers.mjs';

test('integrity detects a seq gap and malformed line', async () => {
  const dir = await tempWorkspace();
  const file = join(dir, 'bus.jsonl');
  await writeFile(file, '{"seq":1,"kind":"system","payload":{}}\n{"seq":3,"kind":"system","payload":{}}\nnot-json\n');
  const bus = new EventBus(dir);
  const report = await bus.integrityCheck();
  assert.equal(report.ok, false);
  assert.deepEqual(report.errors.map(e => e.error), ['seq_gap', 'invalid_json']);
  await assert.rejects(() => bus.readAll(), /line 3/i);
});

test('integrity rejects every interior blank line', async () => {
  const dir = await tempWorkspace();
  const file = join(dir, 'bus.jsonl');
  await writeFile(file, '{"seq":1,"kind":"system","payload":{}}\n\n{"seq":2,"kind":"system","payload":{}}\n');

  const bus = new EventBus(dir);
  const report = await bus.integrityCheck();
  assert.equal(report.ok, false);
  assert.equal(report.totalLines, 3);
  assert.deepEqual(report.errors, [
    { error: 'blank_line', line: 2 },
  ]);
});

test('initialization rejects an interior blank and a non-contiguous stored seq', async () => {
  const dir = await tempWorkspace();
  const file = join(dir, 'bus.jsonl');
  await writeFile(file, '{"seq":1,"kind":"system","payload":{}}\n\n{"seq":3,"kind":"system","payload":{}}\n');

  const bus = new EventBus(dir);
  const report = await bus.integrityCheck();
  assert.equal(report.ok, false);
  assert.deepEqual(report.errors, [
    { error: 'blank_line', line: 2 },
    { error: 'seq_gap', line: 3, expectedSeq: 2, actualSeq: 3 },
  ]);
  await assert.rejects(() => bus.init(), /blank_line at line 2/i);
});

test('a single final newline remains legal and append resumes contiguously', async () => {
  const dir = await tempWorkspace();
  const file = join(dir, 'bus.jsonl');
  await writeFile(file, '{"seq":1,"kind":"system","payload":{}}\n');

  const bus = new EventBus(dir);
  assert.deepEqual(await bus.integrityCheck(), { ok: true, totalLines: 1 });
  await bus.init();
  const appended = await bus.append('system', { value: 2 });

  assert.equal(appended.seq, 2);
  assert.deepEqual((await bus.readAll()).map(event => event.seq), [1, 2]);
  await bus.close();
});

test('readFrom includes the event at the requested sequence', async () => {
  const dir = await tempWorkspace();
  const file = join(dir, 'bus.jsonl');
  await writeFile(file, '{"seq":1,"kind":"system","payload":{"value":1}}\n{"seq":2,"kind":"system","payload":{"value":2}}\n');

  const bus = new EventBus(dir);
  const events = await bus.readFrom(2);
  assert.deepEqual(events.map(event => event.seq), [2]);
});

test('initialization rejects a corrupt existing store', async () => {
  const dir = await tempWorkspace();
  const file = join(dir, 'bus.jsonl');
  await writeFile(file, '{"seq":2,"kind":"system","payload":{}}\n');

  const bus = new EventBus(dir);
  await assert.rejects(() => bus.init(), /line 1/i);
});

test('replay restores completed Echo task and run', async () => {
  const first = await createRuntime();
  const task = await first.orchestrator.createTask({ taskId: 'task-replay', description: 'ping', requiredTags: ['read'] });
  const run = await first.orchestrator.dispatch(task.taskId, 'echo-test', 'ping');
  await first.orchestrator.waitForRun(run.runId);
  const expected = { ...run };
  delete expected.prompt;
  await first.bus.close();

  const second = await createRuntime({ storeDir: first.storeDir });
  second.orchestrator.tasks.set('stale-task', { taskId: 'stale-task' });
  second.orchestrator.runs.set('stale-run', { runId: 'stale-run' });
  await second.orchestrator.replay();
  assert.equal(second.orchestrator.tasks.has('stale-task'), false);
  assert.equal(second.orchestrator.runs.has('stale-run'), false);
  assert.equal(second.orchestrator.tasks.get('task-replay').state, 'awaiting-review');
  assert.deepEqual(second.orchestrator.tasks.get('task-replay').assignedRuns, [run.runId]);
  const replayed = second.orchestrator.runs.get(run.runId);
  assert.deepEqual(replayed, expected);
  await second.bus.close();
});

test('replay restores failed, timeout, and interrupted run outcomes', async () => {
  const cases = [
    { type: 'run.failed', runState: 'failed', taskState: 'failed' },
    { type: 'run.timeout', runState: 'timeout', taskState: 'timeout' },
    { type: 'run.interrupted', runState: 'interrupted', taskState: 'interrupted' },
  ];

  for (const scenario of cases) {
    const dir = await tempWorkspace();
    const file = join(dir, 'bus.jsonl');
    const taskId = `task-${scenario.runState}`;
    const runId = `run-${scenario.runState}`;
    const task = {
      taskId,
      description: scenario.type,
      state: 'pending',
      assignedRuns: [],
    };
    const events = [
      { ts: '2026-08-31T00:00:00.000Z', seq: 1, kind: 'dispatch', taskId, payload: { action: 'task.created', task } },
      { ts: '2026-08-31T00:00:01.000Z', seq: 2, kind: 'run', taskId, runId, agentId: 'echo-test', payload: { type: scenario.type, error: 'stopped' } },
    ];
    await writeFile(file, `${events.map(event => JSON.stringify(event)).join('\n')}\n`);

    const runtime = await createRuntime({ storeDir: dir });
    await runtime.orchestrator.replay();
    assert.equal(runtime.orchestrator.runs.get(runId).state, scenario.runState);
    assert.equal(runtime.orchestrator.tasks.get(taskId).state, scenario.taskState);
    await runtime.bus.close();
  }
});

test('replay restores diff, applied, and rolled-back run metadata', async () => {
  const target = await tempWorkspace();
  await writeFile(join(target, 'note.txt'), 'before');
  const first = await createRuntime();
  const adapter = await import('../adapters/index.mjs').then(({ loadAdapter }) => loadAdapter({ type: 'echo' }));
  const originalRun = adapter.run;
  adapter.run = async function* (options) {
    yield { type: 'run.started', taskId: options.taskId, runId: options.runId, ts: Date.now() };
    await writeFile(join(options.cwd, 'note.txt'), 'after');
    yield { type: 'run.completed', taskId: options.taskId, runId: options.runId, text: 'changed', ts: Date.now() };
  };
  try {
    const task = await first.orchestrator.createTask({ taskId: 'task-replay-apply', description: 'apply', requiredTags: ['read'], cwd: target });
    const run = await first.orchestrator.dispatch(task.taskId, 'echo-test', 'change');
    await first.orchestrator.waitForRun(run.runId);
    await first.orchestrator.submitVerdict(run.runId, 'passed', 'human');
    await first.orchestrator.apply(run.runId);
    await first.orchestrator.rollback(run.runId);
    const expected = { diff: run.diff, appliedAt: run.appliedAt, rolledBackAt: run.rolledBackAt };
    await first.bus.close();

    const second = await createRuntime({ storeDir: first.storeDir });
    await second.orchestrator.replay();
    const replayed = second.orchestrator.runs.get(run.runId);
    assert.deepEqual({ diff: replayed.diff, appliedAt: replayed.appliedAt, rolledBackAt: replayed.rolledBackAt }, expected);
    assert.equal(await readText(join(target, 'note.txt'), 'utf8'), 'before');
    await second.bus.close();
  } finally {
    adapter.run = originalRun;
    if (first.bus._writer) await first.bus.close().catch(() => {});
  }
});
