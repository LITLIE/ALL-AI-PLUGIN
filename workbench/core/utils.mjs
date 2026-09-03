// core/utils.mjs — Windows spawn 工具函数（复用 agent-crew 的 spawnPlan 语义）

import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { resolveExecutable as sharedResolveExecutable, spawnPlan as sharedSpawnPlan } from '../../shared/agent-runtime/resolve.mjs';

export const findInPath = sharedResolveExecutable;
export const spawnPlan = sharedSpawnPlan;

/**
 * quoteArg — 将参数包裹引号（Windows 安全）
 */
export function quoteArg(arg) {
  if (!arg || arg === '') return '""';
  // 双引号转义
  const escaped = arg.replace(/"/g, '""');
  // 如果包含空格或特殊字符，需要引号包裹
  if (escaped.match(/[\s&|<>^"]/) || arg !== arg.trim()) {
    return `"${escaped}"`;
  }
  return arg;
}

/**
 * killProcessTree — Windows 上可靠杀进程树
 * 策略：taskkill /T /F（杀进程 + 所有子进程）
 * 注意：npm shim 的进程树通常为 cmd.exe → shim.cmd → node → codex.js
 */
export function killProcessTree(pid, signal = 'SIGTERM') {
  if (process.platform !== 'win32') {
    return process.kill(pid, signal);
  }

  // taskkill /T = 包含子进程，/F = 强制
  return new Promise((resolve, reject) => {
    const proc = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true });
    proc.on('close', code => resolve(code === 0));
    proc.on('error', reject);
  });
}

/**
 * sanitizeForShell — 拒绝含 shell 元字符的 {{prompt}} 进 argv
 */
export function sanitizeForShell(prompt) {
  const SHELL_METACHARS = /[&|<>^"`%$()!]/;
  if (SHELL_METACHARS.test(prompt)) {
    return { safe: false, reason: 'prompt contains shell metacharacters, use stdin instead' };
  }
  return { safe: true };
}

/**
 * diffSnapshots — 比对两个快照，返回变更文件列表
 * snapshot = { files: [{ path, hash, size }] }
 * 返回: { added: [], modified: [], deleted: [] }
 */
export function diffSnapshots(before, after) {
  const beforeMap = new Map((before?.files || []).map(f => [f.path, f]));
  const afterMap = new Map((after?.files || []).map(f => [f.path, f]));

  const added = [];
  const modified = [];
  const deleted = [];

  for (const [path, file] of afterMap) {
    if (!beforeMap.has(path)) added.push(file);
    else if (file.hash !== beforeMap.get(path).hash) modified.push(file);
  }
  for (const [path] of beforeMap) {
    if (!afterMap.has(path)) deleted.push({ path });
  }

  return { added, modified, deleted };
}

/**
 * makeSnapshot — 对目录做快照（路径 + SHA-256 哈希）
 */
export async function makeSnapshot(dir) {
  const files = [];

  function walk(d) {
    try {
      const entries = readdirSync(d, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          const stat = statSync(full);
          const hash = createHash('sha256').update(createReadStream(full)).digest('hex');
          files.push({ path: full, hash, size: stat.size, mtime: stat.mtime });
        }
      }
    } catch { /* skip inaccessible */ }
  }

  walk(dir);
  return { dir, ts: Date.now(), files };
}

export default { spawnPlan, quoteArg, killProcessTree, sanitizeForShell, diffSnapshots, makeSnapshot };
