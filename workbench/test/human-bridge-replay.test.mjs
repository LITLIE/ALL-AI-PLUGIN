import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, tempWorkspace } from './helpers.mjs';

test('replay restores an awaiting-human bridge run and briefing', async () => {
  const first = await createRuntime();
  const task = await first.orchestrator.createTask({
    taskId: 'task-bridge-replay-waiting',
    description: 'Replay waiting bridge',
    requiredTags: ['write'],
    cwd: await tempWorkspace(),
  });
  const run = await first.orchestrator.dispatch(task.taskId, 'trae-solo-bridge', task.description);
  await first.orchestrator.waitForRun(run.runId);
  await first.bus.close();

  const second = await createRuntime({ storeDir: first.storeDir });
  try {
    await second.orchestrator.replay();
    const restoredRun = second.orchestrator.runs.get(run.runId);
    const restoredTask = second.orchestrator.tasks.get(task.taskId);
    assert.equal(restoredRun.state, 'awaiting-human');
    assert.equal(restoredTask.state, 'awaiting-human');
    assert.match(restoredRun.briefing, /AWB Workbench Task/);
  } finally {
    await second.bus.close();
  }
});

test('replay restores a submitted untrusted bridge receipt without duplicating it', async () => {
  const first = await createRuntime();
  const task = await first.orchestrator.createTask({
    taskId: 'task-bridge-replay-submitted',
    description: 'Replay submitted bridge',
    requiredTags: ['write'],
    cwd: await tempWorkspace(),
  });
  const run = await first.orchestrator.dispatch(task.taskId, 'trae-solo-bridge', task.description);
  await first.orchestrator.waitForRun(run.runId);
  await first.orchestrator.submitBridgeReceipt(run.runId, 'Receipt from GUI agent');
  const eventCount = (await first.bus.readAll()).length;
  await first.bus.close();

  const second = await createRuntime({ storeDir: first.storeDir });
  try {
    await second.orchestrator.replay();
    const restoredRun = second.orchestrator.runs.get(run.runId);
    const restoredTask = second.orchestrator.tasks.get(task.taskId);
    assert.equal(restoredRun.state, 'completed');
    assert.equal(restoredTask.state, 'awaiting-review');
    assert.equal(restoredRun.text, 'Receipt from GUI agent');
    assert.equal(restoredRun.untrusted, true);
    assert.equal(restoredRun.via, 'human-bridge');
    assert.equal((await second.bus.readAll()).length, eventCount);
  } finally {
    await second.bus.close();
  }
});

