import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry } from '../core/registry.mjs';

const draft = id => ({ id, displayName: id, type: 'echo', outputProtocol: 'echo', riskLevel: 'read-only', capabilityTags: ['read'] });

test('importConfig atomically writes a validated draft and leaves it unknown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'awb-import-'));
  const registry = new AgentRegistry(dir);
  registry.load();
  const imported = registry.importConfig(draft('imported-agent'), 'imported-agent.json');
  assert.equal(imported.id, 'imported-agent');
  assert.equal(imported.probe.status, 'unknown');
  assert.equal(imported.available, false);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'imported-agent.json'), 'utf8')), draft('imported-agent'));
});

test('importConfig rejects duplicates, invalid configs, and unsafe filenames without partial writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'awb-import-safe-'));
  const registry = new AgentRegistry(dir);
  registry.load();
  registry.importConfig(draft('existing-agent'), 'existing-agent.json');
  const before = await readdir(dir);

  assert.throws(() => registry.importConfig(draft('existing-agent'), 'other.json'), /duplicate|exists/i);
  assert.throws(() => registry.importConfig({ ...draft('bad-agent'), riskLevel: 'invalid' }, 'bad.json'), /invalid/i);
  assert.throws(() => registry.importConfig(draft('escape-agent'), '../escape.json'), /filename|path|basename|json/i);
  assert.throws(() => registry.importConfig(draft('wrong-extension'), 'wrong.txt'), /json|filename/i);
  assert.deepEqual(await readdir(dir), before);
  await assert.rejects(stat(join(dir, '..', 'escape.json')));
});
