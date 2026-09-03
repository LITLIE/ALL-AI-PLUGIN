import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from './helpers.mjs';

test('high-risk task starts pending and blocks dispatch before approval', async () => {
  const { bus, orchestrator } = await createRuntime();
  try {
    const task = await orchestrator.createTask({
      taskId: 'task-high-risk', description: 'deploy', requiredTags: ['read'], sandboxMode: 'high-risk',
    });
    assert.equal(task.approval.status, 'pending');
    await assert.rejects(
      () => orchestrator.dispatch(task.taskId, 'echo-test', 'deploy'),
      error => error.code === 'approval_required' && error.statusCode === 409,
    );
    assert.equal(orchestrator.runs.size, 0);
  } finally {
    await bus.close();
  }
});

test('independent approval binds an agent and permits dispatch', async () => {
  const { bus, orchestrator } = await createRuntime();
  try {
    const task = await orchestrator.createTask({
      taskId: 'task-approval-grant', description: 'change', requiredTags: ['read'], sandboxMode: 'high-risk',
    });
    const approval = await orchestrator.submitApproval(task.taskId, 'approved', 'human-reviewer', 'echo-test', 'approved for test');
    assert.equal(approval.ok, true);
    assert.equal(task.approval.status, 'approved');
    assert.equal(task.approval.agentId, 'echo-test');
    const run = await orchestrator.dispatch(task.taskId, 'echo-test', 'change');
    await orchestrator.waitForRun(run.runId);
    assert.equal(run.state, 'completed');
  } finally {
    await bus.close();
  }
});

test('rejected and self-approved decisions block dispatch and replay', async () => {
  const { bus, orchestrator } = await createRuntime();
  try {
    const rejected = await orchestrator.createTask({
      taskId: 'task-approval-reject', description: 'blocked', requiredTags: ['read'], sandboxMode: 'high-risk',
    });
    const denied = await orchestrator.submitApproval(rejected.taskId, 'rejected', 'human-reviewer', 'echo-test', 'unsafe');
    assert.equal(denied.ok, true);
    assert.equal(rejected.approval.status, 'rejected');
    await assert.rejects(() => orchestrator.dispatch(rejected.taskId, 'echo-test', 'blocked'), /approval/i);
    await assert.rejects(
      () => orchestrator.submitApproval(rejected.taskId, 'approved', 'human-reviewer', 'echo-test'),
      error => error.code === 'approval_conflict' && error.statusCode === 409,
    );

    const self = await orchestrator.createTask({
      taskId: 'task-approval-self', description: 'self', requiredTags: ['read'], sandboxMode: 'high-risk',
    });
    const selfDecision = await orchestrator.submitApproval(self.taskId, 'approved', 'echo-test', 'echo-test');
    assert.equal(selfDecision.ok, false);
    assert.equal(selfDecision.reason, 'maker-checker violation');
    assert.equal(self.approval.status, 'rejected');

    const replayed = await createRuntime({ storeDir: orchestrator.bus.basePath });
    try {
      await replayed.orchestrator.replay();
      assert.equal(replayed.orchestrator.tasks.get(rejected.taskId).approval.status, 'rejected');
      assert.equal(replayed.orchestrator.tasks.get(self.taskId).approval.status, 'rejected');
    } finally {
      await replayed.bus.close();
    }
  } finally {
    await bus.close();
  }
});
