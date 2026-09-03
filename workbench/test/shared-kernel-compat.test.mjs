import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { spawnPlan as sharedSpawnPlan } from '../../shared/agent-runtime/resolve.mjs';
import { probeCommand as sharedProbeCommand, PROBE_DEFAULTS as sharedProbeDefaults } from '../../shared/agent-runtime/probe.mjs';
import { spawnPlan as workbenchSpawnPlan } from '../core/utils.mjs';
import { probeCommand as workbenchProbeCommand, PROBE_DEFAULTS as workbenchProbeDefaults } from '../core/probe.mjs';

test('Workbench utility paths delegate to the shared executable kernel', async () => {
  const shared = sharedSpawnPlan(process.execPath, ['--version']);
  const workbench = workbenchSpawnPlan(process.execPath, ['--version']);
  assert.deepEqual(workbench, shared);
  assert.equal(workbenchProbeDefaults, sharedProbeDefaults);

  const config = { command: process.execPath, healthCheck: { command: process.execPath, args: ['--version'] } };
  const [sharedProbe, workbenchProbe] = await Promise.all([sharedProbeCommand(config), workbenchProbeCommand(config)]);
  assert.deepEqual({ ...workbenchProbe, checkedAt: 0 }, { ...sharedProbe, checkedAt: 0 });
});
