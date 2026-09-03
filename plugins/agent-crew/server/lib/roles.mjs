// Hybrid role registry: a role is an addressable name on the bus, and its
// `backend` decides who actually answers — a Claude subagent, an external CLI,
// or the driving session itself. Callers only ever talk to role ids.
import fs from 'node:fs';
import { paths, ensureBus, readJson, writeJson } from './paths.mjs';

export const BACKENDS = { SELF: 'self', SUBAGENT: 'claude-subagent', CLI: 'cli', HUMAN: 'human' };

export const DEFAULT_ROLES = {
  version: 1,
  roles: [
    {
      id: 'orchestrator',
      name: 'Orchestrator',
      title: '主控 / 协调者',
      specialty: '拆解目标、派活、汇总结论、维护线程节奏',
      backend: { type: BACKENDS.SELF },
    },
    {
      id: 'trae',
      name: 'Trae',
      title: '架构与方案设计',
      specialty: '系统边界、数据流、技术选型、权衡取舍',
      backend: { type: BACKENDS.SUBAGENT, agent: 'agent-crew:trae' },
    },
    {
      id: 'workbuddy',
      name: 'Workbuddy',
      title: '落地实现',
      specialty: '把方案变成可运行代码、补测试、修构建',
      backend: { type: BACKENDS.SUBAGENT, agent: 'agent-crew:workbuddy' },
    },
    {
      id: 'critic',
      name: 'Critic',
      title: '质疑者 / 反方',
      specialty: '找隐含假设、失败场景、被忽略的成本',
      backend: { type: BACKENDS.SUBAGENT, agent: 'agent-crew:critic' },
    },
    {
      id: 'codex',
      name: 'Codex',
      title: '外部独立评审 (OpenAI Codex CLI)',
      specialty: '换一个模型家族看同一份代码，交叉验证',
      backend: {
        type: BACKENDS.CLI,
        command: 'codex',
        args: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', '{{project}}', '-'],
        stdinPrompt: true,
        timeoutMs: 900000,
      },
    },
    {
      id: 'human',
      name: 'You',
      title: '人类决策者',
      specialty: '最终拍板、提供业务上下文、批准有风险的动作',
      backend: { type: BACKENDS.HUMAN },
    },
  ],
};

export function loadRegistry() {
  const p = ensureBus();
  if (!fs.existsSync(p.roles)) writeJson(p.roles, DEFAULT_ROLES);
  const reg = readJson(p.roles, DEFAULT_ROLES);
  if (!Array.isArray(reg.roles)) return DEFAULT_ROLES;
  return reg;
}

export function saveRegistry(reg) {
  writeJson(paths().roles, reg);
  return reg;
}

export function listRoles() {
  return loadRegistry().roles;
}

export function roleIds() {
  return listRoles().map((r) => r.id);
}

// Accept id, name or a case-insensitive prefix so "@work" resolves to workbuddy.
export function resolveRole(needle) {
  if (!needle) return null;
  const key = String(needle).trim().replace(/^@/, '').toLowerCase();
  const roles = listRoles();
  return (
    roles.find((r) => r.id.toLowerCase() === key) ||
    roles.find((r) => (r.name || '').toLowerCase() === key) ||
    roles.find((r) => r.id.toLowerCase().startsWith(key)) ||
    null
  );
}

export function upsertRole(role) {
  if (!role?.id || !/^[a-z0-9][a-z0-9_-]*$/.test(role.id)) {
    throw new Error(`invalid role id: ${role?.id} (use kebab/snake lowercase)`);
  }
  const reg = loadRegistry();
  const idx = reg.roles.findIndex((r) => r.id === role.id);
  if (idx >= 0) reg.roles[idx] = { ...reg.roles[idx], ...role };
  else reg.roles.push({ backend: { type: BACKENDS.SUBAGENT }, ...role });
  return saveRegistry(reg);
}

export function removeRole(id) {
  const reg = loadRegistry();
  reg.roles = reg.roles.filter((r) => r.id !== id);
  return saveRegistry(reg);
}

export function describeRole(r) {
  const backend =
    r.backend?.type === BACKENDS.CLI
      ? `cli:${r.backend.command}`
      : r.backend?.type === BACKENDS.SUBAGENT
        ? `subagent:${r.backend.agent || '(unbound)'}`
        : r.backend?.type || 'unknown';
  return `${r.id} — ${r.name || r.id} · ${r.title || ''} [${backend}]`;
}
