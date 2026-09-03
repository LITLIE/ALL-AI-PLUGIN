import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('M8-B discovery and explicit import contract is documented', async () => {
  const [spec, architecture, agents, readme, assessment] = await Promise.all([
    text('workbench/docs/SPEC.md'),
    text('workbench/docs/ARCHITECTURE.md'),
    text('workbench/agents/README.md'),
    text('README.md'),
    text('docs/assessment/2026-09-02-项目成熟度评估与改进路线.md'),
  ]);
  for (const document of [spec, architecture, agents, readme]) {
    assert.match(document, /agents:discover|agents\/discover/);
    assert.match(document, /explicit/i);
    assert.match(document, /source/);
    assert.match(document, /confidence/);
  }
  assert.match(spec, /unknown.*(?:route|路由)|(?:route|路由).*unknown/i);
  assert.match(assessment, /M8-B[^\n]*(?:完成|shipped|已完成)/i);
  assert.match(assessment, /只读|read-only/);
});
