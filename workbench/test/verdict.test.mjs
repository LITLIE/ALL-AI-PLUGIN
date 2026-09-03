import test from 'node:test';
import assert from 'node:assert/strict';
import { completedEchoRuntime, createRuntime } from './helpers.mjs';

test('maker cannot review its own run', async () => {
  const { orchestrator, bus } = await completedEchoRuntime();
  const run = [...orchestrator.runs.values()][0];
  const before = orchestrator.tasks.get(run.taskId).state;
  const result = await orchestrator.submitVerdict(run.runId, 'passed', run.agentId, 'self review');
  const verdictEvents = (await bus.readAll()).filter(event => event.kind === 'verdict');

  assert.equal(result.ok, false);
  assert.equal(orchestrator.tasks.get(run.taskId).state, before);
  assert.equal(run.verdict, null);
  assert.equal(verdictEvents.length, 1);
  assert.deepEqual(verdictEvents[0].payload, {
    type: 'verdict.denied',
    runId: run.runId,
    attemptedVerdict: 'passed',
    reviewerId: run.agentId,
    reason: 'maker-checker violation',
  });
  assert.equal(verdictEvents[0].runId, run.runId);
  assert.equal(verdictEvents[0].taskId, run.taskId);
  assert.equal(verdictEvents[0].agentId, run.agentId);
  await bus.close();
});

test('independent reviewer can pass a run', async () => {
  const { orchestrator, bus } = await completedEchoRuntime();
  const run = [...orchestrator.runs.values()][0];
  const result = await orchestrator.submitVerdict(run.runId, 'passed', 'human', 'verified');
  const verdictEvents = (await bus.readAll()).filter(event => event.kind === 'verdict');

  assert.equal(result.ok, true);
  assert.equal(orchestrator.tasks.get(run.taskId).state, 'passed');
  assert.equal(verdictEvents.length, 1);
  assert.deepEqual(verdictEvents[0].payload, {
    type: 'verdict.passed',
    runId: run.runId,
    verdict: 'passed',
    reviewerId: 'human',
    reason: 'verified',
    verdictAt: run.verdictAt,
  });
  assert.equal(verdictEvents[0].runId, run.runId);
  assert.equal(verdictEvents[0].taskId, run.taskId);
  assert.equal(verdictEvents[0].agentId, 'human');
  await bus.close();
});

test('accepted rejected and rework verdicts set their matching task state', async () => {
  for (const verdict of ['rejected', 'rework']) {
    const { orchestrator, bus } = await completedEchoRuntime();
    const run = [...orchestrator.runs.values()][0];

    const result = await orchestrator.submitVerdict(run.runId, verdict, 'human', `${verdict} reason`);

    assert.equal(result.ok, true);
    assert.equal(orchestrator.tasks.get(run.taskId).state, verdict);
    assert.equal(run.verdict, verdict);
    await bus.close();
  }
});

test('unsupported verdict throws before mutation or persistence', async () => {
  const { orchestrator, bus } = await completedEchoRuntime();
  const run = [...orchestrator.runs.values()][0];
  const task = orchestrator.tasks.get(run.taskId);
  const beforeState = task.state;
  const beforeEvents = await bus.readAll();

  await assert.rejects(
    () => orchestrator.submitVerdict(run.runId, 'approved', 'human', 'invalid'),
    /unsupported verdict: approved/i,
  );

  assert.equal(task.state, beforeState);
  assert.equal(run.verdict, null);
  assert.deepEqual(await bus.readAll(), beforeEvents);
  await bus.close();
});

test('missing blank and non-string reviewers are rejected without a verdict event', async () => {
  for (const reviewerId of [undefined, '', '   ', 42, {}, []]) {
    const { orchestrator, bus } = await completedEchoRuntime();
    const run = [...orchestrator.runs.values()][0];
    const before = await bus.readAll();

    await assert.rejects(
      () => orchestrator.submitVerdict(run.runId, 'passed', reviewerId, 'invalid reviewer'),
      error => error?.code === 'invalid_reviewer' && error?.statusCode === 400,
    );

    assert.equal(run.verdict, null);
    assert.deepEqual(await bus.readAll(), before);
    await bus.close();
  }
});

test('run not awaiting review is rejected without persistence', async () => {
  const { orchestrator, bus } = await completedEchoRuntime();
  const run = [...orchestrator.runs.values()][0];
  const task = orchestrator.tasks.get(run.taskId);
  task.state = 'passed';
  const beforeEvents = await bus.readAll();

  const result = await orchestrator.submitVerdict(run.runId, 'rework', 'human', 'too late');

  assert.deepEqual(result, { ok: false, reason: 'run is not awaiting review' });
  assert.equal(task.state, 'passed');
  assert.equal(run.verdict, null);
  assert.deepEqual(await bus.readAll(), beforeEvents);
  await bus.close();
});

test('replay restores an accepted verdict and ignores denied verdict mutation', async () => {
  const first = await completedEchoRuntime();
  const run = [...first.orchestrator.runs.values()][0];
  await first.orchestrator.submitVerdict(run.runId, 'passed', run.agentId, 'self review');
  await first.orchestrator.submitVerdict(run.runId, 'rework', 'human', 'needs changes');
  const expectedVerdictAt = run.verdictAt;
  await first.bus.close();

  const second = await createRuntime({ storeDir: first.storeDir });
  await second.orchestrator.replay();
  const replayedRun = second.orchestrator.runs.get(run.runId);

  assert.equal(second.orchestrator.tasks.get(run.taskId).state, 'rework');
  assert.equal(replayedRun.verdict, 'rework');
  assert.equal(replayedRun.reviewerId, 'human');
  assert.equal(replayedRun.verdictReason, 'needs changes');
  assert.equal(replayedRun.verdictAt, expectedVerdictAt);
  await second.bus.close();
});
