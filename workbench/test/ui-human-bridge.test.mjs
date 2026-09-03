import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

function loadUi() {
  return readFile(fileURLToPath(new URL('../ui/app.mjs', import.meta.url)), 'utf8');
}

test('UI renders an awaiting-human bridge panel with briefing and receipt action', async () => {
  const source = await loadUi();
  const app = { innerHTML: '' };
  const context = vm.createContext({
    window: { addEventListener() {}, scrollTo() {} },
    document: { getElementById(id) { return id === 'app' ? app : null; }, querySelectorAll() { return []; } },
    history: { pushState() {} },
    fetch() {}, EventSource: class {}, setTimeout, clearTimeout,
    setupIcons() {}, alert() {}, navigator: { clipboard: { writeText: async () => {} } },
  });
  const browserSource = source
    .replace(/^import .*?;\s*/m, '')
    .replace(/export function navigate/, 'function navigate')
    .replace(/\r?\ninit\(\);\s*$/, '\nglobalThis.__awbTest = { S, render };');
  assert.doesNotThrow(() => new vm.Script(browserSource).runInContext(context));

  const { S, render } = context.__awbTest;
  Object.assign(S, {
    view: 'task',
    params: { id: 'task-bridge-ui' },
    agents: [],
    events: [{ seq: 1, kind: 'bridge', payload: { type: 'bridge.requested', runId: 'run-bridge-ui' } }],
    tasks: [],
    selectedTask: {
      taskId: 'task-bridge-ui',
      description: 'GUI task',
      state: 'awaiting-human',
      assignedRuns: ['run-bridge-ui'],
      runs: [{
        runId: 'run-bridge-ui',
        agentId: 'trae-solo-bridge',
        state: 'awaiting-human',
        briefing: 'Copy this briefing to Trae SOLO',
      }],
    },
  });
  render();
  assert.match(app.innerHTML, /awaiting-human|等待人工/);
  assert.match(app.innerHTML, /Copy this briefing to Trae SOLO/);
  assert.match(app.innerHTML, /data-action="copyBriefing"/);
  assert.match(app.innerHTML, /data-action="submitBridge"/);
  assert.match(source, /\/api\/bridges\/\$\{encodeURIComponent\(runId\)\}\/submit/);
});

test('UI source remains browser-safe and projects bridge events', async () => {
  const source = await loadUi();
  assert.doesNotMatch(source, /\bprocess\s*\./);
  assert.doesNotMatch(source, /node:/);
  assert.match(source, /run\.awaiting-human/);
  assert.match(source, /bridge\.requested/);
  assert.match(source, /bridge\.submitted/);
});

test('UI review view exposes diff summary and gated apply or rollback actions', async () => {
  const source = await loadUi();
  const app = { innerHTML: '' };
  const context = vm.createContext({
    window: { addEventListener() {}, scrollTo() {} },
    document: { getElementById(id) { return id === 'app' ? app : null; }, querySelectorAll() { return []; } },
    history: { pushState() {} }, fetch() {}, EventSource: class {}, setTimeout, clearTimeout,
    setupIcons() {}, alert() {}, navigator: {},
  });
  const browserSource = source
    .replace(/^import .*?;\s*/m, '')
    .replace(/export function navigate/, 'function navigate')
    .replace(/\r?\ninit\(\);\s*$/, '\nglobalThis.__awbTest = { S, render };');
  new vm.Script(browserSource).runInContext(context);
  const { S, render } = context.__awbTest;
  Object.assign(S, {
    view: 'review', params: { runId: 'run-review-ui' }, tasks: [], agents: [], events: [],
    _reviewData: { run: {
      runId: 'run-review-ui', agentId: 'echo-test', state: 'completed', text: 'changed',
      diff: { added: [{ relPath: 'src/app.js' }], modified: [], deleted: [] },
    } },
  });
  render();
  assert.match(app.innerHTML, /变更文件/);
  assert.match(app.innerHTML, /src\/app\.js/);
  assert.match(app.innerHTML, /data-action="applyRun"/);
  assert.match(app.innerHTML, /data-action="rollbackRun"/);
});
