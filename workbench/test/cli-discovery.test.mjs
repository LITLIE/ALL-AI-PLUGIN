import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workbenchDir = fileURLToPath(new URL('..', import.meta.url));

function runCli(storeDir, ...args) {
  const env = args[0] && typeof args[0] === 'object' ? args.shift() : {};
  return spawnSync(process.execPath, ['awb.mjs', ...args], {
    cwd: workbenchDir,
    env: { ...process.env, AWB_STORE: storeDir, ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });
}

test('agents:discover emits JSON and does not import a config', () => {
  const store = mkdtempSync(join(tmpdir(), 'awb-cli-discovery-'));
  const agents = mkdtempSync(join(tmpdir(), 'awb-cli-discovery-agents-'));
  try {
    const catalog = JSON.stringify([{ id: 'fixture', displayName: 'Fixture', command: process.execPath, adapter: 'cli-text', args: ['-e', 'process.stdout.write("fixture 1.0")'] }]);
    const result = runCli(store, { AWB_AGENTS_DIR: agents, AWB_DISCOVERY_CATALOG: catalog }, 'agents:discover', '--commands', 'fixture');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const body = JSON.parse(result.stdout);
    const fixture = body.candidates.find(candidate => candidate.id === 'fixture');
    assert.ok(fixture);
    assert.equal(fixture.confidence, 'high');
    assert.deepEqual(readdirSync(agents), []);

    const help = runCli(store, '--help');
    assert.equal(help.status, 0);
    assert.match(help.stdout, /agents:discover/);
  } finally {
    rmSync(store, { recursive: true, force: true });
    rmSync(agents, { recursive: true, force: true });
  }
});

test('agents:discover rejects malformed command filters', () => {
  const store = mkdtempSync(join(tmpdir(), 'awb-cli-discovery-invalid-'));
  try {
    const result = runCli(store, 'agents:discover', '--commands', '../escape');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /commands/i);
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});
