#!/usr/bin/env node
// crew — command line face of the agent-crew bus.
// Slash commands, hooks and subagents all go through this one entry point so
// the MCP server and the shell see exactly the same state.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = (f) => path.join(here, '..', 'server', 'lib', f);
const { ensureBus } = await import(`file://${lib('paths.mjs')}`);
const store = await import(`file://${lib('store.mjs')}`);
const roles = await import(`file://${lib('roles.mjs')}`);
const threads = await import(`file://${lib('threads.mjs')}`);
const dispatch = await import(`file://${lib('dispatch.mjs')}`);
const render = await import(`file://${lib('render.mjs')}`);

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      // --key=value is the only way to pass a value that itself starts with
      // "--", which CLI backends need constantly (--args=--version,-C,.).
      const eq = a.indexOf('=');
      if (eq > 2) { out.flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out.flags[key] = true;
      else { out.flags[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const listArg = (v) =>
  typeof v === 'string' ? v.split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean) : [];
const bodyOf = (flags) => (flags.body === '-' ? fs.readFileSync(0, 'utf8') : typeof flags.body === 'string' ? flags.body : '');

function print(data, flags) {
  if (flags?.json) { console.log(JSON.stringify(data, null, 2)); return; }
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

function requireRole(ref, what = 'role') {
  const r = roles.resolveRole(ref);
  if (!r) throw new Error(`unknown ${what}: ${ref}\n可用角色: ${roles.roleIds().join(', ')}`);
  return r;
}

// Let read/advance/close omit the id when there is exactly one open thread.
// Two or more open threads is refused, not guessed.
function onlyOpenThread() {
  const open = threads.listThreads({ openOnly: true });
  if (open.length === 1) return open[0];
  if (!open.length) throw new Error('没有开着的线程（先 thread open）');
  throw new Error(`有 ${open.length} 个线程开着，要指名 --id：\n${open.map((t) => `  ${t.id}  ${t.topic}`).join('\n')}`);
}

const commands = {};

commands.init = (flags) => {
  const p = ensureBus();
  roles.loadRegistry();
  print(`已初始化消息总线
  project : ${p.project}
  bus     : ${p.bus}
  roles   : ${p.roles}

角色清单:
${roles.listRoles().map((r) => '  ' + roles.describeRole(r)).join('\n')}`, flags);
};

commands.doctor = (flags) => {
  const p = ensureBus();
  const report = { node: process.version, project: p.project, bus: p.bus, events: store.readEvents().length, roles: [] };
  for (const r of roles.listRoles()) {
    const entry = { id: r.id, backend: r.backend?.type };
    if (r.backend?.type === roles.BACKENDS.CLI) Object.assign(entry, dispatch.probeCli(r));
    report.roles.push(entry);
  }
  if (flags.json) return print(report, flags);
  const lines = [`node ${report.node}`, `project ${report.project}`, `events ${report.events}`, ''];
  for (const r of report.roles) {
    const mark = r.backend === roles.BACKENDS.CLI ? (r.ok ? 'OK  ' : 'FAIL') : '--  ';
    lines.push(`${mark} ${r.id} (${r.backend})${r.reason ? ` — ${r.reason}` : ''}`);
  }
  print(lines.join('\n'), flags);
};

commands.roster = (flags) => {
  if (flags.json) return print(roles.listRoles(), flags);
  const counts = store.unreadCounts(roles.roleIds());
  print(roles.listRoles().map((r) => `${roles.describeRole(r)}${counts[r.id] ? `  · ${counts[r.id]} 条未读` : ''}`).join('\n'), flags);
};

commands.role = (flags, rest) => {
  const sub = rest[0];
  if (sub === 'rm') { roles.removeRole(String(flags.id)); return print(`已删除角色 ${flags.id}`, flags); }
  if (sub !== 'add' && sub !== 'set') throw new Error('用法: role add|set|rm --id <id> [...]');
  const backendType = flags.backend || roles.BACKENDS.SUBAGENT;
  const backend = { type: backendType };
  if (backendType === roles.BACKENDS.SUBAGENT) backend.agent = flags.agent || `agent-crew:${flags.id}`;
  if (backendType === roles.BACKENDS.CLI) {
    if (!flags.command) throw new Error('cli 后端需要 --command');
    backend.command = String(flags.command);
    backend.args = listArg(flags.args);
    backend.stdinPrompt = flags.stdin !== 'false';
    if (flags.timeout) backend.timeoutMs = Number(flags.timeout);
  }
  roles.upsertRole({
    id: String(flags.id),
    name: flags.name ? String(flags.name) : String(flags.id),
    title: flags.title ? String(flags.title) : '',
    specialty: flags.specialty ? String(flags.specialty) : '',
    backend,
  });
  print(`已写入角色 ${flags.id}\n${roles.describeRole(roles.resolveRole(flags.id))}`, flags);
};

commands.send = (flags) => {
  const from = requireRole(flags.from || 'orchestrator', 'from role').id;
  const to = listArg(flags.to);
  if (!to.length) throw new Error('缺少 --to（逗号分隔，或用 * 表示全体）');
  for (const t of to) if (t !== '*') requireRole(t, 'to role');
  let thread = null;
  if (flags.thread) {
    thread = threads.getThread(String(flags.thread))?.id || null;
    if (!thread) throw new Error(`unknown thread: ${flags.thread}`);
  }
  const event = store.appendEvent({
    kind: to.includes('*') ? store.KINDS.BROADCAST : store.KINDS.MESSAGE,
    thread,
    from,
    to,
    subject: flags.subject ? String(flags.subject) : null,
    body: bodyOf(flags),
    refs: listArg(flags.refs),
    meta: flags.phase ? { phase: String(flags.phase) } : undefined,
  });
  store.setCursor(from, event.seq);
  print(flags.json ? event : `已投递 ${event.id} (#${event.seq}) ${from} -> ${to.join(',')}${thread ? ` [${thread}]` : ''}`, flags);
};

commands.broadcast = (flags) => commands.send({ ...flags, to: '*' });

commands.inbox = (flags) => {
  const role = requireRole(flags.role || 'orchestrator').id;
  const msgs = store.inboxFor(role, {
    unreadOnly: !flags.all,
    limit: Number(flags.limit || 20),
    includeSelf: !!flags.includeSelf,
    thread: flags.thread ? threads.getThread(String(flags.thread))?.id : null,
  });
  if (!flags.peek && msgs.length) store.setCursor(role, Math.max(...msgs.map((m) => m.seq)));
  if (flags.json) return print({ role, count: msgs.length, messages: msgs }, flags);
  print(msgs.length
    ? `${role} 的${flags.all ? '全部' : '未读'}消息 (${msgs.length}):\n\n${msgs.map(render.fmtMessage).join('\n\n')}`
    : `${role}: 没有${flags.all ? '' : '未读'}消息`, flags);
};

commands.log = (flags) => {
  const events = store.readEvents().slice(-Number(flags.limit || 20));
  if (flags.json) return print(events, flags);
  print(events.length
    ? events.map((e) => {
        const to = Array.isArray(e.to) ? e.to.join(',') : e.to || '-';
        const tail = e.subject || e.topic || e.phase || e.conclusion || '';
        return `#${e.seq} ${e.ts?.slice(5, 16)} ${String(e.kind).padEnd(13)} ${e.from || '-'} -> ${to}  ${tail}`;
      }).join('\n')
    : '总线还是空的', flags);
};

function threadOpen(flags) {
  const participants = listArg(flags.participants);
  for (const p of participants) requireRole(p, 'participant');
  const assignments = {};
  for (const pair of listArg(flags.assign)) {
    const [phase, role] = pair.split('=');
    if (phase && role) assignments[phase.trim()] = requireRole(role.trim(), 'assignee').id;
  }
  const event = threads.openThread({
    topic: flags.topic ? String(flags.topic) : undefined,
    mode: flags.mode ? String(flags.mode) : threads.MODES.DEBATE,
    participants,
    phases: listArg(flags.phases),
    assignments,
    goal: flags.goal ? String(flags.goal) : null,
    from: requireRole(flags.from || 'orchestrator').id,
  });
  print(flags.json ? event : [
    `已开线程 ${event.thread}`,
    `  议题: ${event.topic}`,
    `  模式: ${event.mode}`,
    `  参与: ${participants.join(', ') || '(空)'}`,
    event.phases?.length ? `  阶段: ${event.phases.join(' -> ')}` : null,
    Object.keys(assignments).length ? `  分工: ${Object.entries(assignments).map(([k, v]) => `${k}=${v}`).join(', ')}` : null,
  ].filter(Boolean).join('\n'), flags);
}

function threadRead(t, flags) {
  if (flags.json) return print({ ...t, status_detail: threads.threadStatus(t) }, flags);
  print(render.threadView(t, Number(flags.limit || 30)), flags);
}

commands.thread = (flags, rest) => {
  const sub = rest[0] || 'list';
  if (sub === 'open') return threadOpen(flags);
  if (sub === 'list') {
    const all = threads.listThreads({ openOnly: !!flags.open });
    if (flags.json) return print(all, flags);
    return print(all.length ? all.map(render.threadLine).join('\n') : '还没有线程', flags);
  }
  const ref = String(flags.id || rest[1] || '');
  const t = ref ? threads.getThread(ref) : onlyOpenThread();
  if (!t) throw new Error(`unknown thread: ${ref || '(missing --id)'}`);
  if (sub === 'read') return threadRead(t, flags);
  if (sub === 'advance') {
    const event = threads.advanceThread({
      thread: t.id,
      phase: flags.phase ? String(flags.phase) : null,
      note: flags.note ? String(flags.note) : null,
      from: requireRole(flags.from || 'orchestrator').id,
    });
    const st = threads.threadStatus(threads.getThread(t.id));
    return print(flags.json ? event : `${t.id} 进入阶段 ${event.phase}（负责 ${st.owner || '未指派'}，下一棒 ${st.next || '无'}）`, flags);
  }
  if (sub === 'close') {
    const event = threads.closeThread({
      thread: t.id,
      conclusion: flags.conclusion ? String(flags.conclusion) : bodyOf(flags),
      from: requireRole(flags.from || 'orchestrator').id,
    });
    return print(flags.json ? event : `已关闭线程 ${t.id}`, flags);
  }
  throw new Error('用法: thread open|list|read|advance|close');
};

commands.brief = (flags) => {
  const role = requireRole(flags.role);
  print(dispatch.buildBriefing({
    role,
    task: flags.task ? String(flags.task) : bodyOf(flags),
    thread: flags.thread ? threads.getThread(String(flags.thread))?.id : null,
    from: requireRole(flags.from || 'orchestrator').id,
  }), { json: false });
};

commands.dispatch = (flags) => {
  const result = dispatch.dispatchRole({
    role: flags.role,
    task: flags.task ? String(flags.task) : bodyOf(flags),
    thread: flags.thread ? threads.getThread(String(flags.thread))?.id : null,
    from: requireRole(flags.from || 'orchestrator').id,
  });
  if (flags.json) return print(result, flags);
  if (result.mode === 'completed') {
    return print(`${result.role} 已回帖 ${result.event.id} (#${result.event.seq})，用时 ${Math.round(result.durationMs / 1000)}s
日志: ${result.log}

${(result.event.body || '').slice(0, 6000)}`, flags);
  }
  if (result.mode === 'handoff') {
    return print(`${result.role} 需要主会话启动 subagent: ${result.subagent}

=== BRIEFING BEGIN ===
${result.briefing}
=== BRIEFING END ===`, flags);
  }
  if (result.mode === 'ask-human') {
    return print(`${result.role} 是人类角色，把下面的内容问用户：

${result.briefing}`, flags);
  }
  return print(result.briefing, flags);
};

commands.digest = (flags) => {
  const open = threads.listThreads({ openOnly: true });
  const counts = store.unreadCounts(roles.roleIds());
  const pending = Object.entries(counts).filter(([, n]) => n > 0);
  if (!open.length && !pending.length) return;
  const lines = ['agent-crew: 总线上有进行中的协作'];
  for (const t of open) {
    lines.push(`- 线程 ${t.id} (${t.mode})「${t.topic}」${render.whereLine(t)}`);
  }
  if (pending.length) lines.push(`- 未读: ${pending.map(([r, n]) => `${r}(${n})`).join(', ')}`);
  lines.push('需要时用 /agent-crew:status 展开。');
  print(lines.join('\n'), flags);
};

commands.help = () => {
  console.log([
    'crew — agent-crew 消息总线 CLI',
    '',
    '  init                       初始化 <project>/.agentbus/',
    '  doctor [--json]            体检：node / 总线 / 各后端可用性',
    '  roster [--json]            角色清单 + 未读数',
    '  role add|set --id X [--name N] [--title T] [--specialty S]',
    '        [--backend self|claude-subagent|cli|human] [--agent plugin:agent]',
    '        [--command cmd --args "exec,-C,{{project}},-"] [--timeout ms]',
    '  role rm --id X',
    '  send --from X --to a,b [--subject S] --body T [--thread th] [--refs id1,id2]',
    '  broadcast --from X --subject S --body T [--thread th]',
    '  inbox --role X [--all] [--peek] [--limit N] [--thread th] [--json]',
    '  thread open --topic T --mode debate|relay --participants a,b',
    '        [--phases design,review] [--assign design=trae,review=critic] [--goal G]',
    '  thread list [--open] [--json]',
    '  thread read --id th [--limit N] [--json]',
    '  thread advance --id th [--phase P] [--note N]',
    '  thread close --id th --conclusion C',
    '  brief --role X [--task T] [--thread th]',
    '  dispatch --role X --task T [--thread th] [--json]',
    '  log [--limit N] [--json]',
    '  digest',
    '',
    '  --body - 表示正文从 stdin 读取。角色名支持 @前缀与唯一前缀匹配。',
  ].join('\n'));
};

const { _: positional, flags } = parseArgs(process.argv.slice(2));
const name = positional[0] || 'help';
const fn = commands[name];
if (!fn) {
  console.error(`unknown command: ${name}`);
  commands.help();
  process.exit(2);
}
try {
  fn(flags, positional.slice(1));
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
