// Append-only event log. Every message, broadcast and thread transition is one
// JSON line in bus.jsonl; nothing is ever rewritten in place, so concurrent
// writers (main session, subagents, external CLIs) cannot clobber each other.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { paths, ensureBus, readJson, writeJson } from './paths.mjs';

export const KINDS = {
  MESSAGE: 'message',
  BROADCAST: 'broadcast',
  THREAD_OPEN: 'thread.open',
  THREAD_PHASE: 'thread.phase',
  THREAD_CLOSE: 'thread.close',
  DISPATCH: 'dispatch',
  NOTE: 'note',
};

export function newId(prefix = 'msg') {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

// seq is derived from line position, never stored — that keeps appends
// lock-free while still giving every event a stable ordinal.
export function readEvents() {
  const p = ensureBus();
  const raw = fs.readFileSync(p.bus, 'utf8');
  const events = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed);
      rec.seq = events.length + 1;
      events.push(rec);
    } catch {
      events.push({ seq: events.length + 1, kind: 'corrupt', raw: trimmed.slice(0, 200) });
    }
  }
  return events;
}

export function appendEvent(rec) {
  const p = ensureBus();
  const full = { ...rec };
  full.id = rec.id || newId(rec.kind === KINDS.MESSAGE ? 'msg' : 'evt');
  full.ts = rec.ts || new Date().toISOString();
  fs.appendFileSync(p.bus, JSON.stringify(full) + '\n', 'utf8');
  full.seq = readEvents().length;
  return full;
}

export function recipients(event) {
  if (Array.isArray(event.to)) return event.to;
  return event.to ? [event.to] : [];
}

export function addressedTo(event, roleId) {
  const to = recipients(event);
  return to.includes(roleId) || to.includes('*');
}

export function getCursor(roleId) {
  const state = readJson(paths().state, { cursors: {} });
  return Number(state.cursors?.[roleId] ?? 0);
}

export function setCursor(roleId, seq) {
  const file = paths().state;
  const state = readJson(file, { cursors: {} });
  state.cursors = state.cursors || {};
  state.cursors[roleId] = Math.max(Number(state.cursors[roleId] ?? 0), Number(seq));
  state.updated = new Date().toISOString();
  writeJson(file, state);
  return state.cursors[roleId];
}

export function inboxFor(roleId, { unreadOnly = true, limit = 20, includeSelf = false, thread = null } = {}) {
  const cursor = getCursor(roleId);
  return readEvents()
    .filter((e) => e.kind === KINDS.MESSAGE || e.kind === KINDS.BROADCAST)
    .filter((e) => addressedTo(e, roleId))
    .filter((e) => includeSelf || e.from !== roleId)
    .filter((e) => !thread || e.thread === thread)
    .filter((e) => !unreadOnly || e.seq > cursor)
    .slice(-limit);
}

export function unreadCounts(roleIds) {
  const events = readEvents().filter((e) => e.kind === KINDS.MESSAGE || e.kind === KINDS.BROADCAST);
  const out = {};
  for (const roleId of roleIds) {
    const cursor = getCursor(roleId);
    out[roleId] = events.filter((e) => addressedTo(e, roleId) && e.from !== roleId && e.seq > cursor).length;
  }
  return out;
}
