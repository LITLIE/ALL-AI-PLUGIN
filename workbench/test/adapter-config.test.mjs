import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRegistry } from '../core/registry.mjs';
import { EventBus } from '../core/bus.mjs';
import { Orchestrator } from '../core/orchestrator.mjs';
import { loadAdapter } from '../adapters/index.mjs';

test('registry passes the complete agent config to probe and orchestrator run', async () => {
  const agentsDir = await mkdtemp(join(tmpdir(), 'awb-config-agents-'));
  await writeFile(join(agentsDir, 'custom.json'), JSON.stringify({
    id: 'custom-echo', displayName: 'Custom Echo', type: 'echo', outputProtocol: 'echo', riskLevel: 'read-only',
    command: 'fixture-command', args: ['{{prompt}}'],
    env: { MARKER: 'configured' }, capabilityTags: ['read'], timeoutDefault: 1234,
  }));
  const registry = new AgentRegistry(agentsDir);
  registry.load();
  const adapter = await loadAdapter({ type: 'echo' });
  const originalProbe = adapter.probe;
  const originalRun = adapter.run;
  let probedConfig;
  let runConfig;
  adapter.probe = async (config) => { probedConfig = config; return { ok: true }; };
  adapter.run = async function* (options) {
    runConfig = options.agentConfig;
    yield { type: 'run.started', taskId: options.taskId, runId: options.runId, ts: Date.now() };
    yield { type: 'run.completed', taskId: options.taskId, runId: options.runId, text: 'ok', ts: Date.now() };
  };
  try {
    const probe = await registry.probe('custom-echo');
    assert.equal(probe.ok, true);
    assert.equal(probedConfig.command, 'fixture-command');
    const busDir = await mkdtemp(join(tmpdir(), 'awb-config-bus-'));
    const bus = new EventBus(join(busDir, 'eventbus'));
    await bus.init();
    const orchestrator = new Orchestrator(bus, registry);
    const task = await orchestrator.createTask({ taskId: 'task-config', description: 'config', requiredTags: ['read'] });
    const run = await orchestrator.dispatch(task.taskId, 'custom-echo', 'config prompt');
    await orchestrator.waitForRun(run.runId);
    assert.equal(runConfig, registry.agents.get('custom-echo'));
    await bus.close();
  } finally {
    adapter.probe = originalProbe;
    adapter.run = originalRun;
  }
});
