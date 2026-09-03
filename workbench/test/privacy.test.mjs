import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRuntime } from './helpers.mjs';

test('run.created stores prompt length and hash but not raw prompt text', async () => {
  const { bus, orchestrator } = await createRuntime();
  const prompt = 'unique-secret-marker-privacy-test';
  try {
    const task = await orchestrator.createTask({ taskId: 'task-privacy', description: 'privacy', requiredTags: ['read'] });
    const run = await orchestrator.dispatch(task.taskId, 'echo-test', prompt);
    await orchestrator.waitForRun(run.runId);
    const created = (await bus.readAll()).find(event => event.runId === run.runId && event.payload?.type === 'run.created');
    assert.ok(created);
    assert.equal(Object.hasOwn(created.payload.run, 'prompt'), false);
    assert.equal(created.payload.run.promptLength, prompt.length);
    assert.equal(created.payload.run.promptSha256, createHash('sha256').update(prompt).digest('hex'));
    assert.doesNotMatch(JSON.stringify(created), /unique-secret-marker-privacy-test/);

    await orchestrator.replay();
    const replayed = orchestrator.runs.get(run.runId);
    assert.equal(replayed.promptLength, prompt.length);
    assert.equal(replayed.promptSha256, created.payload.run.promptSha256);
  } finally {
    await bus.close();
  }
});

test('replay accepts legacy run.created events containing prompt', async () => {
  const { bus, orchestrator } = await createRuntime();
  try {
    const task = await orchestrator.createTask({ taskId: 'task-legacy-prompt', description: 'legacy', requiredTags: ['read'] });
    await bus.append('run', {
      type: 'run.created',
      runId: 'run-legacy-prompt',
      run: {
        runId: 'run-legacy-prompt', taskId: task.taskId, agentId: 'echo-test',
        prompt: 'legacy prompt', state: 'running', assignedRuns: [],
      },
    }, { runId: 'run-legacy-prompt', taskId: task.taskId, agentId: 'echo-test' });
    await orchestrator.replay();
    assert.equal(orchestrator.runs.get('run-legacy-prompt').prompt, 'legacy prompt');
  } finally {
    await bus.close();
  }
});
