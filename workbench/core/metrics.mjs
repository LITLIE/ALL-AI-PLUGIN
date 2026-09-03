const SAFE_META_KEYS = new Set(['runId', 'taskId', 'agentId', 'attempt', 'dimensions']);
const UNIT_BY_NAME = new Map([
  ['run.duration_ms', 'ms'],
  ['run.cost', 'units'],
]);

function unitFor(name, value) {
  if (UNIT_BY_NAME.has(name)) return UNIT_BY_NAME.get(name);
  return name === 'run.retry' || name.startsWith('run.') ? 'count' : String(value);
}

export function metricPayload(name, value, meta = {}) {
  if (typeof name !== 'string' || name.trim() === '') throw new Error('Metric name must be a non-empty string');
  if (!Number.isFinite(value)) throw new Error('Metric value must be a finite number');

  const payload = { name: name.trim(), value, unit: meta.unit || unitFor(name.trim(), value) };
  for (const key of SAFE_META_KEYS) {
    if (meta[key] !== undefined) payload[key] = meta[key];
  }
  return payload;
}

export async function appendMetric(bus, name, value, meta = {}) {
  const payload = metricPayload(name, value, meta);
  const eventMeta = {};
  for (const key of ['runId', 'taskId', 'agentId']) {
    if (meta[key] !== undefined) eventMeta[key] = meta[key];
  }
  return bus.append('metric', payload, eventMeta);
}

function emptyAgent() {
  return { completed: 0, failed: 0, timeout: 0, interrupted: 0 };
}

export function aggregateMetrics(events = [], { sinceMs = 0 } = {}) {
  const threshold = Number.isFinite(sinceMs) && sinceMs > 0 ? Date.now() - sinceMs : null;
  const counts = {};
  const durations = { count: 0, totalMs: 0, averageMs: 0 };
  let retries = 0;
  const agents = {};

  for (const event of events) {
    if (event?.kind !== 'metric' || !event.payload) continue;
    const timestamp = Date.parse(event.ts || '');
    if (threshold !== null && (!Number.isFinite(timestamp) || timestamp < threshold)) continue;

    const metric = event.payload;
    const { name, value, agentId, dimensions } = metric;
    if (typeof name !== 'string' || !Number.isFinite(value)) continue;

    if (name === 'run.duration_ms') {
      durations.count += 1;
      durations.totalMs += value;
    } else if (name === 'run.retry') {
      retries += value;
    } else {
      counts[name] = (counts[name] || 0) + value;
    }

    if (agentId && ['run.completed', 'run.failed', 'run.timeout', 'run.interrupted'].includes(name)) {
      agents[agentId] ||= emptyAgent();
      const outcome = name.slice('run.'.length);
      if (Object.hasOwn(agents[agentId], outcome)) agents[agentId][outcome] += value;
    }
  }

  durations.averageMs = durations.count ? durations.totalMs / durations.count : 0;
  return { counts, durations, retries, agents };
}

export default { metricPayload, appendMetric, aggregateMetrics };
