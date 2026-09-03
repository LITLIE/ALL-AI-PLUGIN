import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findInPath, spawnPlan } from '../core/utils.mjs';

test('spawnPlan resolves Windows npm-style shims without selecting extensionless wrappers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awb-spawn-'));
  writeFileSync(join(dir, 'fake-agent'), 'not executable wrapper');
  writeFileSync(join(dir, 'fake-agent.cmd'), '@echo off\necho fake\n');
  const previous = process.env.PATH;
  const previousExt = process.env.PATHEXT;
  process.env.PATH = `${dir}${process.platform === 'win32' ? ';' : ':'}${previous || ''}`;
  process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  try {
    const resolved = findInPath('fake-agent');
    const plan = spawnPlan('fake-agent', ['--version']);
    if (process.platform === 'win32') {
      assert.match(resolved, /fake-agent\.cmd$/i);
      assert.equal(plan.viaShell, true);
      assert.equal(plan.file, process.env.ComSpec || 'cmd.exe');
      assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c']);
    } else {
      assert.equal(plan.viaShell, false);
      assert.equal(plan.file, 'fake-agent');
    }
  } finally {
    process.env.PATH = previous;
    process.env.PATHEXT = previousExt;
  }
});
