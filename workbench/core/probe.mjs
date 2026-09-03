// Compatibility wrapper: the shared runtime kernel owns probe semantics.
export { probeCommand, normalizeProbeResult, PROBE_DEFAULTS } from '../../shared/agent-runtime/probe.mjs';
export { probeCommand as default } from '../../shared/agent-runtime/probe.mjs';
