import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import vm from 'node:vm';

const agentsDir = fileURLToPath(new URL('../agents', import.meta.url));

async function json(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  return { response, body };
}

async function rawHttp(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = null; }
        resolve({ status: response.statusCode, headers: response.headers, text, body: parsed });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.end(typeof body === 'string' ? body : JSON.stringify(body));
    else req.end();
  });
}

async function closeRuntime(runtime) {
  await new Promise((resolve, reject) => {
    runtime.server.close(error => error ? reject(error) : resolve());
  });
  await runtime.bus.close();
}

async function readEventsUntil(response, predicate) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error('SSE stream ended before the expected event');
      buffer += decoder.decode(value, { stream: true });

      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n').find(line => line.startsWith('data: '));
        if (!data) continue;
        const event = JSON.parse(data.slice(6));
        events.push(event);
        if (predicate(event)) return events;
      }
    }
  } finally {
    await reader.cancel();
  }
}

test('HTTP runtime dispatches Echo through exclusive, duplicate-free SSE and replays state', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'awb-http-'));
  const previousCwd = process.cwd();
  process.chdir(workspace);
  const { startServer } = await import(`../server/http.mjs?smoke=${Date.now()}`);

  let runtime;
  let restarted;
  try {
    runtime = await startServer({ host: '127.0.0.1', port: 0, agentsDir });
    const address = runtime.server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const health = await json(`${baseUrl}/api/health`);
    assert.equal(health.response.status, 200);
    assert.equal(health.body.ok, true);

    const agents = await json(`${baseUrl}/api/agents`);
    const echo = agents.body.agents.find(agent => agent.id === 'echo-test');
    assert.equal(echo.probe.ok, true);
    assert.equal(echo.available, true);

    const created = await json(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId: 'task-http-echo',
        description: 'echo over http',
        requiredTags: ['read'],
      }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.taskId, 'task-http-echo');

    const sseResponse = await fetch(`${baseUrl}/api/events?since=0`, {
      headers: { accept: 'text/event-stream' },
    });
    assert.equal(sseResponse.status, 200);

    const dispatched = await json(`${baseUrl}/api/tasks/task-http-echo/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'echo-test', prompt: 'hello from smoke test' }),
    });
    assert.equal(dispatched.response.status, 201);
    assert.equal(dispatched.body.taskId, 'task-http-echo');
    assert.equal(dispatched.body.agentId, 'echo-test');
    assert.match(dispatched.body.runId, /^run-/);

    const events = await readEventsUntil(
      sseResponse,
      event => event.runId === dispatched.body.runId && event.payload?.type === 'run.completed',
    );
    const sequences = events.map(event => event.seq);
    assert.deepEqual(sequences, [...new Set(sequences)]);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
    assert.ok(events.every(event => event.seq > 0));
    assert.match(events.at(-1).payload.text, /hello from smoke test/);

    const invalid = await json(`${baseUrl}/api/tasks/task-http-echo/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'missing-agent', prompt: 'must reject' }),
    });
    assert.equal(invalid.response.status, 400);

    const beforeMalformedReviewer = await runtime.bus.readAll();
    for (const reviewerId of [undefined, '   ', 42]) {
      const malformed = await json(`${baseUrl}/api/runs/${dispatched.body.runId}/verdict`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: 'passed', reviewerId, reason: 'must reject' }),
      });
      assert.equal(malformed.response.status, 400);
      assert.equal(malformed.body.error, 'invalid_reviewer');
    }
    assert.deepEqual(await runtime.bus.readAll(), beforeMalformedReviewer);

    await closeRuntime(runtime);
    runtime = null;

    restarted = await startServer({ host: '127.0.0.1', port: 0, agentsDir });
    const restartedAddress = restarted.server.address();
    const tasks = await json(`http://127.0.0.1:${restartedAddress.port}/api/tasks`);
    const replayed = tasks.body.tasks.find(task => task.taskId === 'task-http-echo');
    assert.equal(replayed.state, 'awaiting-review');
    assert.deepEqual(replayed.assignedRuns, [dispatched.body.runId]);
  } finally {
    if (runtime) await closeRuntime(runtime);
    if (restarted) await closeRuntime(restarted);
    process.chdir(previousCwd);
    await rm(workspace, { recursive: true, force: true });
  }
});

