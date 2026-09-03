import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveExecutable, spawnPlan } from '../resolve.mjs';
import { hasShellMetachars, substituteArgs } from '../templates.mjs';

let fixtureDir;

test.before(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'awb-runtime-'));
  await mkdir(join(fixtureDir, 'bin'));
  await writeFile(join(fixtureDir, 'bin', 'fixture'), 'fixture');
  await writeFile(join(fixtureDir, 'bin', 'fixture.EXE'), 'fixture');
  await writeFile(join(fixtureDir, 'bin', 'shim.CMD'), '@echo off');
});

test('resolves explicit executable paths and bare commands from an injected PATH', () => {
  assert.equal(resolveExecutable(join(fixtureDir, 'bin', 'fixture'), { platform: 'linux' }), join(fixtureDir, 'bin', 'fixture'));
  assert.equal(resolveExecutable('fixture', { platform: 'win32', pathValue: join(fixtureDir, 'bin'), pathext: '.COM;.EXE;.BAT;.CMD' }).toLowerCase(), join(fixtureDir, 'bin', 'fixture.exe').toLowerCase());
});

test('routes Windows cmd shims through cmd.exe without enabling a shell', () => {
  const plan = spawnPlan('shim', ['--version'], {
    platform: 'win32',
    pathValue: join(fixtureDir, 'bin'),
    pathext: '.COM;.EXE;.BAT;.CMD',
    comSpec: 'C:\\Windows\\System32\\cmd.exe',
  });
  assert.equal(plan.viaShell, true);
  assert.equal(plan.shell, false);
  assert.equal(plan.shimmed, true);
  assert.equal(plan.file.toLowerCase().endsWith('cmd.exe'), true);
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(plan.resolved.toLowerCase().endsWith('shim.cmd'), true);
});

test('substitutes known variables and preserves unknown placeholders', () => {
  assert.deepEqual(
    substituteArgs(['-C', '{{project}}', '{{prompt}}', '{{unknown}}'], { project: 'D:\\repo', prompt: 'hello' }),
    ['-C', 'D:\\repo', 'hello', '{{unknown}}'],
  );
  assert.equal(hasShellMetachars('safe text'), false);
  assert.equal(hasShellMetachars('unsafe & text'), true);
});
