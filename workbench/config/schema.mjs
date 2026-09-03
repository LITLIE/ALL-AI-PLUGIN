import { readFileSync } from 'node:fs';
import { listAdapters } from '../adapters/index.mjs';

const vocabulary = JSON.parse(readFileSync(new URL('./capabilities.json', import.meta.url), 'utf8'));

export const RISK_LEVELS = Object.freeze(['read-only', 'workspace-write', 'high-risk']);
export const CAPABILITY_TAGS = new Set(vocabulary.tags);

function configError(code, file, field, message) {
  const error = new Error(message);
  error.code = code;
  error.file = file;
  error.field = field || null;
  return error;
}

/** Remove only full-line // comments, preserving URL/path contents. */
export function stripFullLineComments(source) {
  let output = '';
  let quoted = false;
  let escaped = false;
  let lineStart = true;
  let onlyWhitespace = true;
  let skippingComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (skippingComment) {
      if (char === '\n') {
        skippingComment = false;
        lineStart = true;
        onlyWhitespace = true;
        output += char;
      }
      continue;
    }

    if (!quoted && lineStart && onlyWhitespace && char === '/' && next === '/') {
      skippingComment = true;
      index += 1;
      continue;
    }

    output += char;
    if (char === '\n') {
      lineStart = true;
      onlyWhitespace = true;
      escaped = false;
      continue;
    }

    if (!quoted && (char === ' ' || char === '\t' || char === '\r')) {
      lineStart = true;
      continue;
    }

    lineStart = false;
    onlyWhitespace = false;
    if (char === '"' && !escaped) quoted = !quoted;
    escaped = quoted && char === '\\' && !escaped;
    if (char !== '\\') escaped = false;
  }

  return output;
}

export function parseConfigText(source, file = '<config>') {
  try {
    return JSON.parse(stripFullLineComments(String(source)));
  } catch (error) {
    if (error.code === 'invalid_json') throw error;
    throw configError('invalid_json', file, null, `Invalid JSON in ${file}: ${error.message}`);
  }
}

export function normalizeConfig(raw, file = '<config>') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw configError('invalid_config', file, null, `Agent config in ${file} must be an object`);
  }
  const config = { ...raw };
  if (!config.type && config.adapterId) config.type = config.adapterId;
  if (!Object.hasOwn(config, 'enabled')) config.enabled = true;
  return config;
}

export function validateConfig(raw, file = '<config>') {
  let config;
  try {
    config = normalizeConfig(raw, file);
  } catch (error) {
    return { ok: false, errors: [{ code: error.code, file: error.file, field: error.field, message: error.message }] };
  }

  const errors = [];
  const add = (code, field, message) => errors.push({ code, file, field, message });

  if (config.type && config.adapterId && config.type !== config.adapterId) {
    add('conflicting_adapter_type', 'type', `Agent config cannot set type=${config.type} and adapterId=${config.adapterId}`);
  }
  if (typeof config.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.id)) {
    add('invalid_agent_id', 'id', 'Agent id must contain lowercase letters, digits, and hyphens');
  }
  for (const field of ['displayName', 'type', 'outputProtocol', 'riskLevel']) {
    if (typeof config[field] !== 'string' || config[field].trim() === '') add('missing_field', field, `Agent config field ${field} is required`);
  }
  if (!RISK_LEVELS.includes(config.riskLevel)) add('invalid_risk_level', 'riskLevel', `Unsupported riskLevel: ${config.riskLevel}`);
  if (typeof config.type === 'string' && !listAdapters().includes(config.type)) add('unknown_adapter_type', 'type', `Unsupported adapter type: ${config.type}`);
  if (!Array.isArray(config.capabilityTags) || config.capabilityTags.length === 0) {
    add('invalid_capability_tags', 'capabilityTags', 'capabilityTags must be a non-empty array');
  } else {
    for (const tag of config.capabilityTags) {
      if (typeof tag !== 'string' || !CAPABILITY_TAGS.has(tag)) add('unknown_capability', 'capabilityTags', `Unsupported capability tag: ${tag}`);
    }
  }
  if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(value => typeof value !== 'string'))) add('invalid_args', 'args', 'args must be an array of strings');
  if (config.env !== undefined && (!config.env || typeof config.env !== 'object' || Array.isArray(config.env))) add('invalid_env', 'env', 'env must be an object');

  return errors.length ? { ok: false, errors } : { ok: true, config };
}

export default { RISK_LEVELS, CAPABILITY_TAGS, stripFullLineComments, parseConfigText, normalizeConfig, validateConfig };