test('HTTP rejects spoofed origins and IDs, contains static files, and disables deferred surfaces', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'awb-http-security-'));
  const previousCwd = process.cwd();
  process.chdir(workspace);
  const { startServer } = await import(`../server/http.mjs?security=${Date.now()}`);
  let runtime;

  try {
    runtime = await startServer({ host: '127.0.0.1', port: 0, agentsDir });
    const port = runtime.server.address().port;
    const host = `127.0.0.1:${port}`;

    const spoofedHost = await rawHttp(port, '/api/health', {
      headers: { host: `127.0.0.1.evil:${port}` },
    });
    assert.equal(spoofedHost.status, 403);

    const beforeRejectedMutations = await runtime.bus.readAll();
    const crossOrigin = await rawHttp(port, '/api/tasks', {
      method: 'POST',
      headers: {
        host,
        origin: 'http://evil.example',
        'content-type': 'application/json',
      },
      body: { description: 'must not persist', requiredTags: ['read'] },
    });
    assert.equal(crossOrigin.status, 403);

    for (const taskId of ['../unsafe', '', null, 42]) {
      const unsafeId = await rawHttp(port, '/api/tasks', {
        method: 'POST',
        headers: { host, 'content-type': 'application/json' },
        body: { taskId, description: 'must not persist', requiredTags: ['read'] },
      });
      assert.equal(unsafeId.status, 400, `taskId=${JSON.stringify(taskId)}`);
      assert.equal(unsafeId.body?.error, 'invalid_task_id');
    }
    assert.deepEqual(await runtime.bus.readAll(), beforeRejectedMutations);

    const generated = await rawHttp(port, '/api/tasks', {
      method: 'POST',
      headers: { host, 'content-type': 'application/json' },
      body: { description: 'server-generated id', requiredTags: ['read'] },
    });
    assert.equal(generated.status, 201);
    assert.match(generated.body?.taskId, /^task-[a-z0-9]+-[a-z0-9]+$/);

    const runsBeforeNonEcho = runtime.orchestrator.runs.size;
    const nonEcho = await rawHttp(port, `/api/tasks/${generated.body.taskId}/dispatch`, {
      method: 'POST',
      headers: { host, 'content-type': 'application/json' },
      body: { agentId: 'missing-agent', prompt: 'must reject unknown agent' },
    });
    assert.equal(nonEcho.status, 400);
    assert.equal(runtime.orchestrator.runs.size, runsBeforeNonEcho);

    const traversal = await rawHttp(port, '/../package.json', { headers: { host } });
    assert.notEqual(traversal.status, 200);
    assert.doesNotMatch(traversal.text, /"name"\s*:\s*"agent-workbench"/);

    const beforeDeferred = await runtime.bus.readAll();
    const deferred = [
      ['POST', '/api/runs/run-deferred/apply', 404, 'run_not_found'],
      ['POST', '/api/runs/run-deferred/rollback', 404, 'run_not_found'],
      ['GET', '/api/runs/run-deferred/diff', 404, 'run_not_found'],
      ['POST', '/api/bridges/run-deferred/submit', 404, 'run_not_found'],
    ];
    for (const [method, path, status, error] of deferred) {
      const response = await rawHttp(port, path, {
        method,
        headers: { host, 'content-type': 'application/json' },
        body: method === 'POST' ? {} : undefined,
      });
      assert.equal(response.status, status, `${method} ${path}`);
      assert.equal(response.body?.error, error);
    }
    assert.deepEqual(await runtime.bus.readAll(), beforeDeferred);
  } finally {
    if (runtime) await closeRuntime(runtime);
    process.chdir(previousCwd);
    await rm(workspace, { recursive: true, force: true });
  }
});

test('HTTP exposes diff and gates apply/rollback through verdict state', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'awb-http-diff-'));
  const previousCwd = process.cwd();
  process.chdir(workspace);
  const { startServer } = await import(`../server/http.mjs?diff=${Date.now()}`);
  let runtime;
  try {
    runtime = await startServer({ host: '127.0.0.1', port: 0, agentsDir });
    const port = runtime.server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const created = await json(`${baseUrl}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'task-http-diff', description: 'diff', requiredTags: ['read'] }) });
    const dispatched = await json(`${baseUrl}/api/tasks/task-http-diff/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'echo-test', prompt: 'diff' }) });
    await runtime.orchestrator.waitForRun(dispatched.body.runId);

    const diff = await json(`${baseUrl}/api/runs/${dispatched.body.runId}/diff`);
    assert.equal(diff.response.status, 200);
    assert.deepEqual(diff.body.diff, { added: [], modified: [], deleted: [] });

    const blocked = await json(`${baseUrl}/api/runs/${dispatched.body.runId}/apply`, { method: 'POST' });
    assert.equal(blocked.response.status, 409);
    assert.equal(blocked.body.error, 'verdict_required');

    const verdict = await json(`${baseUrl}/api/runs/${dispatched.body.runId}/verdict`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verdict: 'passed', reviewerId: 'human' }) });
    assert.equal(verdict.response.status, 200);
    const applied = await json(`${baseUrl}/api/runs/${dispatched.body.runId}/apply`, { method: 'POST' });
    assert.equal(applied.response.status, 200);
    const rolledBack = await json(`${baseUrl}/api/runs/${dispatched.body.runId}/rollback`, { method: 'POST' });
    assert.equal(rolledBack.response.status, 200);
  } finally {
    if (runtime) await closeRuntime(runtime);
    process.chdir(previousCwd);
    await rm(workspace, { recursive: true, force: true });
  }
});

