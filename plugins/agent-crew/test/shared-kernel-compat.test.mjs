import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { spawnPlan as sharedSpawnPlan } from '../../../shared/agent-runtime/resolve.mjs';
import { spawnPlan as crewSpawnPlan, probeCli } from '../server/lib/dispatch.mjs';

test('Agent Crew exposes the shared executable plan and preserves probeCli output', () => {
  const args = ['--version'];
  assert.deepEqual(crewSpawnPlan(process.execPath, args), sharedSpawnPlan(process.execPath, args));
  const result = probeCli({ id: 'fixture', backend: { type: 'cli', command: process.execPath, versionArgs: args } });
  assert.equal(result.ok, true);
  assert.equal(result.command, process.execPath);
  assert.equal(result.resolved, sharedSpawnPlan(process.execPath, args).resolved);
  assert.match(result.version, /v\d+/);
  assert.equal(result.reason, null);
});

test('probeCli reports a missing configured command without a vendor fallback', () => {
  const result = probeCli({ id: 'missing', backend: { type: 'cli', command: 'missing-agent-runtime-command' } });
  assert.equal(result.ok, false);
  assert.equal(result.command, 'missing-agent-runtime-command');
  assert.equal(result.resolved, null);
  assert.match(result.reason, /找不到|PATH|not found/i);
});
