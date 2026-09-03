import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry } from '../core/registry.mjs';
import { fileURLToPath } from 'node:url';

test('registry loads echo config in ESM runtime', () => {
  const registry = new AgentRegistry(fileURLToPath(new URL('../agents', import.meta.url)));
  registry.load();
  assert.equal(registry.agents.has('echo-test'), true);
});

test('all shipped agent configs use canonical risk levels', () => {
  const registry = new AgentRegistry(fileURLToPath(new URL('../agents', import.meta.url)));
  registry.load();
  assert.deepEqual(registry.errors, []);
  for (const agent of registry.listAll()) {
    assert.ok(['read-only', 'workspace-write', 'high-risk'].includes(agent.riskLevel));
  }
});

test('echo probe is available and type is resolved', async () => {
  const registry = new AgentRegistry(fileURLToPath(new URL('../agents', import.meta.url)));
  registry.load();
  const results = await registry.probeAll();
  assert.equal(results['echo-test'].ok, true);
});

test('bulk probe result is reflected in agent status', async () => {
  const registry = new AgentRegistry('unused');
  registry.upsert({
    id: 'missing-agent', displayName: 'Missing command', type: 'codex-app-server', outputProtocol: 'native-jsonrpc',
    riskLevel: 'workspace-write', capabilityTags: ['read'], command: 'missing-command', args: ['--version'],
    healthCheck: { command: 'missing-command', args: ['--version'] },
  });

  const results = await registry.probeAll();
  const listed = registry.listAll().find(agent => agent.id === 'missing-agent');

  assert.equal(results['missing-agent'].ok, false);
  assert.equal(listed.probe?.ok, false);
  assert.equal(listed.available, false);
});

test('registry isolates invalid config files and exposes structured errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'awb-registry-'));
  await writeFile(join(dir, 'valid.json'), JSON.stringify({
    id: 'valid-agent', displayName: 'Valid', type: 'echo', outputProtocol: 'echo', riskLevel: 'read-only', capabilityTags: ['read'],
  }));
  await writeFile(join(dir, 'invalid.json'), JSON.stringify({
    id: 'invalid-agent', displayName: 'Invalid', type: 'echo', outputProtocol: 'echo', riskLevel: 'medium', capabilityTags: ['read'],
  }));
  const registry = new AgentRegistry(dir);
  registry.load();
  assert.equal(registry.agents.has('valid-agent'), true);
  assert.equal(registry.agents.has('invalid-agent'), false);
  assert.ok(registry.errors.some(error => error.code === 'invalid_risk_level' && error.file.endsWith('invalid.json')));
  assert.equal(registry.listAll().find(agent => agent.id === 'invalid-agent')?.available, false);
});

test('registry excludes disabled agents from capability selection', () => {
  const registry = new AgentRegistry('unused');
  registry.upsert({ id: 'disabled-agent', displayName: 'Disabled', type: 'echo', outputProtocol: 'echo', riskLevel: 'read-only', capabilityTags: ['read'], enabled: false });
  assert.deepEqual(registry.findByCapability(['read']), []);
});

test('registry rejects invalid upsert before mutating state', () => {
  const registry = new AgentRegistry('unused');
  assert.throws(() => registry.upsert({ id: 'bad-agent', displayName: 'Bad', type: 'echo', outputProtocol: 'echo', riskLevel: 'low', capabilityTags: ['read'] }), error => {
    assert.equal(error.code, 'invalid_config');
    assert.equal(error.errors.some(item => item.code === 'invalid_risk_level'), true);
    return true;
  });
  assert.equal(registry.agents.has('bad-agent'), false);
});
