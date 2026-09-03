import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const files = [
  new URL('../docs/ARCHITECTURE.md', import.meta.url),
  new URL('../docs/SPEC.md', import.meta.url),
  new URL('../../plugins/agent-crew/README.md', import.meta.url),
  new URL('../../docs/assessment/2026-09-02-项目成熟度评估与改进路线.md', import.meta.url),
];

test('M8-A docs identify the shared kernel and preserve consumer boundaries', async () => {
  const text = (await Promise.all(files.map(file => readFile(file, 'utf8')))).join('\n');
  assert.match(text, /shared[\\/]agent-runtime/);
  assert.match(text, /Windows[^\n]*(shim|cmd|bat)|shim[^\n]*Windows/i);
  assert.match(text, /probeCommand/);
  assert.match(text, /probeCli/);
  assert.match(text, /M8-A[^\n]*(完成|complete|shipped)/i);
  assert.match(text, /does not extract or merge EventBus|EventBus[^\n]*outside|full[^\n]*runtime[^\n]*deferred/i);
});
