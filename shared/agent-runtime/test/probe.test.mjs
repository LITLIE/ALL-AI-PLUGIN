import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeCommand, normalizeProbeResult } from '../probe.mjs';

test('probeCommand returns the canonical result for a configured health command', async () => {
  const result = await probeCommand({
    command: process.execPath,
    healthCheck: { command: process.execPath, args: ['-e', 'process.stdout.write(process.env.AWB_PROBE_MARKER)'], expect: 'marker' },
    env: { AWB_PROBE_MARKER: 'marker 1.0.0' },
  });
  assert.deepEqual(Object.keys(result), ['ok', 'status', 'resolved', 'version', 'code', 'error', 'checkedAt']);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'available');
  assert.equal(result.code, 0);
  assert.match(result.version, /marker/);
  assert.equal(result.error, null);
  assert.equal(typeof result.checkedAt, 'number');
});

test('probeCommand reports non-zero, expectation mismatch, missing command, and timeout', async () => {
  const failed = await probeCommand({ command: process.execPath, healthCheck: { command: process.execPath, args: ['-e', 'process.exit(7)'] } });
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.code, 7);

  const mismatch = await probeCommand({ command: process.execPath, healthCheck: { command: process.execPath, args: ['-e', 'process.stdout.write("wrong")'], expect: 'expected' } });
  assert.equal(mismatch.status, 'unavailable');
  assert.match(mismatch.error, /expected/i);

  const missing = await probeCommand({ command: 'missing-awb-runtime-command', healthCheck: { command: 'missing-awb-runtime-command' } });
  assert.equal(missing.status, 'unavailable');
  assert.match(missing.error, /spawn|ENOENT|not found/i);

  const started = Date.now();
  const timeout = await probeCommand({ command: process.execPath, healthCheck: { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 1000)'] } }, { timeoutMs: 40 });
  assert.equal(timeout.status, 'unavailable');
  assert.match(timeout.error, /timeout/i);
  assert.ok(Date.now() - started < 500);
});

test('probeCommand bounds diagnostics and forwards cwd and environment', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'awb-probe-cwd-'));
  const result = await probeCommand({
    command: process.execPath,
    healthCheck: { command: process.execPath, args: ['-e', 'process.stdout.write(process.env.AWB_PROBE_MARKER + process.cwd() + "x".repeat(20000))'] },
    cwd,
    env: { AWB_PROBE_MARKER: 'cwd-marker' },
  }, { outputLimit: 256 });
  assert.equal(result.ok, true);
  assert.ok(result.version.length <= 256);
  assert.match(result.version, /cwd-marker/);
});

test('normalizeProbeResult upgrades legacy partial values to the canonical shape', () => {
  const result = normalizeProbeResult({ ok: true, version: 'legacy' });
  assert.deepEqual(Object.keys(result), ['ok', 'status', 'resolved', 'version', 'code', 'error', 'checkedAt']);
  assert.equal(result.status, 'available');
  assert.equal(result.code, 0);
  assert.equal(result.error, null);
});
