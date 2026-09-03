import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventBus } from '../core/bus.mjs';
import { AgentRegistry } from '../core/registry.mjs';
import { Orchestrator } from '../core/orchestrator.mjs';

export function tempWorkspace() {
  return mkdtemp(join(tmpdir(), 'agent-workbench-'));
}

export async function createRuntime(options = {}) {
  const storeDir = options.storeDir || await tempWorkspace();
  const agentsDir = options.agentsDir || fileURLToPath(new URL('../agents', import.meta.url));
  const bus = new EventBus(storeDir);
  await bus.init();

  const registry = new AgentRegistry(agentsDir);
  registry.load();
  await registry.probeAll();

  const orchestrator = new Orchestrator(bus, registry);
  return { storeDir, bus, registry, orchestrator };
}

export async function completedEchoRuntime() {
  const runtime = await createRuntime();
  const task = await runtime.orchestrator.createTask({
    taskId: 'task-echo',
    description: 'ping',
    requiredTags: ['read'],
  });
  const run = await runtime.orchestrator.dispatch(task.taskId, 'echo-test', 'ping');
  await runtime.orchestrator.waitForRun(run.runId);
  return runtime;
}
