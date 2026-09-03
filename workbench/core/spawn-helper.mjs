// core/spawn-helper.mjs — Windows spawn 工具函数（复用 agent-crew 语义）
// ⚠️ 禁止重写此文件。npm shim ENOENT 陷阱已在此处理。
// 规则：{{prompt}} 不进 argv，shell 元字符 → stdin；.cmd/.bat 经 cmd.exe /d /s /c 路由。

import { spawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { findInPath, spawnPlan as unifiedSpawnPlan } from './utils.mjs';

const SHELL_METACHARS = /[&|<>^"`'%\n\r]/;

export function hasShellMetachars(str) {
  return SHELL_METACHARS.test(str);
}

/** Windows：将 .cmd/.bat 包装脚本路径解析为真实 node_modules 入口 */
export function resolveCommandSync(cmd) {
  if (!cmd) return null;
  return findInPath(cmd) || cmd;
}

/** 构建 spawn 参数，处理 prompt 模板与 shell 元字符 */
export function buildSpawnArgs(command, argsTemplate, prompt, opts = {}) {
  const interpolated = interpolateArgs(argsTemplate || [], prompt, opts);
  const plan = unifiedSpawnPlan(command, interpolated);

  // {{prompt}} 若含 shell 元字符且未走 shell，拒绝执行（安全）
  if (!plan.viaShell && prompt && hasShellMetachars(prompt) && !opts.stdinPrompt) {
    throw new Error(
      'PROMPT_CONTAINS_SHELL_METACHARS: prompt has shell special characters and cannot be safely passed via argv. ' +
      'Use stdin mode or quote the prompt.'
    );
  }

  return { command: plan.file, args: plan.args, shell: false, viaShell: plan.viaShell, resolved: plan.resolved };
}

function isShellCommand(cmd) {
  const ext = path.extname(cmd).toLowerCase();
  return ext === '.cmd' || ext === '.bat' || ext === '.ps1';
}

function interpolateArgs(args, prompt, opts = {}) {
  return args.map((a) => {
    if (a === '{{prompt}}') return opts.stdinPrompt ? '' : (prompt || '');
    if (typeof a === 'string' && a.includes('{{')) {
      return a.replace(/\{\{(\w+)\}\}/g, (_, k) => opts[k] || '');
    }
    return a;
  });
}

/** 异步 spawn 带 AbortController */
export function spawnAsync(command, args, opts = {}) {
  const ac = new AbortController();
  const proc = spawn(command, args, { signal: ac.signal, ...opts });

  let stdout = '';
  let stderr = '';

  proc.stdout?.on('data', (d) => { stdout += d.toString(); });
  proc.stderr?.on('data', (d) => { stderr += d.toString(); });

  return {
    proc,
    ac,
    getStdout: () => stdout,
    getStderr: () => stderr,
    // 流式 stdout（供 SSE 消费）
    stdoutStream: proc.stdout ? Readable.toWeb(proc.stdout) : null
  };
}

/** 同步 spawn（CLI 场景用，如 version probe） */
export function spawnSync(command, args, opts = {}) {
  const merged = {
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts
  };
  return nodeSpawnSync(command, args, merged);
}

/** 生成临时 prompt 文件路径（避免 shell 元字符） */
export function promptToTempFile(prompt) {
  const tmp = path.join(os.tmpdir(), `awb-prompt-${crypto.randomUUID().slice(0, 8)}.txt`);
  fs.writeFileSync(tmp, prompt, 'utf8');
  return tmp;
}
