import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const workbenchDir = fileURLToPath(new URL('..', import.meta.url));

function runCli(storeDir, ...args) {
  const extraEnv = args[0] && typeof args[0] === 'object' ? args.shift() : {};
  return spawnSync(process.execPath, ['awb.mjs', ...args], {
    cwd: workbenchDir,
    env: { ...process.env, AWB_STORE: storeDir, ...extraEnv },
    encoding: 'utf8',
    timeout: 20_000,
  });
}

function assertCliSuccess(result, command) {
  assert.equal(
    result.status,
    0,
    `${command} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function readEvents(storeDir) {
  return readFileSync(join(storeDir, 'eventbus', 'bus.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

test('runtime initialization closes an initialized bus when registry setup fails', async () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'awb-cli-'));
  const { EventBus } = await import('../core/bus.mjs');
  const { AgentRegistry } = await import('../core/registry.mjs');
  const awb = await import('../awb.mjs?runtime-init-cleanup');
  const originalInit = EventBus.prototype.init;
  const originalLoad = AgentRegistry.prototype.load;
  const originalStore = process.env.AWB_STORE;
  let initializedBus;
  let writerClosed;

  try {
    assert.equal(typeof awb.initializeRuntime, 'function');
    EventBus.prototype.init = async function initAndCapture() {
      await originalInit.call(this);
      initializedBus = this;
      writerClosed = once(this._writer, 'close');
    };
    AgentRegistry.prototype.load = function failRegistryLoad() {
      throw new Error('forced registry initialization failure');
    };
    process.env.AWB_STORE = storeDir;

    await assert.rejects(
      () => awb.initializeRuntime(),
      /forced registry initialization failure/,
    );
    assert.ok(initializedBus, 'EventBus.init() did not complete before the forced failure');
    await assert.rejects(
      () => initializedBus.append('system', { test: 'must be closed' }),
      /not initialized/i,
    );
    await writerClosed;
  } finally {
    EventBus.prototype.init = originalInit;
    AgentRegistry.prototype.load = originalLoad;
    if (originalStore === undefined) delete process.env.AWB_STORE;
    else process.env.AWB_STORE = originalStore;
    await initializedBus?.close();
    await writerClosed;
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test('CLI uses one persisted runtime for Echo dispatch, replay, and audit', () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'awb-cli-'));

  try {
    const agents = runCli(storeDir, 'agents:list');
    assertCliSuccess(agents, 'agents:list');
    const echoRow = agents.stdout.split(/\r?\n/).find(line => line.startsWith('echo-test'));
    assert.ok(echoRow, `echo-test row missing from stdout:\n${agents.stdout}`);
    assert.equal(echoRow.trim().split(/\s+/).at(-1), 'available');

    const created = runCli(
      storeDir,
      'task:create',
      '--title', 'CLI Echo smoke',
      '--requiredTags', 'read',
      '--description', 'complete through the unified runtime',
    );
    assertCliSuccess(created, 'task:create');
    const taskId = created.stdout.match(/\[ok\] task created: (\S+)/)?.[1];
    assert.ok(taskId, `task ID missing from stdout:\n${created.stdout}`);

    const dispatched = runCli(storeDir, 'task:dispatch', '--task', taskId, '--agent', 'echo-test');
    assertCliSuccess(dispatched, 'task:dispatch');
    assert.match(dispatched.stdout, /"state": "completed"/);
    const runId = dispatched.stdout.match(/"runId": "([^"]+)"/)?.[1];
    assert.ok(runId, `run ID missing from stdout:\n${dispatched.stdout}`);

    const events = readEvents(storeDir);
    assert.equal(
      events.filter(event => event.payload?.action === 'task.created').length,
      1,
    );
    assert.deepEqual(
      events
        .filter(event => event.runId === runId && event.kind === 'run')
        .map(event => event.payload?.type),
      [
        'run.created',
        'run.snapshot.created',
        'run.started',
        'run.thinking',
        'run.stdout',
        'run.completed',
        'run.snapshot.created',
        'run.diff.created',
      ],
    );

    const replayed = runCli(storeDir, 'replay');
    assertCliSuccess(replayed, 'replay');
    assert.match(replayed.stdout, /replayed 1 tasks, 1 runs/);

    const audited = runCli(storeDir, 'audit');
    assertCliSuccess(audited, 'audit');
    assert.match(audited.stdout, /"ok": true/);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test('audit reports corrupt stores as JSON and exits nonzero', () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'awb-cli-'));

  try {
    const eventbusDir = join(storeDir, 'eventbus');
    mkdirSync(eventbusDir, { recursive: true });
    writeFileSync(
      join(eventbusDir, 'bus.jsonl'),
      '{"seq":2,"kind":"system","payload":{}}\n',
    );

    const audited = runCli(storeDir, 'audit');
    assert.notEqual(audited.status, 0);
    assert.equal(JSON.parse(audited.stdout).ok, false);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test('unknown explicit Agent exits nonzero without creating a Run event', () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'awb-cli-'));

  try {
    const created = runCli(storeDir, 'task:create', '--title', 'Unknown agent', '--requiredTags', 'read');
    assertCliSuccess(created, 'task:create');
    const taskId = created.stdout.match(/\[ok\] task created: (\S+)/)?.[1];
    assert.ok(taskId, `task ID missing from stdout:\n${created.stdout}`);

    const dispatched = runCli(storeDir, 'task:dispatch', '--task', taskId, '--agent', 'missing-agent');
    assert.notEqual(dispatched.status, 0);
    assert.match(dispatched.stderr, /agent not found: missing-agent/i);
    assert.equal(readEvents(storeDir).filter(event => event.kind === 'run').length, 0);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test('CLI dispatches a configured Claude stream-json fixture', () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'awb-cli-fixture-'));
  const agentsDir = mkdtempSync(join(tmpdir(), 'awb-agents-fixture-'));
  const fixture = join(workbenchDir, 'fixtures', 'fake-claude.mjs');
  writeFileSync(join(agentsDir, 'fixture.json'), JSON.stringify({
    id: 'fixture-claude', displayName: 'Fixture Claude', type: 'claude-stream-json', outputProtocol: 'stream-json', riskLevel: 'read-only', command: process.execPath, args: [fixture],
    inputProtocol: 'stdin', capabilityTags: ['read'],
    healthCheck: { command: process.execPath, args: ['-e', 'process.stdout.write("ok")'] },
  }));
  try {
    const created = runCli(storeDir, { AWB_AGENTS_DIR: agentsDir }, 'task:create', '--title', 'fixture', '--requiredTags', 'read');
    assertCliSuccess(created, 'task:create');
    const taskId = created.stdout.match(/\[ok\] task created: (\S+)/)?.[1];
    const dispatched = runCli(storeDir, { AWB_AGENTS_DIR: agentsDir }, 'task:dispatch', '--task', taskId, '--agent', 'fixture-claude');
    assertCliSuccess(dispatched, 'task:dispatch fixture');
    assert.match(dispatched.stdout, /"state": "completed"/);
    const runId = dispatched.stdout.match(/"runId": "([^"]+)"/)?.[1];
    assert.equal(readEvents(storeDir).filter(event => event.runId === runId && event.payload?.type === 'run.completed').length, 1);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(agentsDir, { recursive: true, force: true });
  }
});

test('deferred rollback command is not exposed by the Echo MVP CLI', () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'awb-cli-'));

  try {
    const help = runCli(storeDir, '--help');
    assertCliSuccess(help, '--help');
    assert.doesNotMatch(help.stdout, /run:rollback/);

    const rollback = runCli(storeDir, 'run:rollback', '--run', 'run-deferred');
    assert.notEqual(rollback.status, 0);
    assert.match(rollback.stderr, /unknown command: run:rollback/i);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test('CLI exposes approval commands for high-risk tasks', () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'awb-cli-approval-'));

  try {
    const created = runCli(storeDir, 'task:create', '--title', 'High risk', '--requiredTags', 'read', '--sandboxMode', 'high-risk');
    assertCliSuccess(created, 'task:create high-risk');
    const taskId = created.stdout.match(/\[ok\] task created: (\S+)/)?.[1];
    assert.ok(taskId, `task ID missing from stdout:\n${created.stdout}`);

    const blocked = runCli(storeDir, 'task:dispatch', '--task', taskId, '--agent', 'echo-test');
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /approval_required|approval is pending/i);

    const approved = runCli(storeDir, 'task:approve', '--task', taskId, '--reviewer', 'human', '--agent', 'echo-test');
    assertCliSuccess(approved, 'task:approve');
    assert.match(approved.stdout, /"status": "approved"/);

    const dispatched = runCli(storeDir, 'task:dispatch', '--task', taskId, '--agent', 'echo-test');
    assertCliSuccess(dispatched, 'task:dispatch after approval');
    assert.match(dispatched.stdout, /"state": "completed"/);

    const metrics = runCli(storeDir, 'metrics', '60000');
    assertCliSuccess(metrics, 'metrics');
    assert.match(metrics.stdout, /"run.completed"/);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test('CLI decomposes and runs a Planner DAG through Inline Execution', () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'awb-cli-dag-'));
  const agentsDir = mkdtempSync(join(tmpdir(), 'awb-cli-dag-agents-'));
  try {
    const echoConfig = readFileSync(join(workbenchDir, 'agents', 'echo.json'), 'utf8');
    writeFileSync(join(agentsDir, 'echo.json'), echoConfig);
    writeFileSync(join(agentsDir, 'planner.json'), JSON.stringify({
      id: 'planner-test', displayName: 'Planner Test', type: 'echo', outputProtocol: 'echo',
      riskLevel: 'read-only', capabilityTags: ['design'], command: null, args: [], env: {}, healthCheck: null,
    }));

    const created = runCli(storeDir, { AWB_AGENTS_DIR: agentsDir }, 'task:create', '--title', 'Plan graph', '--requiredTags', 'read');
    assertCliSuccess(created, 'task:create graph');
    const taskId = created.stdout.match(/\[ok\] task created: (\S+)/)?.[1];
    assert.ok(taskId);
    const prompt = '{"tasks":[{"taskId":"task-cli-a","requiredTags":["read"]},{"taskId":"task-cli-b","requiredTags":["read"],"dependencies":["task-cli-a"]}]}';
    const decomposed = runCli(storeDir, { AWB_AGENTS_DIR: agentsDir }, 'task:decompose', '--task', taskId, '--planner', 'planner-test', '--prompt', prompt);
    assertCliSuccess(decomposed, 'task:decompose');
    assert.match(decomposed.stdout, /task-cli-a/);
    const executed = runCli(storeDir, { AWB_AGENTS_DIR: agentsDir }, 'task:run', '--task', taskId, '--maxParallel', '2');
    assertCliSuccess(executed, 'task:run');
    assert.match(executed.stdout, /"completed": 2/);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(agentsDir, { recursive: true, force: true });
  }
});
