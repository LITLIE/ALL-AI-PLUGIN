import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigText, normalizeConfig, validateConfig, RISK_LEVELS, CAPABILITY_TAGS } from '../config/schema.mjs';

test('config parser preserves URL and path slashes inside JSON strings', () => {
  const config = parseConfigText([
    '// leading comment',
    '{',
    '  "id": "url-agent",',
    '  "type": "cli-text",',
    '  "url": "https://example.test/a//b",',
    '  "path": "C:\\\\tools\\\\agent//bin",',
    '  "riskLevel": "read-only",',
    '  "capabilityTags": ["read"]',
    '}',
  ].join('\n'), 'url-agent.json');
  assert.equal(config.url, 'https://example.test/a//b');
  assert.equal(config.path, 'C:\\tools\\agent//bin');
});

test('config normalizer maps adapterId to canonical type and defaults enabled', () => {
  const normalized = normalizeConfig({ id: 'legacy', adapterId: 'echo', riskLevel: 'read-only', capabilityTags: ['read'] }, 'legacy.json');
  assert.equal(normalized.type, 'echo');
  assert.equal(normalized.enabled, true);
});

test('config validation rejects conflicting adapter fields', () => {
  const result = validateConfig({ id: 'conflict', type: 'echo', adapterId: 'cli-text', displayName: 'Conflict', outputProtocol: 'echo', riskLevel: 'read-only', capabilityTags: ['read'] }, 'conflict.json');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.code === 'conflicting_adapter_type' && error.field === 'type'));
});

test('config validation rejects unknown risk, capability, and adapter type', () => {
  const result = validateConfig({ id: 'invalid', displayName: 'Invalid', type: 'unknown-adapter', outputProtocol: 'cli-text', riskLevel: 'medium', capabilityTags: ['reasoning'] }, 'invalid.json');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.code === 'invalid_risk_level'));
  assert.ok(result.errors.some(error => error.code === 'unknown_capability'));
  assert.ok(result.errors.some(error => error.code === 'unknown_adapter_type'));
});

test('config vocabulary exposes canonical risk and capability values', () => {
  assert.deepEqual([...RISK_LEVELS], ['read-only', 'workspace-write', 'high-risk']);
  assert.ok(CAPABILITY_TAGS.has('read'));
  assert.ok(CAPABILITY_TAGS.has('design'));
});
