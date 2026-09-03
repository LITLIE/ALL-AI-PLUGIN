import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('M7-A documentation exposes Human Bridge state and endpoint', async () => {
  const [spec, architecture, readme] = await Promise.all([
    readFile(new URL('../docs/SPEC.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/ARCHITECTURE.md', import.meta.url), 'utf8'),
    readFile(new URL('../../README.md', import.meta.url), 'utf8'),
  ]);
  for (const text of [spec, architecture, readme]) {
    assert.match(text, /awaiting-human/);
    assert.match(text, /api\/bridges\/:runId\/submit/);
  }
});

