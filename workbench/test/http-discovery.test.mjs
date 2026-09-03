import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const draft = id => ({
  id,
  displayName: id,
  type: 'cli-text',
  outputProtocol: 'cli-text',
  riskLevel: 'read-only',
  capabilityTags: ['read'],
  command: process.execPath,
  args: ['-e', 'process.stdout.write("imported 1.0")'],
  healthCheck: { command: process.execPath, args: ['-e', 'process.stdout.write("imported 1.0")'], expect: 'imported' },
});

test('HTTP discovery is read-only and import remains explicit', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'awb-http-discovery-'));
  const agentsDir = join(workspace, 'agents');
  const previousCwd = process.cwd();
  process.chdir(workspace);
  const { startServer } = await import(`../server/http.mjs?discovery=${Date.now()}`);
  let runtime;
  try {
    runtime = await startServer({
      host: '127.0.0.1',
      port: 0,
      agentsDir,
      discoveryOptions: {
        includeGui: false,
        catalog: [{ id: 'fixture', displayName: 'Fixture', command: process.execPath, adapter: 'cli-text', args: ['-e', 'process.stdout.write("fixture 1.0")'] }],
      },
    });
    const port = runtime.server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const before = await (await fetch(`${base}/api/agents`)).json();
    const discovered = await fetch(`${base}/api/agents/discover?commands=fixture`);
    assert.equal(discovered.status, 200);
    const discoveryBody = await discovered.json();
    assert.equal(discoveryBody.candidates[0].id, 'fixture');
    assert.equal((await (await fetch(`${base}/api/agents`)).json()).agents.length, before.agents.length);

    const importedResponse = await fetch(`${base}/api/agents/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: draft('imported-http'), fileName: 'imported-http.json' }),
    });
    assert.equal(importedResponse.status, 201);
    const imported = await importedResponse.json();
    assert.equal(imported.id, 'imported-http');
    assert.equal(imported.probe.status, 'unknown');
    assert.equal(imported.available, false);

    const duplicate = await fetch(`${base}/api/agents/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: draft('imported-http') }),
    });
    assert.equal(duplicate.status, 409);
    const traversal = await fetch(`${base}/api/agents/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: draft('escape-http'), fileName: '../escape.json' }),
    });
    assert.equal(traversal.status, 400);
    assert.deepEqual((await readdir(agentsDir)).sort(), ['imported-http.json']);

    const probe = await fetch(`${base}/api/agents/probe`, { method: 'POST' });
    assert.equal(probe.status, 200);
    assert.equal((await probe.json()).results['imported-http'].status, 'available');
  } finally {
    if (runtime) {
      await new Promise(resolve => runtime.server.close(resolve));
      await runtime.bus.close();
    }
    process.chdir(previousCwd);
    await rm(workspace, { recursive: true, force: true });
  }
});

test('HTTP discovery rejects invalid command filters and origins', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'awb-http-discovery-invalid-'));
  const previousCwd = process.cwd();
  process.chdir(workspace);
  const { startServer } = await import(`../server/http.mjs?discovery-invalid=${Date.now()}`);
  let runtime;
  try {
    runtime = await startServer({ host: '127.0.0.1', port: 0, agentsDir: join(workspace, 'agents'), discoveryOptions: { includeGui: false, catalog: [] } });
    const base = `http://127.0.0.1:${runtime.server.address().port}`;
    const badQuery = await fetch(`${base}/api/agents/discover?commands=%2Ftmp`);
    assert.equal(badQuery.status, 400);
    const badOrigin = await fetch(`${base}/api/agents/import`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(badOrigin.status, 403);
  } finally {
    if (runtime) { await new Promise(resolve => runtime.server.close(resolve)); await runtime.bus.close(); }
    process.chdir(previousCwd);
    await rm(workspace, { recursive: true, force: true });
  }
});
