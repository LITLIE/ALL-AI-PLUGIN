import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

function loadUi() {
  return readFile(fileURLToPath(new URL('../ui/app.mjs', import.meta.url)), 'utf8');
}

function boot(source, { fetchImpl = () => Promise.resolve({ ok: true, json: async () => ({}) }), values = {} } = {}) {
  const app = { innerHTML: '' };
  const context = vm.createContext({
    window: { addEventListener() {}, scrollTo() {} },
    document: { getElementById(id) { return id === 'app' ? app : (id in values ? { value: values[id], checked: values[id] !== false, addEventListener() {} } : null); }, querySelectorAll() { return []; } },
    history: { pushState() {} }, fetch: fetchImpl, EventSource: class {}, setTimeout, clearTimeout,
    setupIcons() {}, alert() {}, navigator: {},
  });
  const browserSource = source
    .replace(/^import .*?;\s*/m, '')
    .replace(/export function navigate/, 'function navigate')
    .replace(/\r?\ninit\(\);\s*$/, '\nglobalThis.__awbTest = { S, render, handleAction };');
  new vm.Script(browserSource).runInContext(context);
  return { app, ...context.__awbTest };
}

test('Agent view renders discovery candidates and an explicit import editor', async () => {
  const source = await loadUi();
  const { app, S, render } = boot(source);
  Object.assign(S, {
    view: 'agents',
    agents: [],
    tasks: [],
    events: [],
    discovery: {
      candidates: [{
        id: 'codex', displayName: 'Codex CLI', source: 'path', confidence: 'high', status: 'available',
        resolved: 'C:/bin/codex', configDraft: {
          id: 'codex', displayName: 'Codex CLI', type: 'cli-text', outputProtocol: 'cli-text',
          riskLevel: 'read-only', capabilityTags: ['read'], command: 'codex', enabled: true,
        },
      }],
    },
    selectedDiscovery: null,
  });
  render();
  assert.match(app.innerHTML, /发现 Agent/);
  assert.match(app.innerHTML, /Codex CLI/);
  assert.match(app.innerHTML, /source|来源/);
  assert.match(app.innerHTML, /confidence|置信度/);
  assert.match(app.innerHTML, /configDraft|配置草稿/);
  assert.match(app.innerHTML, /data-action="discoverAgents"/);
  assert.match(source, /\/api\/agents\/discover/);
  assert.match(source, /\/api\/agents\/import/);
});

test('unprobed imported Agents are visibly unknown and offer re-probe', async () => {
  const source = await loadUi();
  const { app, S, render } = boot(source);
  Object.assign(S, {
    view: 'agents',
    agents: [{ id: 'imported', displayName: 'Imported', type: 'cli-text', enabled: true, available: false, probe: { status: 'unknown' }, capabilityTags: ['read'] }],
    tasks: [], events: [], discovery: { candidates: [] }, selectedDiscovery: null,
  });
  render();
  assert.match(app.innerHTML, /未探活|unknown/i);
  assert.match(app.innerHTML, /data-action="probeAgents"/);
  assert.match(app.innerHTML, /探活|刷新/);
});

test('import requires explicit confirmation before posting the selected draft', async () => {
  const source = await loadUi();
  const calls = [];
  const { app, S, render, handleAction } = boot(source, {
    values: { 'discovery-file': 'fixture.json', 'discovery-config': '{"id":"fixture"}' },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ agents: [] }) };
    },
  });
  Object.assign(S, {
    view: 'agents', agents: [], tasks: [], events: [],
    discovery: { candidates: [{ id: 'fixture', displayName: 'Fixture', source: 'path', confidence: 'high', status: 'available', configDraft: { id: 'fixture' } }] },
    selectedDiscovery: { id: 'fixture', displayName: 'Fixture', source: 'path', confidence: 'high', configDraft: { id: 'fixture' } },
  });
  render();
  await handleAction({ currentTarget: { dataset: { action: 'confirmDiscoveryImport' } } });
  assert.match(app.innerHTML, /确认导入 Agent 配置/);
  assert.equal(calls.length, 0);
  await handleAction({ currentTarget: { dataset: { action: 'doConfirm' } } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls[0].url, '/api/agents/import');
  assert.equal(calls[0].options.method, 'POST');
});

test('discovery editor exposes structured fields and routing impact preview', async () => {
  const source = await loadUi();
  const { app, S, render } = boot(source);
  Object.assign(S, {
    view: 'agents', agents: [], tasks: [], events: [],
    discovery: { candidates: [{ id: 'fixture', displayName: 'Fixture', source: 'path', confidence: 'high', status: 'available', configDraft: {
      id: 'fixture', displayName: 'Fixture', type: 'cli-text', outputProtocol: 'cli-text', riskLevel: 'workspace-write', capabilityTags: ['read', 'test'], command: 'fixture', enabled: true,
    } }] },
    selectedDiscovery: { id: 'fixture', displayName: 'Fixture', source: 'path', confidence: 'high', configDraft: {
      id: 'fixture', displayName: 'Fixture', type: 'cli-text', outputProtocol: 'cli-text', riskLevel: 'workspace-write', capabilityTags: ['read', 'test'], command: 'fixture', enabled: true,
    } },
  });
  render();
  assert.match(app.innerHTML, /id="discovery-displayName"/);
  assert.match(app.innerHTML, /id="discovery-command"/);
  assert.match(app.innerHTML, /id="discovery-risk"/);
  assert.match(app.innerHTML, /id="discovery-capabilities"/);
  assert.match(app.innerHTML, /id="discovery-enabled"/);
  assert.match(app.innerHTML, /路由影响|routing/i);
  assert.match(app.innerHTML, /read/);
  assert.match(app.innerHTML, /test/);
  assert.match(source, /syncDiscoveryFormToJson/);
  assert.match(source, /syncDiscoveryJsonToForm/);
});

test('confirmation summary uses the edited structured configuration', async () => {
  const source = await loadUi();
  const values = {
    'discovery-file': 'fixture.json',
    'discovery-config': JSON.stringify({ id: 'fixture', displayName: 'Edited', type: 'cli-text', outputProtocol: 'cli-text', riskLevel: 'read-only', capabilityTags: ['read'], command: 'fixture' }),
    'discovery-displayName': 'Edited',
    'discovery-command': 'fixture',
    'discovery-args': '--version',
    'discovery-risk': 'read-only',
  };
  const { app, S, render, handleAction } = boot(source, { values });
  Object.assign(S, {
    view: 'agents', agents: [], tasks: [], events: [],
    discovery: { candidates: [] },
    selectedDiscovery: { id: 'fixture', displayName: 'Fixture', source: 'path', confidence: 'high', configDraft: {
      id: 'fixture', displayName: 'Fixture', type: 'cli-text', outputProtocol: 'cli-text', riskLevel: 'read-only', capabilityTags: ['read'], command: 'fixture', enabled: true,
    } },
  });
  render();
  await handleAction({ currentTarget: { dataset: { action: 'confirmDiscoveryImport' } } });
  assert.match(app.innerHTML, /Edited|read-only/);
});
