import { createHash } from 'node:crypto';
import { access, copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_EXCLUDES = ['.git', 'node_modules', 'dist'];

function error(code, message) {
  const result = new Error(message);
  result.code = code;
  return result;
}

export function assertContained(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw error('path_outside_scope', `Path escapes root: ${candidate}`);
  }
  return resolvedCandidate;
}

function normalizeScope(scope = {}) {
  scope ||= {};
  const include = Array.isArray(scope.include) && scope.include.length ? scope.include.map(String) : ['.'];
  const exclude = [...DEFAULT_EXCLUDES, ...(Array.isArray(scope.exclude) ? scope.exclude.map(String) : [])]
    .map(value => value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, ''));
  return { include, exclude: [...new Set(exclude)] };
}

function relativeKey(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function isExcluded(relPath, excludes) {
  const normalized = relativeKey(relPath);
  return excludes.some(item => normalized === item || normalized.startsWith(`${item}/`));
}

async function copyEntry(source, destination, root, scope, relPath) {
  const normalized = relativeKey(relPath);
  if (normalized !== '.' && isExcluded(normalized, scope.exclude)) return;
  assertContained(root, source);
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw error('unsupported_symlink', `Symlinks are not supported: ${normalized}`);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source)) {
      await copyEntry(join(source, entry), join(destination, entry), root, scope, normalized === '.' ? entry : join(normalized, entry));
    }
    return;
  }
  if (!info.isFile()) return;
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

function join(...parts) {
  return path.join(...parts);
}

export async function createSandbox({ runId, targetCwd, storeRoot, scope: requestedScope } = {}) {
  if (!runId || typeof runId !== 'string') throw error('invalid_run_id', 'runId is required');
  const target = path.resolve(targetCwd || process.cwd());
  const store = path.resolve(storeRoot || path.join(process.cwd(), '.awb'));
  const scope = normalizeScope(requestedScope);
  const storeRelative = relativeKey(path.relative(target, store));
  if (storeRelative && storeRelative !== '.' && !storeRelative.startsWith('../') && !path.isAbsolute(storeRelative)) scope.exclude = [...new Set([...scope.exclude, storeRelative])];
  const workspace = path.join(store, 'runs', runId, 'workspace');
  await mkdir(workspace, { recursive: true });

  for (const include of scope.include) {
    const source = assertContained(target, path.resolve(target, include));
    const rel = relativeKey(path.relative(target, source) || '.');
    if (isExcluded(rel, scope.exclude)) continue;
    const destination = path.join(workspace, rel === '.' ? '' : rel);
    await copyEntry(source, destination, target, scope, rel);
  }
  return { workspace, targetCwd: target, scope };
}

async function walkFiles(root, current, scope, files) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    const relPath = relativeKey(path.relative(root, fullPath));
    if (isExcluded(relPath, scope.exclude)) continue;
    if (entry.isSymbolicLink()) throw error('unsupported_symlink', `Symlinks are not supported: ${relPath}`);
    if (entry.isDirectory()) await walkFiles(root, fullPath, scope, files);
    else if (entry.isFile()) files.push({ fullPath, relPath });
  }
}

export async function snapshotTree(root, { scope: requestedScope, backupDir } = {}) {
  const resolvedRoot = path.resolve(root);
  const scope = normalizeScope(requestedScope);
  const files = [];
  await walkFiles(resolvedRoot, resolvedRoot, scope, files);
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const records = [];
  for (const file of files) {
    const bytes = await readFile(file.fullPath);
    const record = { relPath: file.relPath, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    if (backupDir) {
      const backupPath = assertContained(backupDir, path.join(backupDir, file.relPath));
      await mkdir(path.dirname(backupPath), { recursive: true });
      await writeFile(backupPath, bytes);
      record.backupPath = path.relative(backupDir, backupPath).replaceAll('\\', '/');
    }
    records.push(record);
  }
  return { root: resolvedRoot, ts: Date.now(), scope, files: records };
}

export async function restoreSnapshot(snapshot, backupDir, root) {
  const resolvedRoot = path.resolve(root);
  const before = new Map((snapshot?.files || []).map(file => [relativeKey(file.relPath), file]));
  const current = await snapshotTree(resolvedRoot, { scope: snapshot?.scope });
  for (const file of current.files) {
    if (!before.has(file.relPath)) await rm(assertContained(resolvedRoot, path.join(resolvedRoot, file.relPath)), { force: true });
  }
  for (const file of before.values()) {
    const source = assertContained(backupDir, path.join(backupDir, file.backupPath || file.relPath));
    const destination = assertContained(resolvedRoot, path.join(resolvedRoot, file.relPath));
    await access(source);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  return { ok: true, restored: before.size };
}

export { DEFAULT_EXCLUDES };
export default { createSandbox, snapshotTree, restoreSnapshot, assertContained, DEFAULT_EXCLUDES };
