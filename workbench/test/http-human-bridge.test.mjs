import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const agentsDir = fileURLToPath(new URL('../agents', import.meta.url));

async function json(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  return { response, body };
}

async function closeRuntime(runtime) {
  await new Promise((resolve, reject) => runtime.server.close(error => error ? reject(error) : resolve()));
  await runtime.bus.close();
}

test('HTTP accepts Human Bridge receipts and validates lifecycle errors', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'awb-http-bridge-'));
  const previousCwd = process.cwd();
  process.chdir(workspace);
  const { startServer } = await import(`../server/http.mjs?bridge=${Date.now()}`);
  let runtime;

  try {
    runtime = await startServer({ host: '127.0.0.1', port: 0, agentsDir });
    const baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;
    const created = await json(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 'task-http-bridge', description: 'GUI work', requiredTags: ['write'] }),
    });
    assert.equal(created.response.status, 201);

    const dispatched = await json(`${baseUrl}/api/tasks/task-http-bridge/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'trae-solo-bridge', prompt: 'GUI work' }),
    });
    assert.equal(dispatched.response.status, 201);
    assert.equal(dispatched.body.state, 'awaiting-human');
    assert.match(dispatched.body.briefing, /AWB Workbench Task/);

    const submitted = await json(`${baseUrl}/api/bridges/${dispatched.body.runId}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ receiptText: 'GUI result' }),
    });
    assert.equal(submitted.response.status, 200);
    assert.equal(submitted.body.state, 'completed');
    assert.equal(submitted.body.untrusted, true);

    const duplicate = await json(`${baseUrl}/api/bridges/${dispatched.body.runId}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ receiptText: 'second' }),
    });
    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.body.error, 'bridge_already_submitted');

    const missing = await json(`${baseUrl}/api/bridges/run-missing/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ receiptText: 'missing' }),
    });
    assert.equal(missing.response.status, 404);
    assert.equal(missing.body.error, 'run_not_found');

    const blank = await json(`${baseUrl}/api/bridges/${dispatched.body.runId}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ receiptText: '   ' }),
    });
    assert.equal(blank.response.status, 409);
    assert.equal(blank.body.error, 'bridge_already_submitted');
  } finally {
    if (runtime) await closeRuntime(runtime);
    process.chdir(previousCwd);
    await rm(workspace, { recursive: true, force: true });
  }
});

