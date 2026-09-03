import { readFile } from 'node:fs/promises';
import path from 'node:path';

function byPath(a, b) { return a.relPath.localeCompare(b.relPath); }

export function classifyChanges(before, after) {
  const beforeMap = new Map((before?.files || []).map(file => [file.relPath, file]));
  const afterMap = new Map((after?.files || []).map(file => [file.relPath, file]));
  const added = [];
  const modified = [];
  const deleted = [];
  for (const [relPath, file] of afterMap) {
    if (!beforeMap.has(relPath)) added.push({ relPath, after: file });
    else if (beforeMap.get(relPath).sha256 !== file.sha256) modified.push({ relPath, before: beforeMap.get(relPath), after: file });
  }
  for (const [relPath, file] of beforeMap) {
    if (!afterMap.has(relPath)) deleted.push({ relPath, before: file });
  }
  added.sort(byPath); modified.sort(byPath); deleted.sort(byPath);
  return { added, modified, deleted };
}

function lines(text) {
  const normalized = String(text).replaceAll('\r\n', '\n');
  const result = normalized.split('\n');
  if (result.at(-1) === '') result.pop();
  return result;
}

export function buildUnifiedDiff(beforeText, afterText, relPath) {
  const before = lines(beforeText);
  const after = lines(afterText);
  const rows = Array.from({ length: before.length + 1 }, () => Array(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) rows[i][j] = before[i] === after[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
  }
  const output = [`--- a/${relPath}`, `+++ b/${relPath}`, `@@ -1,${before.length} +1,${after.length} @@`];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) { output.push(` ${before[i]}`); i += 1; j += 1; continue; }
    if (i < before.length && (j >= after.length || rows[i + 1][j] >= rows[i][j + 1])) { output.push(`-${before[i]}`); i += 1; continue; }
    if (j < after.length) { output.push(`+${after[j]}`); j += 1; }
  }
  return `${output.join('\n')}\n`;
}

function isText(bytes) {
  if (bytes.includes(0)) return false;
  const decoded = bytes.toString('utf8');
  return !decoded.includes('\ufffd');
}

async function contentFor(root, file) {
  return readFile(path.join(root, file.backupPath || file.relPath));
}

async function enrich(item, beforeRoot, afterRoot, beforeSide, afterSide) {
  const beforeFile = item.before;
  const afterFile = item.after;
  const result = { relPath: item.relPath };
  if (beforeFile) result.before = beforeFile;
  if (afterFile) result.after = afterFile;
  const beforeBytes = beforeFile ? await contentFor(beforeRoot, beforeFile) : Buffer.alloc(0);
  const afterBytes = afterFile ? await contentFor(afterRoot, afterFile) : Buffer.alloc(0);
  const text = isText(beforeBytes) && isText(afterBytes);
  result.binary = !text;
  if (text) result.unifiedDiff = buildUnifiedDiff(beforeBytes.toString('utf8'), afterBytes.toString('utf8'), item.relPath);
  return result;
}

export async function buildDiff(beforeSnapshot, afterSnapshot, beforeBackupDir, afterRoot) {
  const changes = classifyChanges(beforeSnapshot, afterSnapshot);
  const beforeRoot = beforeBackupDir || beforeSnapshot?.root;
  const diff = { added: [], modified: [], deleted: [] };
  for (const item of changes.added) diff.added.push(await enrich(item, beforeRoot, afterRoot, beforeSnapshot, afterSnapshot));
  for (const item of changes.modified) diff.modified.push(await enrich(item, beforeRoot, afterRoot, beforeSnapshot, afterSnapshot));
  for (const item of changes.deleted) diff.deleted.push(await enrich(item, beforeRoot, afterRoot, beforeSnapshot, afterSnapshot));
  return diff;
}

export default { classifyChanges, buildUnifiedDiff, buildDiff };
