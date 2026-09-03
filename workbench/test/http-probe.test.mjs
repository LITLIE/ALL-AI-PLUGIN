import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('HTTP probe returns repeatable structured results', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'awb-http-probe-'));
  const agentsDir = join(workspace, 'agents');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(agentsDir));
  await writeFile(join(agentsDir, 'echo.json'), JSON.stringify({
    id: 'probe-echo', displayName: 'Probe Echo', type: 'echo', outputProtocol: 'echo',
    riskLevel: 'read-only', capabilityTags: ['read'], enabled: true,
  }));
  await writeFile(join(agentsDir, 'cli.json'), JSON.stringify({
    id: 'probe-cli', displayName: 'Probe CLI', type: 'cli-text', outputProtocol: 'cli-text',
    riskLevel: 'read-only', capabilityTags: ['read'], enabled: true,
    command: process.execPath, args: ['--version'],
    healthCheck: { command: process.execPath, args: ['-e', 'process.stdout.write("probe-cli 1.0")'], expect: 'probe-cli' },
  }));

  const previousCwd = process.cwd();
  process.chdir(workspace);
  const { startServer } = await import(`../server/http.mjs?probe=${Date.now()}`);
  let runtime;
  try {
    runtime = await startServer({ host: '127.0.0.1', port: 0, agentsDir });
    const { port } = runtime.server.address();
    const probe = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/agents/probe`, { method: 'POST' });
      assert.equal(response.status, 200);
      return (await response.json()).results;
    };
    const first = await probe();
    const second = await probe();
    for (const id of ['probe-echo', 'probe-cli']) {
      for (const result of [first[id], second[id]]) {
        assert.equal(result.ok, true);
        assert.equal(result.status, 'available');
        assert.equal(result.code, 0);
        assert.equal(result.error, null);
        assert.equal(typeof result.checkedAt, 'number');
      }
    }
  } finally {
    if (runtime) {
      await new Promise(resolve => runtime.server.close(resolve));
      await runtime.bus.close();
    }
    process.chdir(previousCwd);
    await rm(workspace, { recursive: true, force: true });
  }
});
