import { probeCommand } from './probe.mjs';

export const DEFAULT_CATALOG = Object.freeze([
  { id: 'claude', displayName: 'Claude Code', command: 'claude', adapter: 'claude-stream-json', args: ['--version'], capabilities: ['read', 'write', 'analyze', 'test'] },
  { id: 'codex', displayName: 'Codex CLI', command: 'codex', adapter: 'codex-app-server', args: ['--version'], capabilities: ['read', 'write', 'analyze', 'test'] },
  { id: 'gemini', displayName: 'Gemini CLI', command: 'gemini', adapter: 'cli-text', args: ['--version'], capabilities: ['read', 'analyze'] },
  { id: 'opencode', displayName: 'OpenCode', command: 'opencode', adapter: 'cli-text', args: ['--version'], capabilities: ['read', 'write', 'analyze'] },
  { id: 'copilot', displayName: 'GitHub Copilot CLI', command: 'copilot', adapter: 'cli-text', args: ['--version'], capabilities: ['read', 'analyze'] },
]);

const GUI_CATALOG = Object.freeze([
  { id: 'trae', displayName: 'Trae', adapter: 'human-bridge', capabilities: ['read', 'write', 'analyze'] },
  { id: 'workbuddy', displayName: 'WorkBuddy', adapter: 'human-bridge', capabilities: ['read', 'write', 'analyze'] },
]);

function outputProtocol(adapter) {
  return adapter === 'codex-app-server' ? 'native-jsonrpc' : adapter === 'claude-stream-json' ? 'stream-json' : adapter;
}

function normalizedId(value) {
  return String(value || 'agent').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
}

export function buildConfigDraft(candidate = {}, overrides = {}) {
  const adapter = candidate.adapter || candidate.type || 'cli-text';
  const draft = {
    id: normalizedId(candidate.id || candidate.name),
    displayName: candidate.displayName || candidate.name || candidate.id || 'Discovered Agent',
    type: adapter,
    outputProtocol: candidate.outputProtocol || outputProtocol(adapter),
    riskLevel: candidate.riskLevel || 'read-only',
    capabilityTags: candidate.capabilityTags || candidate.capabilities || ['read'],
    enabled: true,
  };
  if (candidate.command) draft.command = candidate.command;
  if (Array.isArray(candidate.args)) draft.args = candidate.args.map(String);
  if (candidate.env && typeof candidate.env === 'object') draft.env = candidate.env;
  if (candidate.cwd) draft.cwd = candidate.cwd;
  if (candidate.healthCheck) draft.healthCheck = candidate.healthCheck;
  return { ...draft, ...overrides };
}

function candidateFromProbe(item, probe, source = 'path') {
  const configDraft = buildConfigDraft(item);
  return {
    id: configDraft.id,
    displayName: configDraft.displayName,
    source,
    command: item.command || null,
    resolved: probe.resolved,
    status: probe.status,
    version: probe.version,
    confidence: source === 'manifest' ? 'high' : 'high',
    configDraft,
  };
}

async function discoverExecutable(item, source, probeOptions) {
  if (!item.command) return null;
  const healthCheck = item.healthCheck || { command: item.command, args: item.args || ['--version'], expect: item.expect };
  const probe = await probeCommand({ ...item, healthCheck }, probeOptions);
  if (probe.ok !== true) return null;
  return candidateFromProbe(item, probe, source);
}

/** Discover installed CLI candidates and advisory GUI-only drafts. */
export async function discoverAgents(options = {}) {
  const catalog = Array.isArray(options.catalog) ? options.catalog : DEFAULT_CATALOG;
  const allowed = options.commands ? new Set(options.commands) : null;
  const candidates = [];
  for (const item of catalog) {
    if (allowed && !allowed.has(item.id) && !allowed.has(item.command)) continue;
    const candidate = await discoverExecutable(item, 'path', options.probeOptions || {});
    if (candidate) candidates.push(candidate);
  }
  for (const manifest of options.manifests || []) {
    if (manifest.adapter === 'human-bridge' || manifest.type === 'human-bridge') {
      candidates.push({
        id: normalizedId(manifest.id || manifest.name),
        displayName: manifest.displayName || manifest.name || manifest.id,
        source: 'manifest', command: null, resolved: null, status: 'available', version: null, confidence: 'advisory',
        configDraft: buildConfigDraft({ ...manifest, adapter: 'human-bridge' }),
      });
    } else {
      const candidate = await discoverExecutable(manifest, 'manifest', options.probeOptions || {});
      if (candidate) candidates.push(candidate);
    }
  }
  if (options.includeGui !== false) {
    for (const item of GUI_CATALOG) {
      candidates.push({
        id: item.id,
        displayName: item.displayName,
        source: 'known-gui', command: null, resolved: null, status: 'available', version: null, confidence: 'advisory',
        configDraft: buildConfigDraft(item),
      });
    }
  }
  return { candidates };
}

export default { DEFAULT_CATALOG, discoverAgents, buildConfigDraft };
