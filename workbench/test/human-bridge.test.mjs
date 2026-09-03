import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, tempWorkspace } from './helpers.mjs';

test('Human Bridge pauses in awaiting-human with a persisted briefing', async () => {
  const { bus, orchestrator } = await createRuntime();
  try {
    const task = await orchestrator.createTask({
      taskId: 'task-human-bridge',
      description: 'Implement the GUI-only change',
      requiredTags: ['write'],
      cwd: await tempWorkspace(),
    });

    const run = await orchestrator.dispatch(task.taskId, 'trae-solo-bridge', task.description);
    const waiting = await orchestrator.waitForRun(run.runId);

    assert.equal(waiting.state, 'awaiting-human');
    assert.equal(task.state, 'awaiting-human');
    assert.match(waiting.briefing, /AWB Workbench Task/);
    const events = (await bus.readAll()).filter(event => event.runId === run.runId);
    assert.equal(events.filter(event => event.payload?.type === 'bridge.requested').length, 1);
    assert.equal(events.filter(event => event.payload?.type === 'run.failed').length, 0);
  } finally {
    await bus.close();
  }
});

test('Human Bridge accepts one untrusted receipt and rejects duplicates', async () => {
  const { bus, orchestrator } = await createRuntime();
  try {
    const task = await orchestrator.createTask({
      taskId: 'task-human-receipt',
      description: 'Run the GUI task',
      requiredTags: ['write'],
      cwd: await tempWorkspace(),
    });
    const run = await orchestrator.dispatch(task.taskId, 'trae-solo-bridge', task.description);
    await orchestrator.waitForRun(run.runId);

    const submitted = await orchestrator.submitBridgeReceipt(run.runId, 'Changed files: src/app.js\nTests: passed');
    assert.equal(submitted.ok, true);
    assert.equal(submitted.run.state, 'completed');
    assert.equal(task.state, 'awaiting-review');
    assert.equal(submitted.run.untrusted, true);
    assert.equal(submitted.run.via, 'human-bridge');

    await assert.rejects(
      () => orchestrator.submitBridgeReceipt(run.runId, 'duplicate'),
      error => error.code === 'bridge_already_submitted',
    );

    const events = (await bus.readAll()).filter(event => event.runId === run.runId);
    assert.equal(events.filter(event => event.payload?.type === 'bridge.submitted').length, 1);
    assert.equal(events.filter(event => event.payload?.type === 'run.completed').length, 1);
    const completion = events.find(event => event.payload?.type === 'run.completed');
    assert.equal(completion.payload.meta.untrusted, true);
    assert.equal(completion.payload.meta.via, 'human-bridge');
  } finally {
    await bus.close();
  }
});

test('Human Bridge rejects invalid or unsupported receipts without terminal mutation', async () => {
  const { bus, orchestrator } = await createRuntime();
  try {
    const task = await orchestrator.createTask({
      taskId: 'task-human-invalid',
      description: 'Invalid receipt test',
      requiredTags: ['write'],
      cwd: await tempWorkspace(),
    });
    const run = await orchestrator.dispatch(task.taskId, 'trae-solo-bridge', task.description);
    await orchestrator.waitForRun(run.runId);

    await assert.rejects(() => orchestrator.submitBridgeReceipt(run.runId, '   '), error => error.code === 'invalid_receipt');
    await assert.rejects(() => orchestrator.submitBridgeReceipt('run-missing', 'x'), error => error.code === 'run_not_found');

    const events = (await bus.readAll()).filter(event => event.runId === run.runId);
    assert.equal(events.filter(event => event.payload?.type === 'run.completed').length, 0);
    assert.equal(orchestrator.runs.get(run.runId).state, 'awaiting-human');
  } finally {
    await bus.close();
  }
});
