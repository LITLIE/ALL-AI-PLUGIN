import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import adapter from '../adapters/codex-app-server.mjs';

const fixture = fileURLToPath(new URL('../fixtures/fake-codex-app-server.mjs', import.meta.url));

test('Codex adapter completes from a turn notification before timeout', async () => {
  const started = Date.now();
  const events = [];
  for await (const event of adapter.run({
    taskId: 'task-codex', runId: 'run-codex', prompt: 'hello', cwd: process.cwd(), timeoutMs: 2000,
    agentConfig: { id: 'fixture-codex', type: 'codex-app-server', command: process.execPath, args: [fixture] },
  })) events.push(event);
  assert.ok(Date.now() - started < 1000);
  assert.equal(events.filter(event => event.type === 'run.completed').length, 1);
  assert.equal(events.filter(event => ['run.failed', 'run.timeout', 'run.interrupted'].includes(event.type)).length, 0);
  assert.ok(events.some(event => event.type === 'codex.thread.started' && event.threadId === 'thread-fixture'));
  assert.ok(events.some(event => event.type === 'codex.turn.started' && event.turnId === 'turn-fixture'));
  assert.equal(events.at(-1).text, 'codex done');
});

test('Codex adapter extracts nested turn completion payloads', async () => {
  const events = [];
  for await (const event of adapter.run({
    taskId: 'task-codex-nested', runId: 'run-codex-nested', prompt: 'hello', cwd: process.cwd(), timeoutMs: 2000,
    agentConfig: { id: 'fixture-codex-nested', type: 'codex-app-server', command: process.execPath, args: [fixture], env: { FAKE_CODEX_NESTED: '1' } },
  })) events.push(event);
  const completed = events.find(event => event.type === 'run.completed');
  assert.equal(completed?.text, 'nested done');
  assert.equal(completed?.cost, 0.03);
});

test('Codex adapter accepts event_msg task_complete payloads', async () => {
  const events = [];
  for await (const event of adapter.run({
    taskId: 'task-codex-event-msg', runId: 'run-codex-event-msg', prompt: 'hello', cwd: process.cwd(), timeoutMs: 2000,
    agentConfig: { id: 'fixture-codex-event-msg', type: 'codex-app-server', command: process.execPath, args: [fixture], env: { FAKE_CODEX_EVENT_MSG: '1' } },
  })) events.push(event);
  const completed = events.find(event => event.type === 'run.completed');
  assert.equal(completed?.text, 'event msg done');
  assert.equal(completed?.cost, 0.04);
});

test('Codex adapter fails on a server error notification', async () => {
  const events = [];
  for await (const event of adapter.run({
    taskId: 'task-codex-error', runId: 'run-codex-error', prompt: 'hello', cwd: process.cwd(), timeoutMs: 2000,
    agentConfig: { id: 'fixture-codex-error', type: 'codex-app-server', command: process.execPath, args: [fixture], env: { FAKE_CODEX_ERROR: '1' } },
  })) events.push(event);
  const terminals = events.filter(event => ['run.completed', 'run.failed', 'run.timeout', 'run.interrupted'].includes(event.type));
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].type, 'run.failed');
  assert.match(terminals[0].error, /fixture server error/);
});

test('Codex adapter fails when the app-server exits before completion', async () => {
  const events = [];
  for await (const event of adapter.run({
    taskId: 'task-codex-exit', runId: 'run-codex-exit', prompt: 'hello', cwd: process.cwd(), timeoutMs: 2000,
    agentConfig: { id: 'fixture-codex-exit', type: 'codex-app-server', command: process.execPath, args: [fixture], env: { FAKE_CODEX_EXIT: '1' } },
  })) events.push(event);
  const terminals = events.filter(event => ['run.completed', 'run.failed', 'run.timeout', 'run.interrupted'].includes(event.type));
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].type, 'run.failed');
  assert.match(terminals[0].error, /exited with code/);
});

test('Codex adapter emits exactly one timeout terminal and interrupts the turn', async () => {
  const events = [];
  for await (const event of adapter.run({
    taskId: 'task-codex-timeout', runId: 'run-codex-timeout', prompt: 'hello', cwd: process.cwd(), timeoutMs: 30,
    agentConfig: { id: 'fixture-codex-timeout', type: 'codex-app-server', command: process.execPath, args: [fixture], env: { FAKE_CODEX_HANG: '1' } },
  })) events.push(event);
  const terminals = events.filter(event => ['run.completed', 'run.failed', 'run.timeout', 'run.interrupted'].includes(event.type));
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].type, 'run.timeout');
});

test('Codex adapter abort emits one interrupted terminal and sends thread and turn ids', async () => {
  const controller = new AbortController();
  const events = [];
  const consume = (async () => {
    for await (const event of adapter.run({
      taskId: 'task-codex-abort', runId: 'run-codex-abort', prompt: 'hello', cwd: process.cwd(), timeoutMs: 2000,
      signal: controller.signal,
      agentConfig: { id: 'fixture-codex-abort', type: 'codex-app-server', command: process.execPath, args: [fixture], env: { FAKE_CODEX_HANG: '1', FAKE_CODEX_RECORD_INTERRUPT: '1' } },
    })) {
      events.push(event);
      if (event.type === 'codex.turn.started') controller.abort();
    }
  })();
  await consume;
  const terminals = events.filter(event => ['run.completed', 'run.failed', 'run.timeout', 'run.interrupted'].includes(event.type));
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].type, 'run.interrupted');
  assert.equal(terminals[0].threadId, 'thread-fixture');
  assert.equal(terminals[0].turnId, 'turn-fixture');
});

test('Codex adapter interrupt sends the active thread and turn ids', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'awb-codex-interrupt-'));
  const recordFile = join(tempDir, 'interrupt.jsonl');
  const runId = 'run-codex-direct-interrupt';
  const iterator = adapter.run({
    taskId: 'task-codex-direct-interrupt', runId, prompt: 'hello', cwd: process.cwd(), timeoutMs: 2000,
    agentConfig: {
      id: 'fixture-codex-direct-interrupt', type: 'codex-app-server', command: process.execPath, args: [fixture],
      env: { FAKE_CODEX_HANG: '1', FAKE_CODEX_RECORD_INTERRUPT: '1', FAKE_CODEX_INTERRUPT_FILE: recordFile },
    },
  })[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();
  await iterator.next();
  await iterator.next();
  assert.deepEqual(await adapter.interrupt({ runId }), { ok: true });
  await iterator.return();
  const requests = (await readFile(recordFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.ok(requests.some(params => params.threadId === 'thread-fixture' && params.turnId === 'turn-fixture'));
});