test('HTTP approval gate blocks and then permits a high-risk task', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'awb-http-approval-'));
  const previousCwd = process.cwd();
  process.chdir(workspace);
  const { startServer } = await import(`../server/http.mjs?approval=${Date.now()}`);
  let runtime;
  try {
    runtime = await startServer({ host: '127.0.0.1', port: 0, agentsDir });
    const baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;
    const created = await json(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 'task-http-approval', description: 'high risk', requiredTags: ['read'], sandboxMode: 'high-risk' }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.approval.status, 'pending');

    const blocked = await json(`${baseUrl}/api/tasks/task-http-approval/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'echo-test', prompt: 'blocked' }),
    });
    assert.equal(blocked.response.status, 409);
    assert.equal(blocked.body.error, 'approval_required');

    const approval = await json(`${baseUrl}/api/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 'task-http-approval', decision: 'approved', reviewerId: 'human', agentId: 'echo-test' }),
    });
    assert.equal(approval.response.status, 200);
    assert.equal(approval.body.approval.status, 'approved');

    const dispatched = await json(`${baseUrl}/api/tasks/task-http-approval/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'echo-test', prompt: 'approved' }),
    });
    assert.equal(dispatched.response.status, 201);
  } finally {
    if (runtime) await closeRuntime(runtime);
    process.chdir(previousCwd);
    await rm(workspace, { recursive: true, force: true });
  }
});

test('HTTP exposes aggregated lifecycle metrics with window validation', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'awb-http-metrics-'));
  const previousCwd = process.cwd();
  process.chdir(workspace);
  const { startServer } = await import(`../server/http.mjs?metrics=${Date.now()}`);
  let runtime;
  try {
    runtime = await startServer({ host: '127.0.0.1', port: 0, agentsDir });
    const baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;
    await json(`${baseUrl}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 'task-http-metrics', description: 'metrics', requiredTags: ['read'] }),
    });
    const dispatched = await json(`${baseUrl}/api/tasks/task-http-metrics/dispatch`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'echo-test', prompt: 'metrics' }),
    });
    assert.equal(dispatched.response.status, 201);
    const metrics = await json(`${baseUrl}/api/metrics?windowMs=60000`);
    assert.equal(metrics.response.status, 200);
    assert.equal(metrics.body.ok, true);
    assert.equal(metrics.body.metrics.counts['run.completed'], 1);
    const invalid = await json(`${baseUrl}/api/metrics?windowMs=0`);
    assert.equal(invalid.response.status, 400);
  } finally {
    if (runtime) await closeRuntime(runtime);
    process.chdir(previousCwd);
    await rm(workspace, { recursive: true, force: true });
  }
});

test('HTTP server rejects non-loopback host binding', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'awb-http-host-'));
  const previousCwd = process.cwd();
  process.chdir(workspace);
  const { startServer } = await import(`../server/http.mjs?host=${Date.now()}`);
  try {
    await assert.rejects(
      startServer({ host: '0.0.0.0', port: 0, agentsDir }),
      /loopback|127\.0\.0\.1/i,
    );
  } finally {
    process.chdir(previousCwd);
    await rm(workspace, { recursive: true, force: true });
  }
});

