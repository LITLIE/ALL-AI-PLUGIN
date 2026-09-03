import test from 'node:test';
import assert from 'node:assert/strict';
import claude from '../adapters/claude-stream-json.mjs';
import codex from '../adapters/codex-app-server.mjs';
import cliText from '../adapters/cli-text.mjs';
import acp from '../adapters/acp.mjs';

test('process-backed adapters expose a cooperative-safe terminate contract', async () => {
  for (const adapter of [claude, codex, cliText, acp]) {
    assert.equal(typeof adapter.terminate, 'function', `${adapter.id} missing terminate()`);
    const result = await adapter.terminate({ runId: 'run-not-active', reason: 'test' });
    assert.equal(result.ok, true, `${adapter.id} terminate should be safe when inactive`);
    assert.ok(['cooperative', 'process-tree'].includes(result.termination), `${adapter.id} termination mode missing`);
  }
});
