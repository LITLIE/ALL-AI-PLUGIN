import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const files = [
  new URL('../../README.md', import.meta.url),
  new URL('../docs/SPEC.md', import.meta.url),
  new URL('../docs/ARCHITECTURE.md', import.meta.url),
  new URL('../agents/README.md', import.meta.url),
];

test('M7-B docs describe truthful probing and configuration-driven ACP/CLI execution', async () => {
  const text = (await Promise.all(files.map(file => readFile(file, 'utf8')))).join('\n');
  assert.match(text, /status[^\n]*unknown|unknown[^\n]*status/i);
  assert.match(text, /healthCheck\.expect/);
  assert.match(text, /ACP[^\n]*(configured|配置)|configured[^\n]*ACP/i);
  assert.match(text, /cli-text[^\n]*(configured|配置)|configured[^\n]*cli-text/i);
  assert.match(text, /unprobed[^\n]*(route|routable)|未探活[^\n]*(路由|选派)/i);
  assert.doesNotMatch(text, /ACP and human-bridge remain deferred/i);
});
