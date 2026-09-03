import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../core/bus.mjs';
import { tempWorkspace } from './helpers.mjs';

test('bus appends redacted events with continuous seq', async () => {
  const dir = await tempWorkspace();
  const bus = new EventBus(dir);
  await bus.init();
  await bus.append('system', { secret: 'sk-test12345678901234567890' });
  const events = await bus.readAll();
  assert.equal(events[0].seq, 1);
  assert.match(JSON.stringify(events[0]), /REDACTED/);
  await bus.close();
});
