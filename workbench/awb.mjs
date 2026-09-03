import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventBus } from './core/bus.mjs';
import { parseFlags } from './core/flags.mjs';
import { Orchestrator } from './core/orchestrator.mjs';
import { AgentRegistry } from './core/registry.mjs';
import { aggregateMetrics } from './core/metrics.mjs';
import { discoverAgents } from '../shared/agent-runtime/discovery.mjs';

const workbenchDir = dirname(fileURLToPath(import.meta.url));
const awbFile = fileURLToPath(import.meta.url);
process.chdir(workbenchDir);

const [, , command, ...args] = process.argv;

const HELP = `awb - AgentWorkbench CLI

USAGE:
  node awb.mjs <command> [options]

COMMANDS:
  serve
  agents:list
  agents:probe
  agents:discover [--commands claude,codex]
  task:create   --title T --requiredTags a,b [--description D] [--cwd P]
                [--sandboxMode read-only|workspace-write|high-risk]
  task:decompose --task <id> --planner <agent-id> [--prompt <text>]
  task:run      --task <id> [--maxParallel <n>] [--continueOnFailure]
  task:dispatch --task <id> [--agent <id>]
  task:approve  --task <id> --reviewer <id> [--agent <id>] [--reason text]
  task:reject   --task <id> --reviewer <id> [--agent <id>] [--reason text]
  task:verdict  --run <id> --action passed|rejected|rework --reviewer <id> [--note text]
  task:list
  run:interrupt --run <id>
  bus:tail [count]
  audit
  metrics      [windowMs]
  replay

ENV:
  AWB_PORT         Default: 7788
  AWB_HOST         Default: 127.0.0.1
  AWB_STORE        Default: .awb/ (event bus lives under eventbus/bus.jsonl)
  AWB_AGENTS_DIR   Default: agents/
  AWB_NO_BROWSER=1 Do not open a browser for serve
`;

const REPLAY_COMMANDS = new Set([
  'task:list',
  'task:dispatch',
  'task:approve',
  'task:reject',
  'task:decompose',
  'task:run',
  'task:verdict',
  'run:interrupt',
  'replay',
]);

function requiredFlag(flags, name, usage) {
  const value = flags[name];
  if (value === undefined || value === true || value === '') {
    throw new Error(`${usage} is required`);
  }
  return value;
}

