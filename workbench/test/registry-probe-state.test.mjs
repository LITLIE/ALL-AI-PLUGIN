import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { AgentRegistry } from '../core/registry.mjs';

const config = (id, command = process.execPath) => ({
  id, displayName: id, type: 'cli-text', outputProtocol: 'cli-text', riskLevel: 'read-only', capabilityTags: ['read'],
  command, args: ['--version'], healthCheck: { command, args: ['--version'] },
});

test('fresh registry agents are unknown and unroutable until explicitly probed', () => {
  const registry = new AgentRegistry('unused');
  registry.upsert(config('fresh-agent'));
  const listed = registry.listAll()[0];
  assert.equal(listed.available, false);
  assert.equal(listed.probe.status, 'unknown');
  assert.deepEqual(registry.findByCapability(['read']), []);
});

test('probe state controls availability and upsert resets it to unknown', async () => {
  const registry = new AgentRegistry('unused');
  registry.upsert(config('available-agent'));
  const result = await registry.probe('available-agent');
  assert.equal(result.ok, true);
  assert.equal(registry.listAll()[0].available, true);
  assert.equal(registry.findByCapability(['read']).length, 1);

  registry.upsert(config('available-agent', 'definitely-missing-agent'));
  assert.equal(registry.listAll()[0].available, false);
  assert.equal(registry.listAll()[0].probe.status, 'unknown');
  assert.deepEqual(registry.findByCapability(['read']), []);
});

test('registry normalizes partial and thrown adapter probe results', async () => {
  const registry = new AgentRegistry('unused');
  registry.upsert({
    ...config('partial-agent'),
    adapterInstance: { probe: async () => ({ ok: true, version: 'legacy' }) },
  });
  const available = await registry.probe('partial-agent');
  assert.deepEqual(Object.keys(available), ['ok', 'status', 'resolved', 'version', 'code', 'error', 'checkedAt']);
  assert.equal(available.status, 'available');
  assert.equal(available.code, 0);

  registry.upsert({
    ...config('throwing-agent'),
    adapterInstance: { probe: async () => { throw new Error('probe exploded'); } },
  });
  const failed = await registry.probe('throwing-agent');
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.code, null);
  assert.match(failed.error, /probe exploded/);
  assert.equal(typeof failed.checkedAt, 'number');
});
