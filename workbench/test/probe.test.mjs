import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { probeCommand } from '../core/probe.mjs';
import { spawnPlan } from '../core/utils.mjs';

test('probeCommand reports a structured available result for a successful command', async () => {
  const result = await probeCommand({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("fixture-agent 1.2.3")'],
    healthCheck: { command: process.execPath, args: ['-e', 'process.stdout.write("fixture-agent 1.2.3")'], expect: 'fixture-agent' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'available');
  assert.equal(result.code, 0);
  assert.match(result.version, /fixture-agent/);
  assert.equal(result.error, null);
  assert.equal(typeof result.checkedAt, 'number');
});

test('probeCommand reports non-zero exit and expectation mismatch as unavailable', async () => {
  const failed = await probeCommand({ command: process.execPath, healthCheck: { command: process.execPath, args: ['-e', 'process.stderr.write("bad"); process.exit(3)'] } });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.code, 3);
  assert.match(failed.error, /exit|code/i);

  const mismatch = await probeCommand({ command: process.execPath, healthCheck: { command: process.execPath, args: ['-e', 'process.stdout.write("wrong")'], expect: 'expected' } });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.status, 'unavailable');
  assert.match(mismatch.error, /expect/i);
});

test('probeCommand handles missing commands and timeouts without hanging', async () => {
  const missing = await probeCommand({ command: 'definitely-missing-awb-command', healthCheck: { command: 'definitely-missing-awb-command' }, timeoutMs: 100 });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 'unavailable');
  assert.match(missing.error, /spawn|not found|ENOENT/i);

  const started = Date.now();
  const timeout = await probeCommand({
    command: process.execPath,
    healthCheck: { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 1000)'] },
  }, { timeoutMs: 40 });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.status, 'unavailable');
  assert.match(timeout.error, /timeout/i);
  assert.ok(Date.now() - started < 500);
});

test('probeCommand bounds diagnostic output and spawnPlan keeps Windows shim semantics', async () => {
  const result = await probeCommand({
    command: process.execPath,
    healthCheck: { command: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(20000))'] },
  }, { outputLimit: 256 });
  assert.equal(result.ok, true);
  assert.ok(result.version.length <= 256);

  const plan = spawnPlan('node', ['--version']);
  assert.equal(typeof plan.file, 'string');
  assert.equal(Array.isArray(plan.args), true);
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(plan.resolved || '')) {
    assert.equal(plan.viaShell, true);
    assert.equal(plan.file.toLowerCase().endsWith('cmd.exe'), true);
  }
});