function makeTaskId() {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function initializeRuntime({ probe = false, initBus = true } = {}) {
  const storeRoot = resolve(process.env.AWB_STORE || join(workbenchDir, '.awb'));
  const agentsDir = resolve(process.env.AWB_AGENTS_DIR || join(workbenchDir, 'agents'));
  const bus = new EventBus(resolve(storeRoot, 'eventbus'));
  try {
    if (initBus) await bus.init();

    const registry = new AgentRegistry(agentsDir);
    registry.load();
    if (probe) await registry.probeAll();

    return {
      bus,
      registry,
      orchestrator: new Orchestrator(bus, registry),
    };
  } catch (error) {
    await bus.close();
    throw error;
  }
}

function selectExplicitAgent(registry, agentId) {
  const agent = registry.listAll().find(candidate => candidate.id === agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);
  if (!agent.enabled) throw new Error(`Agent is disabled: ${agentId}`);
  if (!agent.type) throw new Error(`Agent has no adapter type: ${agentId}`);
  if (agent.probe?.ok !== true) {
    const detail = agent.probe?.error || agent.probe?.message || 'probe failed';
    throw new Error(`Agent unavailable: ${agentId} (${detail})`);
  }
  return agent;
}

async function serve() {
  const { startServer } = await import('./server/http.mjs');
  const port = Number(process.env.AWB_PORT || 7788);
  const host = process.env.AWB_HOST || '127.0.0.1';
  await startServer({ host, port });

  if (!process.env.AWB_NO_BROWSER) {
    const url = `http://${host}:${port}`;
    setTimeout(() => {
      try {
        if (process.platform === 'win32') {
          spawn('cmd', ['/c', 'start', '""', url], { detached: true, shell: true });
        } else if (process.platform === 'darwin') {
          spawn('open', [url], { detached: true });
        } else {
          spawn('xdg-open', [url], { detached: true });
        }
      } catch {
        // Browser launch is optional.
      }
    }, 500);
  }
}

function discoveryOptionsFromEnv() {
  const rawCatalog = process.env.AWB_DISCOVERY_CATALOG;
  if (!rawCatalog) return {};
  try {
    const catalog = JSON.parse(rawCatalog);
    return Array.isArray(catalog) ? { catalog } : {};
  } catch {
    throw new Error('AWB_DISCOVERY_CATALOG must be a JSON array');
  }
}

async function main() {
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    console.log(HELP);
    return;
  }

  if (command === 'serve') {
    await serve();
    return;
  }

  if (command === 'agents:discover') {
    const flags = parseFlags(args);
    const rawCommands = flags.commands;
    const commands = rawCommands === undefined || rawCommands === true
      ? undefined
      : String(rawCommands).split(',').map(value => value.trim()).filter(Boolean);
    if (rawCommands === true || (commands && (!commands.length || commands.some(value => !/^[a-z0-9][a-z0-9-]*$/i.test(value))))) {
      throw new Error('--commands must be a comma-separated list of command ids');
    }
    const result = await discoverAgents({ ...discoveryOptionsFromEnv(), ...(commands ? { commands } : {}) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  let runtime;
  try {
    const needsProbe = command === 'agents:list'
      || command === 'agents:probe'
      || command === 'task:dispatch'
      || command === 'task:decompose'
      || command === 'task:run';
    runtime = await initializeRuntime({
      probe: needsProbe,
      initBus: command !== 'audit',
    });
    const { bus, registry, orchestrator } = runtime;

    if (REPLAY_COMMANDS.has(command)) await orchestrator.replay();

    switch (command) {
      case 'agents:list': {
        console.log('ID'.padEnd(20) + 'DISPLAY'.padEnd(28) + 'TAGS'.padEnd(30) + 'RISK'.padEnd(16) + 'RESOLVED / VERSION'.padEnd(42) + 'STATUS');
        console.log('-'.repeat(140));
        for (const agent of registry.listAll()) {
          console.log(
            agent.id.padEnd(20)
            + (agent.displayName || '').padEnd(28)
            + (agent.capabilityTags || []).join(',').padEnd(30)
            + (agent.riskLevel || '').padEnd(16)
            + [agent.probe?.resolved, agent.probe?.version, agent.probe?.error].filter(Boolean).join(' | ').padEnd(42)
            + (agent.probe?.status || 'unknown'),
          );
        }
        break;
      }

      case 'agents:probe':
        console.log(JSON.stringify(Object.fromEntries(
          registry.listAll().map(agent => [agent.id, agent.probe]),
        ), null, 2));
        break;

      case 'task:create': {
        const flags = parseFlags(args);
        const title = requiredFlag(flags, 'title', '--title T');
        const requiredTags = requiredFlag(flags, 'requiredTags', '--requiredTags a,b')
          .split(',')
          .map(tag => tag.trim())
          .filter(Boolean);
        const task = await orchestrator.createTask({
          taskId: makeTaskId(),
          description: title + (flags.description ? `\n${flags.description}` : ''),
          requiredTags,
          cwd: flags.cwd || workbenchDir,
          sandboxMode: flags.sandboxMode || 'workspace-write',
        });
        console.log(`[ok] task created: ${task.taskId}`);
        console.log(JSON.stringify(task, null, 2));
        break;
      }

      case 'task:list':
        console.log(JSON.stringify(Array.from(orchestrator.tasks.values()), null, 2));
        break;

      case 'task:decompose': {
        const flags = parseFlags(args);
        const taskId = requiredFlag(flags, 'task', '--task <id>');
        const planner = requiredFlag(flags, 'planner', '--planner <agent-id>');
        const result = await orchestrator.decomposeTask(taskId, planner, flags.prompt === true ? undefined : flags.prompt);
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
        break;
      }

      case 'task:run': {
        const flags = parseFlags(args);
        const taskId = requiredFlag(flags, 'task', '--task <id>');
        const maxParallel = flags.maxParallel === undefined ? 4 : Number(flags.maxParallel);
        if (!Number.isInteger(maxParallel) || maxParallel <= 0) throw new Error('maxParallel must be a positive integer');
        if (flags.continueOnFailure !== undefined && flags.continueOnFailure !== true) {
          throw new Error('--continueOnFailure does not accept a value');
        }
        const result = await orchestrator.runTaskGraph(taskId, { maxParallel, continueOnFailure: flags.continueOnFailure === true });
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
        break;
      }

      case 'task:approve':
      case 'task:reject': {
        const flags = parseFlags(args);
        const taskId = requiredFlag(flags, 'task', '--task <id>');
        const reviewer = requiredFlag(flags, 'reviewer', '--reviewer <id>');
        const result = await orchestrator.submitApproval(
          taskId,
          command === 'task:approve' ? 'approved' : 'rejected',
          reviewer,
          flags.agent === true ? undefined : flags.agent,
          flags.reason === true ? '' : (flags.reason || ''),
        );
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
        break;
      }

      case 'task:dispatch': {
        const flags = parseFlags(args);
        const taskId = requiredFlag(flags, 'task', '--task <id>');
        const task = orchestrator.tasks.get(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);

        let agent;
        if (flags.agent) {
          agent = selectExplicitAgent(registry, flags.agent);
        } else {
          const selection = orchestrator.selectAgent(task);
          if (!selection.ok) {
            throw new Error(`No matching capability for task ${taskId}: ${task.requiredTags.join(',') || '(none)'}`);
          }
          agent = selection.agent;
        }

        const run = await orchestrator.dispatch(taskId, agent.id, task.description);
        const terminalRun = await orchestrator.waitForRun(run.runId);
        console.log(JSON.stringify(terminalRun, null, 2));
        break;
      }

      case 'task:verdict': {
        const flags = parseFlags(args);
        const runId = requiredFlag(flags, 'run', '--run <id>');
        const action = requiredFlag(flags, 'action', '--action passed|rejected|rework');
        const reviewer = requiredFlag(flags, 'reviewer', '--reviewer <id>');
        if (!['passed', 'rejected', 'rework'].includes(action)) {
          throw new Error(`Invalid verdict action: ${action}`);
        }
        const result = await orchestrator.submitVerdict(runId, action, reviewer, flags.note || '');
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'run:interrupt': {
        const flags = parseFlags(args);
        const runId = requiredFlag(flags, 'run', '--run <id>');
        const result = await orchestrator.interrupt(runId);
        if (!result.ok) throw new Error(result.error || `Unable to interrupt Run: ${runId}`);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'bus:tail': {
        const events = await bus.readAll();
        const count = Number.parseInt(args[0], 10) || 20;
        for (const event of events.slice(-count)) {
          console.log(`[${event.seq}] ${event.ts} ${event.kind}: ${JSON.stringify(event.payload).slice(0, 120)}`);
        }
        break;
      }

      case 'audit': {
        const result = await bus.integrityCheck();
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
        break;
      }

      case 'metrics': {
        const rawWindow = args[0] === undefined ? 3600000 : Number(args[0]);
        if (!Number.isInteger(rawWindow) || rawWindow <= 0) {
          throw new Error('windowMs must be a positive integer');
        }
        const events = await bus.readAll();
        console.log(JSON.stringify({
          ok: true,
          windowMs: rawWindow,
          metrics: aggregateMetrics(events, { sinceMs: rawWindow }),
        }, null, 2));
        break;
      }

      case 'replay':
        console.log(`[ok] replayed ${orchestrator.tasks.size} tasks, ${orchestrator.runs.size} runs`);
        break;

      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } finally {
    await runtime?.bus.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === awbFile) {
  main().catch(error => {
    console.error(`awb: ${error.message}`);
    process.exitCode = 1;
  });
}
