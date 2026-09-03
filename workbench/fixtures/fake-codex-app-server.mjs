import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const respond = result => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  if (request.method === 'initialize') respond({ userAgent: 'fixture-codex' });
  else if (request.method === 'thread/start') respond({ thread: { id: 'thread-fixture' } });
  else if (request.method === 'turn/start') {
    respond({ turn: { id: 'turn-fixture' } });
    if (process.env.FAKE_CODEX_EXIT === '1') {
      setTimeout(() => process.exit(7), 10);
      return;
    }
    if (process.env.FAKE_CODEX_ERROR === '1') {
      setTimeout(() => process.stdout.write(`${JSON.stringify({ method: 'server/error', params: { message: 'fixture server error' } })}\n`), 10);
      return;
    }
    if (process.env.FAKE_CODEX_HANG === '1') return;
    setTimeout(() => process.stdout.write(`${JSON.stringify(process.env.FAKE_CODEX_EVENT_MSG === '1'
      ? { method: 'event_msg', params: { payload: { type: 'task_complete', turn_id: 'turn-fixture', last_message: 'event msg done', cost: 0.04 } } }
      : process.env.FAKE_CODEX_NESTED === '1'
      ? { method: 'turn/completed', params: { turn: { id: 'turn-fixture', status: 'completed', result: 'nested done', cost: 0.03 } } }
      : { method: 'turn/completed', params: { turnId: 'turn-fixture', text: 'codex done', cost: 0.02 } })}\n`), 20);
  } else if (request.method === 'turn/interrupt') {
    if (process.env.FAKE_CODEX_INTERRUPT_FILE) {
      appendFileSync(process.env.FAKE_CODEX_INTERRUPT_FILE, `${JSON.stringify(request.params)}\n`);
    }
    if (process.env.FAKE_CODEX_RECORD_INTERRUPT === '1') {
      process.stdout.write(`${JSON.stringify({ method: 'interrupt/received', params: request.params })}\n`);
    }
    respond({ ok: true });
  }
  else if (request.method === 'shutdown') process.exit(0);
});