test('HTTP exposes Planner decomposition and graph execution routes', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'awb-http-dag-'));
  const plannerAgentsDir = await mkdtemp(join(tmpdir(), 'awb-http-dag-agents-'));
  const previousCwd = process.cwd();
  process.chdir(workspace);
  const { startServer } = await import(`../server/http.mjs?dag=${Date.now()}`);
  let runtime;
  try {
    await writeFile(join(plannerAgentsDir, 'echo.json'), await readFile(join(agentsDir, 'echo.json')));
    await writeFile(join(plannerAgentsDir, 'planner.json'), JSON.stringify({
      id: 'planner-test', displayName: 'Planner Test', type: 'echo', outputProtocol: 'echo',
      riskLevel: 'read-only', capabilityTags: ['design'], command: null, args: [], env: {}, healthCheck: null,
    }));
    runtime = await startServer({ host: '127.0.0.1', port: 0, agentsDir: plannerAgentsDir });
    const baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;
    const created = await json(`${baseUrl}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 'task-http-dag', description: 'graph', requiredTags: ['read'] }),
    });
    const plan = await json(`${baseUrl}/api/tasks/task-http-dag/decompose`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plannerAgentId: 'planner-test', prompt: '{"tasks":[{"taskId":"task-http-a","requiredTags":["read"]},{"taskId":"task-http-b","requiredTags":["read"],"dependencies":["task-http-a"]}]}' }),
    });
    assert.equal(plan.response.status, 201);
    assert.deepEqual(plan.body.task.children, ['task-http-a', 'task-http-b']);
    const executed = await json(`${baseUrl}/api/tasks/task-http-dag/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxParallel: 2 }),
    });
    assert.equal(executed.response.status, 200);
    assert.equal(executed.body.aggregate.completed, 2);
    const invalid = await json(`${baseUrl}/api/tasks/task-http-dag/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxParallel: 0 }),
    });
    assert.equal(invalid.response.status, 400);
  } finally {
    if (runtime) await closeRuntime(runtime);
    process.chdir(previousCwd);
    await rm(workspace, { recursive: true, force: true });
    await rm(plannerAgentsDir, { recursive: true, force: true });
  }
});

test('SSE replays only seq greater than since and reconnects without duplicates', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'awb-http-sse-'));
  const previousCwd = process.cwd();
  process.chdir(workspace);
  const { startServer } = await import(`../server/http.mjs?sse=${Date.now()}`);
  let runtime;
  try {
    runtime = await startServer({ host: '127.0.0.1', port: 0, agentsDir });
    const port = runtime.server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const first = await runtime.bus.append('system', { type: 'test.event', value: 1 });
    const second = await runtime.bus.append('system', { type: 'test.event', value: 2 });

    const replayResponse = await fetch(`${baseUrl}/api/events?since=${first.seq - 1}`, { headers: { accept: 'text/event-stream' } });
    const replayed = await readEventsUntil(replayResponse, event => event.seq === second.seq);
    assert.deepEqual(replayed.map(event => event.seq), [first.seq, second.seq]);

    const reconnectResponse = await fetch(`${baseUrl}/api/events?since=${second.seq}`, { headers: { accept: 'text/event-stream' } });
    const third = await runtime.bus.append('system', { type: 'test.event', value: 3 });
    const reconnected = await readEventsUntil(reconnectResponse, event => event.seq === third.seq);
    assert.deepEqual(reconnected.map(event => event.seq), [third.seq]);
  } finally {
    if (runtime) await closeRuntime(runtime);
    process.chdir(previousCwd);
    await rm(workspace, { recursive: true, force: true });
  }
});

test('served UI module is browser-safe without Node process or imports', async () => {
  const source = await readFile(fileURLToPath(new URL('../ui/app.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /\bprocess\s*\./);
  assert.doesNotMatch(source, /node:/);
  const app = { innerHTML: '' };
  const context = vm.createContext({
    window: { addEventListener() {}, scrollTo() {} },
    document: {
      getElementById(id) { return id === 'app' ? app : null; },
      querySelectorAll() { return []; },
    },
    history: { pushState() {} },
    fetch() {}, EventSource: class {}, setTimeout, clearTimeout,
    setupIcons() {}, alert() {},
  });
  const browserSource = source
    .replace(/^import .*?;\s*/m, '')
    .replace(/export function navigate/, 'function navigate')
    .replace(/\r?\ninit\(\);\s*$/, '\nglobalThis.__awbTest = { S, render };');
  assert.doesNotThrow(() => new vm.Script(browserSource).runInContext(context));

  const { S, render } = context.__awbTest;
  Object.assign(S, {
    view: 'tasks',
    params: {},
    agents: [],
    events: [],
    tasks: [{
      taskId: 'task-" onmouseover="alert(1)',
      description: 'unsafe attribute probe',
      state: 'pending',
      assignedRuns: [],
    }],
  });
  render();
  assert.match(app.innerHTML, /data-id="task-&quot; onmouseover=&quot;alert\(1\)"/);
  assert.doesNotMatch(app.innerHTML, /data-id="task-" onmouseover=/);

  S.view = 'review';
  S.selectedRun = 'run-review';
  S._reviewData = { run: { runId: 'run-review', agentId: 'echo-test', text: 'echo output' } };
  render();
  assert.match(app.innerHTML, /通过/);
  assert.match(app.innerHTML, /变更文件/);
  assert.doesNotMatch(app.innerHTML, /高风险操作待审批/);
});
