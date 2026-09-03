// core/registry.mjs — Agent 注册表（配置驱动，.agentbus/roles.json 格式超集）

import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAdapters } from '../adapters/index.mjs';
import { normalizeConfig, parseConfigText, validateConfig } from '../config/schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function unknownProbe() {
  return { ok: false, status: 'unknown', resolved: null, version: null, code: null, error: null, checkedAt: null };
}

function normalizeProbe(value, fallback = {}) {
  const ok = value?.ok === true;
  const status = ['available', 'unavailable', 'unknown'].includes(value?.status)
    ? value.status
    : (ok ? 'available' : 'unavailable');
  return {
    ok,
    status,
    resolved: value?.resolved ?? null,
    version: value?.version ?? null,
    code: value?.code ?? (ok ? 0 : null),
    error: value?.error ?? fallback.error ?? null,
    checkedAt: typeof value?.checkedAt === 'number' ? value.checkedAt : Date.now(),
  };
}

/**
 * Agent Registry
 * 职责：加载 agents/*.json 配置；注册/注销 agent；探测 agent 健康状态
 * 配置格式（roles.json 超集）：
 *   id: 唯一标识（用于路由）
 *   displayName: 展示名
 *   type: 适配器类型（echo / codex-app-server / claude-stream-json / human-bridge / acp / cli-text）
 *   adapterId: type 的兼容别名（不得与 type 冲突）
 *   command: 实际命令（用于 probe，null = 内置）
 *   args: string[]（启动参数模板，{{prompt}} 标记替换点）
 *   cwd: 工作目录策略（"task" | "repo-root" | string）
 *   inputProtocol: "stdin" | "args" | "jsonrpc"
 *   outputProtocol: "cli-text" | "stream-json" | "native-jsonrpc" | "acp" | "human-bridge"
 *   capabilityTags: string[]（用于能力标签选派）
 *   riskLevel: "read-only" | "workspace-write" | "high-risk"
 *   timeoutMs: number（默认 180000）
 *   maxRetries: number（默认 2）
 *   env: Record<string, string>
 *   enabled: boolean
 */
export class AgentRegistry {
  constructor(agentsDir) {
    this.agentsDir = agentsDir || join(process.cwd(), 'agents');
    this.agents = new Map(); // id -> config
    this._probed = new Map(); // id -> probe result
    this.errors = [];
    this._invalid = new Map(); // file -> { id, configError }
  }

