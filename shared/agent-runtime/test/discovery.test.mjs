import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { discoverAgents, buildConfigDraft } from '../discovery.mjs';

test('discoverAgents probes an injected CLI catalog and returns a high-confidence draft', async () => {
  const result = await discoverAgents({
    catalog: [{ id: 'fixture-cli', displayName: 'Fixture CLI', command: process.execPath, adapter: 'cli-text', args: ['--version'], capabilities: ['read'] }],
    includeGui: false,
  });
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.equal(candidate.id, 'fixture-cli');
  assert.equal(candidate.source, 'path');
  assert.equal(candidate.status, 'available');
  assert.equal(candidate.confidence, 'high');
  assert.equal(candidate.resolved, process.execPath);
  assert.equal(candidate.configDraft.type, 'cli-text');
  assert.equal(candidate.configDraft.command, process.execPath);
  assert.equal(candidate.configDraft.enabled, true);
});

test('discoverAgents omits unresolved CLI entries and adds advisory GUI drafts', async () => {
  const result = await discoverAgents({
    catalog: [{ id: 'missing-cli', displayName: 'Missing', command: 'missing-discovery-command', adapter: 'cli-text' }],
    includeGui: true,
  });
  assert.equal(result.candidates.some(candidate => candidate.id === 'missing-cli'), false);
  const gui = result.candidates.filter(candidate => ['trae', 'workbuddy'].includes(candidate.id));
  assert.equal(gui.length, 2);
  for (const candidate of gui) {
    assert.equal(candidate.source, 'known-gui');
    assert.equal(candidate.status, 'available');
    assert.equal(candidate.confidence, 'advisory');
    assert.equal(candidate.configDraft.type, 'human-bridge');
    assert.equal(Object.hasOwn(candidate.configDraft, 'command'), false);
  }
});

test('discoverAgents accepts an explicit manifest object without crawling the filesystem', async () => {
  const result = await discoverAgents({
    catalog: [],
    includeGui: false,
    manifests: [{ id: 'manifest-agent', name: 'Manifest Agent', command: process.execPath, type: 'cli-text', args: ['--version'] }],
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].source, 'manifest');
  assert.equal(result.candidates[0].configDraft.id, 'manifest-agent');
});

test('buildConfigDraft applies explicit overrides without enabling implicit commands', () => {
  const draft = buildConfigDraft({ id: 'fixture', displayName: 'Fixture', command: process.execPath, adapter: 'cli-text', capabilities: ['read'] }, { enabled: false });
  assert.equal(draft.enabled, false);
  assert.equal(draft.command, process.execPath);
  assert.deepEqual(draft.capabilityTags, ['read']);
});
