// Threads are derived state, not stored records: fold the event log and you get
// the current topic, phase, round and who still owes a turn. That means a
// thread can be resumed from any session, or replayed for an audit.
import { readEvents, appendEvent, KINDS, newId } from './store.mjs';
import { listRoles, BACKENDS } from './roles.mjs';

export const MODES = { DEBATE: 'debate', RELAY: 'relay' };
export const DEFAULT_RELAY_PHASES = ['design', 'implement', 'review', 'fix'];

export function foldThreads(events = readEvents()) {
  const threads = new Map();
  for (const e of events) {
    if (e.kind === KINDS.THREAD_OPEN) {
      threads.set(e.thread, {
        id: e.thread,
        topic: e.topic || e.subject || '(no topic)',
        mode: e.mode || MODES.DEBATE,
        participants: Array.isArray(e.participants) ? e.participants : [],
        phases: Array.isArray(e.phases) ? e.phases : [],
        assignments: e.assignments || {},
        opened_by: e.from,
        opened_at: e.ts,
        status: 'open',
        phase: Array.isArray(e.phases) && e.phases.length ? e.phases[0] : null,
        phaseHistory: [],
        conclusion: null,
        messages: [],
        goal: e.goal || null,
      });
      continue;
    }
    const t = threads.get(e.thread);
    if (!t) continue;
    if (e.kind === KINDS.THREAD_PHASE) {
      t.phase = e.phase;
      t.phaseHistory.push({ phase: e.phase, ts: e.ts, by: e.from, note: e.note || null });
    } else if (e.kind === KINDS.THREAD_CLOSE) {
      t.status = 'closed';
      t.closed_at = e.ts;
      t.conclusion = e.conclusion || null;
    } else if (e.kind === KINDS.MESSAGE || e.kind === KINDS.BROADCAST || e.kind === KINDS.DISPATCH) {
      t.messages.push(e);
    }
  }
  return threads;
}

export function listThreads({ openOnly = false } = {}) {
  const all = [...foldThreads().values()];
  return openOnly ? all.filter((t) => t.status === 'open') : all;
}

export function getThread(id) {
  if (!id) return null;
  const threads = foldThreads();
  if (threads.has(id)) return threads.get(id);
  // tolerate short ids / suffixes so humans can type th_ab instead of the full id
  for (const [key, value] of threads) if (key.startsWith(id)) return value;
  return null;
}

export function openThread({ topic, mode = MODES.DEBATE, participants = [], phases, assignments, from = 'orchestrator', goal = null }) {
  if (!topic) throw new Error('topic is required');
  const known = new Set(listRoles().map((r) => r.id));
  const bad = participants.filter((p) => !known.has(p));
  if (bad.length) throw new Error(`unknown role(s): ${bad.join(', ')} — run agent_roster to see valid ids`);
  const resolvedPhases = mode === MODES.RELAY ? (phases?.length ? phases : DEFAULT_RELAY_PHASES) : phases || [];
  return appendEvent({
    kind: KINDS.THREAD_OPEN,
    thread: newId('th'),
    topic,
    mode,
    participants,
    phases: resolvedPhases,
    assignments: assignments || {},
    goal,
    from,
  });
}

// Which participants can actually be driven by the orchestrator this turn.
function drivable(thread) {
  const roles = new Map(listRoles().map((r) => [r.id, r]));
  return thread.participants.filter((id) => {
    const type = roles.get(id)?.backend?.type;
    return type === BACKENDS.SUBAGENT || type === BACKENDS.CLI;
  });
}

export function debateStatus(thread) {
  const speakers = drivable(thread);
  const counts = {};
  for (const id of speakers) counts[id] = thread.messages.filter((m) => m.from === id).length;
  const floor = speakers.length ? Math.min(...speakers.map((id) => counts[id])) : 0;
  const round = floor + 1;
  const spoken = speakers.filter((id) => counts[id] >= round);
  const pending = speakers.filter((id) => counts[id] < round);
  return { round, counts, spoken, pending, speakers };
}

export function relayStatus(thread) {
  const phases = thread.phases.length ? thread.phases : DEFAULT_RELAY_PHASES;
  const index = Math.max(0, phases.indexOf(thread.phase ?? phases[0]));
  const phase = phases[index];
  return {
    phases,
    phase,
    index,
    owner: thread.assignments?.[phase] || null,
    next: phases[index + 1] || null,
    nextOwner: phases[index + 1] ? thread.assignments?.[phases[index + 1]] || null : null,
    remaining: phases.slice(index + 1),
  };
}

export function threadStatus(thread) {
  return thread.mode === MODES.RELAY ? relayStatus(thread) : debateStatus(thread);
}

export function advanceThread({ thread, phase, note, from = 'orchestrator' }) {
  const t = getThread(thread);
  if (!t) throw new Error(`unknown thread: ${thread}`);
  if (t.status !== 'open') throw new Error(`thread ${t.id} is already closed`);
  let target = phase;
  if (!target) {
    if (t.mode !== MODES.RELAY) throw new Error('phase is required for debate threads');
    const st = relayStatus(t);
    if (!st.next) throw new Error(`relay ${t.id} is already at the last phase (${st.phase})`);
    target = st.next;
  }
  return appendEvent({ kind: KINDS.THREAD_PHASE, thread: t.id, phase: target, note: note || null, from });
}

export function closeThread({ thread, conclusion, from = 'orchestrator' }) {
  const t = getThread(thread);
  if (!t) throw new Error(`unknown thread: ${thread}`);
  return appendEvent({ kind: KINDS.THREAD_CLOSE, thread: t.id, conclusion: conclusion || null, from });
}
