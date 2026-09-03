import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotTree } from '../core/sandbox.mjs';
import { buildDiff, buildUnifiedDiff, classifyChanges } from '../core/diff.mjs';

test('classifyChanges detects added, modified, deleted, and empty files', () => {
  const before = { files: [{ relPath: 'a.txt', sha256: 'a' }, { relPath: 'gone.txt', sha256: 'g' }] };
  const after = { files: [{ relPath: 'a.txt', sha256: 'b' }, { relPath: 'new.txt', sha256: 'n' }] };
  const diff = classifyChanges(before, after);
  assert.deepEqual(diff.added.map(file => file.relPath), ['new.txt']);
  assert.deepEqual(diff.modified.map(file => file.relPath), ['a.txt']);
  assert.deepEqual(diff.deleted.map(file => file.relPath), ['gone.txt']);
  assert.deepEqual(classifyChanges(before, before), { added: [], modified: [], deleted: [] });
});

test('buildUnifiedDiff emits deterministic text additions and deletions', () => {
  const diff = buildUnifiedDiff('one\ntwo\n', 'one\nthree\n', 'src/main.txt');
  assert.match(diff, /--- a\/src\/main\.txt/);
  assert.match(diff, /\+\+\+ b\/src\/main\.txt/);
  assert.match(diff, /-two/);
  assert.match(diff, /\+three/);
});

test('buildDiff includes text changes and marks binary changes without decoding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awb-diff-'));
  const beforeDir = join(root, 'before');
  const afterRoot = join(root, 'after');
  await mkdir(join(afterRoot, 'src'), { recursive: true });
  await mkdir(beforeDir, { recursive: true });
  await writeFile(join(beforeDir, 'text.txt'), 'old\n');
  await writeFile(join(afterRoot, 'text.txt'), 'new\n');
  await writeFile(join(beforeDir, 'gone.txt'), 'gone');
  await writeFile(join(afterRoot, 'added.txt'), 'added');
  await writeFile(join(beforeDir, 'image.bin'), Buffer.from([0, 1, 2]));
  await writeFile(join(afterRoot, 'image.bin'), Buffer.from([0, 1, 3]));
  const before = await snapshotTree(beforeDir);
  const after = await snapshotTree(afterRoot);
  const diff = await buildDiff(before, after, beforeDir, afterRoot);
  assert.equal(diff.modified.find(file => file.relPath === 'text.txt').binary, false);
  assert.match(diff.modified.find(file => file.relPath === 'text.txt').unifiedDiff, /\+new/);
  assert.equal(diff.modified.find(file => file.relPath === 'image.bin').binary, true);
  assert.equal(diff.added[0].relPath, 'added.txt');
  assert.equal(diff.deleted[0].relPath, 'gone.txt');
});
