// core/paths.mjs — 路径工厂（单点，所有路径在此定义）
// 允许通过 env 覆盖，便于测试与不同工作目录场景。

import path from 'node:path';
import os from 'node:os';

function env(key, fallback) {
  return process.env[key] || fallback;
}

/** 工作台根目录（默认：$PWD/.agentworkbench 或 HOME/.agentworkbench） */
export function rootDir() {
  return env('AWB_ROOT', path.join(process.cwd(), '.agentworkbench'));
}

/** 持久化存储目录 */
export function storeDir() {
  return env('AWB_STORE', path.join(rootDir(), '.awb-store'));
}

/** 事件总线文件 */
export function busFile() {
  return env('AWB_BUS', path.join(storeDir(), 'bus.jsonl'));
}

/** 任务/Run 状态快照 */
export function stateFile() {
  return env('AWB_STATE', path.join(storeDir(), 'state.json'));
}

/** Agent 配置目录（用户放 agents/*.json 的地方） */
export function agentsDir() {
  return env('AWB_AGENTS_DIR', path.join(rootDir(), 'agents'));
}

/** 每个 Run 的隔离工作目录 */
export function runWorkDir(runId) {
  return env('AWB_RUNS', path.join(storeDir(), 'runs', runId));
}

/** 每个 Run 执行前快照 */
export function snapshotFile(runId) {
  return path.join(runWorkDir(runId), '.snapshot-before.json');
}

/** 每个 Run 的 diff 输出 */
export function diffFile(runId) {
  return path.join(runWorkDir(runId), 'diff.json');
}

/** 每个 Run 的 stdout/stderr */
export function outputFile(runId) {
  return path.join(runWorkDir(runId), 'output.txt');
}

/** 临时 prompt 文件 */
export function promptTempFile(runId) {
  return path.join(runWorkDir(runId), 'prompt.txt');
}

/** SSE 事件缓存（用于断线重连补发） */
export function sseCacheFile() {
  return path.join(storeDir(), 'sse-cache.jsonl');
}