  /** 加载所有 agents/*.json */
  load() {
    this.agents.clear();
    this._probed.clear();
    this.errors = [];
    this._invalid.clear();
    try {
      const files = readdirSync(this.agentsDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const fullPath = join(this.agentsDir, file);
        let raw;
        try {
          raw = parseConfigText(readFileSync(fullPath, 'utf8'), fullPath);
          const config = normalizeConfig(raw, fullPath);
          const result = validateConfig(config, fullPath);
          if (!result.ok) {
            this.errors.push(...result.errors);
            this._invalid.set(file, { id: typeof raw?.id === 'string' ? raw.id : file.replace(/\.json$/i, ''), configError: result.errors });
            continue;
          }
          this.agents.set(config.id, config);
        } catch (error) {
          const item = { code: error.code || 'invalid_config', file: fullPath, field: error.field || null, message: error.message };
          this.errors.push(item);
          this._invalid.set(file, { id: typeof raw?.id === 'string' ? raw.id : file.replace(/\.json$/i, ''), configError: [item] });
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[registry] load error:', err.message);
    }
  }

  /** 探测单个 agent 是否可用 */
  async probe(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return { ok: false, error: 'Agent not found' };

    const { loadAdapter } = await import('../adapters/index.mjs');
    const adapter = await loadAdapter(agent);
    if (!adapter) return { ok: false, error: `No adapter for ${agentId}` };

    try {
      const result = normalizeProbe(await adapter.probe?.(agent));
      this._probed.set(agentId, result);
      return result;
    } catch (err) {
      const probeResult = normalizeProbe(null, { error: err.message });
      this._probed.set(agentId, probeResult);
      return probeResult;
    }
  }

  /** 探测所有 agent */
  async probeAll() {
    const results = {};
    for (const [id] of this.agents) {
      try {
        const result = await this.probe(id);
        this._probed.set(id, result);
        results[id] = result;
      } catch (err) {
        const probeResult = { ok: false, error: err.message };
        this._probed.set(id, probeResult);
        results[id] = probeResult;
      }
    }
    return results;
  }

  /** 按 capabilityTags 过滤可用 agent */
  findByCapability(requiredTags) {
    const available = [];
    const adapterTypes = new Set(listAdapters());
    for (const [id, agent] of this.agents) {
      if (!agent.enabled) continue;
      if (!agent.type) continue;
      if (!adapterTypes.has(agent.type)) continue;
      const probe = this._probed.get(id);
      if (probe?.ok !== true) continue; // 未探测或不健康的排除
      const tags = agent.capabilityTags || [];
      const hasAll = requiredTags.every(t => tags.includes(t));
      if (hasAll) available.push({ id, ...agent, probe: this._probed.get(id) });
    }
    return available;
  }

  /** 获取所有 agent（含状态） */
  listAll() {
    const valid = Array.from(this.agents.entries()).map(([id, cfg]) => ({
      id,
      ...cfg,
      probe: this._probed.get(id) || unknownProbe(),
      available: (cfg.enabled === true && this._probed.get(id)?.ok === true),
    }));
    const invalid = Array.from(this._invalid.values()).map(({ id, configError }) => ({ id, enabled: false, available: false, configError }));
    return [...valid, ...invalid];
  }

  /** 添加 / 更新 agent（热重载） */
  upsert(config) {
    const result = validateConfig(config, '<memory>');
    if (!result.ok) {
      const error = new Error('Invalid agent config');
      error.code = 'invalid_config';
      error.errors = result.errors;
      throw error;
    }
    const normalized = result.config;
    this.agents.set(normalized.id, normalized);
    this._probed.delete(normalized.id); // 下次 probe 刷新
  }

  /**
   * 持久化导入一个经过校验的 Agent 配置草稿。
   * 导入本身不探测 Agent；重新 load 后状态保持 unknown，直到显式 probe。
   */
  importConfig(config, fileName = undefined) {
    const result = validateConfig(config, '<import>');
    if (!result.ok) {
      const error = new Error('Invalid agent config');
      error.code = 'invalid_config';
      error.errors = result.errors;
      throw error;
    }

    const normalized = result.config;
    if (this.agents.has(normalized.id)) {
      const error = new Error(`Duplicate agent id: ${normalized.id}`);
      error.code = 'duplicate_agent_id';
      throw error;
    }

    const targetName = fileName === undefined ? `${normalized.id}.json` : String(fileName);
    if (!targetName || basename(targetName) !== targetName || extname(targetName) !== '.json') {
      const error = new Error('Import filename must be a single .json basename');
      error.code = 'invalid_filename';
      throw error;
    }

    mkdirSync(this.agentsDir, { recursive: true });
    const targetPath = join(this.agentsDir, targetName);
    if (existsSync(targetPath)) {
      const error = new Error(`Agent config file already exists: ${targetName}`);
      error.code = 'config_exists';
      throw error;
    }

    const tempName = `.${targetName}.${process.pid}.${Date.now()}.tmp`;
    const tempPath = join(this.agentsDir, tempName);
    const previousState = {
      agents: new Map(this.agents),
      probed: new Map(this._probed),
      errors: this.errors,
      invalid: new Map(this._invalid),
    };
    let renamed = false;
    try {
      // Keep the submitted draft shape on disk; load() applies schema defaults.
      writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      renameSync(tempPath, targetPath);
      renamed = true;
      this.load();
      const imported = this.listAll().find(agent => agent.id === normalized.id);
      if (!imported) throw new Error(`Imported agent was not loaded: ${normalized.id}`);
      return imported;
    } catch (error) {
      if (existsSync(tempPath)) {
        try { unlinkSync(tempPath); } catch { /* best effort cleanup */ }
      }
      if (renamed && existsSync(targetPath)) {
        try { unlinkSync(targetPath); } catch { /* best effort cleanup */ }
      }
      this.agents = previousState.agents;
      this._probed = previousState.probed;
      this.errors = previousState.errors;
      this._invalid = previousState.invalid;
      throw error;
    }
  }

  /** 禁用 agent */
  disable(agentId) {
    const agent = this.agents.get(agentId);
    if (agent) { agent.enabled = false; this._probed.delete(agentId); }
  }
}

export default AgentRegistry;
