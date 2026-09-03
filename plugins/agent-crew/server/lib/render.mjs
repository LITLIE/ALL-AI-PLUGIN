// Shared text rendering so the CLI and the MCP server describe the bus
// identically — a role reading a transcript through either path sees the
// same message ids, seq numbers and phase labels.
import { threadStatus, MODES } from './threads.mjs';

export function fmtMessage(m) {
  const to = Array.isArray(m.to) ? m.to.join(',') : m.to || '-';
  const head = `#${m.seq} ${m.ts?.slice(5, 16) || ''} ${m.from} -> ${to}${m.thread ? ` [${m.thread}]` : ''}`;
  const sub = m.subject ? `\n  . ${m.subject}` : '';
  const body = (m.body || '').trim().split('\n').map((l) => `  ${l}`).join('\n');
  return `${head}  (${m.id})${sub}\n${body}`;
}

export function whereLine(t) {
  const st = threadStatus(t);
  return t.mode === MODES.RELAY
    ? `阶段 ${st.phase}${st.owner ? '@' + st.owner : ''}${st.next ? ` · 下一棒 ${st.next}` : ' · 最后一棒'}`
    : `第 ${st.round} 轮${st.pending.length ? ' · 待发言 ' + st.pending.join(',') : ' · 本轮已齐'}`;
}

export function threadLine(t) {
  return `${t.status === 'open' ? '[open]  ' : '[closed]'} ${t.id}  ${t.mode}  ${whereLine(t)}  ${t.messages.length} 条\n         ${t.topic}`;
}

export function threadHeader(t) {
  return [
    `线程 ${t.id} (${t.status})`,
    `议题: ${t.topic}`,
    t.goal ? `目标: ${t.goal}` : null,
    `模式: ${t.mode} · ${whereLine(t)}`,
    `参与: ${t.participants.join(', ') || '(空)'}`,
    t.conclusion ? `结论: ${t.conclusion}` : null,
  ].filter(Boolean).join('\n');
}

export function threadView(t, limit = 30) {
  const body = t.messages.length ? t.messages.slice(-limit).map(fmtMessage).join('\n\n') : '(无发言)';
  return `${threadHeader(t)}\n\n${body}`;
}
