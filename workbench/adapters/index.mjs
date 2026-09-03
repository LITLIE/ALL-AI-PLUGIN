// adapters/index.mjs — 适配器加载器（配置驱动 + 可插拔解析器层）

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 已知适配器映射表（key = agent type） */
const ADAPTERS = {
  'echo': () => import('./echo.mjs'),
  'codex-app-server': () => import('./codex-app-server.mjs'),
  'claude-stream-json': () => import('./claude-stream-json.mjs'),
  'human-bridge': () => import('./human-bridge.mjs'),
  'acp': () => import('./acp.mjs'),
  'cli-text': () => import('./cli-text.mjs'),
};

/** 加载指定 adapter（延迟 import，按 type 缓存） */
const _cache = new Map();
export async function loadAdapter(agentConfig) {
  if (typeof agentConfig !== 'string' && agentConfig?.adapterInstance) return agentConfig.adapterInstance;
  const adapterType = typeof agentConfig === 'string' ? agentConfig : agentConfig?.type;
  if (!adapterType) return null;
  if (_cache.has(adapterType)) return _cache.get(adapterType);

  const factory = ADAPTERS[adapterType];
  if (!factory) return null;

  const mod = await factory();
  const instance = mod.default || mod;
  _cache.set(adapterType, instance);
  return instance;
}

/** 检查是否有适配器 */
export function hasAdapter(agentId) {
  return agentId in ADAPTERS;
}

/** 列出所有已知适配器 ID */
export function listAdapters() {
  return Object.keys(ADAPTERS);
}

export default { loadAdapter, hasAdapter, listAdapters };
