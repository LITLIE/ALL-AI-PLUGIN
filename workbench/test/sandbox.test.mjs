import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandbox, snapshotTree, restoreSnapshot } from '../core/sandbox.mjs';

async function tempPair() {
  const root = await mkdtemp(join(tmpdir(), 'awb-sandbox-'));
  const target = join(root, 'target');
  const store = join(root, 'store');
  await mkdir(target, { recursive: true });
  await mkdir(store, { recursive: true });
  return { root, target, store };
}

test('sandbox copies scoped files and excludes generated directories', async () => {
  const { target, store } = await tempPair();
  await mkdir(join(target, 'src'), { recursive: true });
  await mkdir(join(target, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(join(target, '.git'), { recursive: true });
  await writeFile(join(target, 'src', 'main.txt'), 'before');
  await writeFile(join(target, 'node_modules', 'pkg', 'index.js'), 'ignored');
  const result = await createSandbox({ runId: 'run-1', targetCwd: target, storeRoot: store });
  assert.equal(await readFile(join(result.workspace, 'src', 'main.txt'), 'utf8'), 'before');
  await assert.rejects(() => access(join(result.workspace, 'node_modules', 'pkg', 'index.js')));
  await assert.rejects(() => access(join(result.workspace, '.git')));
});

test('sandbox honors include and exclude relative paths', async () => {
  const { target, store } = await tempPair();
  await mkdir(join(target, 'src'), { recursive: true });
  await mkdir(join(target, 'docs'), { recursive: true });
  await writeFile(join(target, 'src', 'main.txt'), 'main');
  await writeFile(join(target, 'src', 'secret.txt'), 'secret');
  await writeFile(join(target, 'docs', 'readme.md'), 'docs');
  const result = await createSandbox({ runId: 'run-2', targetCwd: target, storeRoot: store, scope: { include: ['src'], exclude: ['src/secret.txt'] } });
  assert.equal(await readFile(join(result.workspace, 'src', 'main.txt'), 'utf8'), 'main');
  await assert.rejects(() => access(join(result.workspace, 'src', 'secret.txt')));
  await assert.rejects(() => access(join(result.workspace, 'docs')));
});

test('sandbox rejects scope paths outside target root', async () => {
  const { target, store } = await tempPair();
  await assert.rejects(() => createSandbox({ runId: 'run-3', targetCwd: target, storeRoot: store, scope: { include: ['..'] } }), error => error.code === 'path_outside_scope');
});

test('snapshot stores hashes and original content, then restore removes added files', async () => {
  const { target, store } = await tempPair();
  await mkdir(join(target, 'src'), { recursive: true });
  await writeFile(join(target, 'src', 'main.txt'), 'before');
  const before = await snapshotTree(target, { backupDir: join(store, 'before') });
  assert.equal(before.files[0].relPath, 'src/main.txt');
  assert.equal(before.files[0].size, 6);
  await writeFile(join(target, 'src', 'main.txt'), 'changed');
  await writeFile(join(target, 'new.txt'), 'new');
  await restoreSnapshot(before, join(store, 'before'), target);
  assert.equal(await readFile(join(target, 'src', 'main.txt'), 'utf8'), 'before');
  await assert.rejects(() => access(join(target, 'new.txt')));
});
