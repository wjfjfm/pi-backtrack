import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import extension from '../dist/index.js';
import { LEGACY_STATE } from '../dist/contracts.js';

// Public-host mixed batches, continuation and steering live in public-runtime.test.mjs.
function fixture() {
  const sm = SessionManager.inMemory('/');
  const hooks = new Map(), notices = [];
  let tool, aborted = 0;
  extension({ on: (name, handler) => hooks.set(name, handler),
    registerTool: definition => { tool = definition; } });
  sm.appendMessage({ role: 'user', content: 'Hidden by the old view', timestamp: 1 });
  sm.appendCustomEntry(LEGACY_STATE, { view: [] });
  const ctx = { sessionManager: sm, abort: () => { aborted++; }, hasUI: true,
    ui: { notify: message => notices.push(message) }, hasPendingMessages: () => false };
  return { sm, hooks, notices, ctx, tool, aborted: () => aborted };
}

for (const reason of ['resume', 'reload']) test(`legacy view ${reason} is rejected without migration or recovery injection`, () => {
  const f = fixture(), before = structuredClone(f.sm.getBranch());
  f.hooks.get('session_start')({ reason }, f.ctx);
  assert.equal(f.aborted(), 1);
  assert.match(f.notices.join('\n'), /Legacy backtrack view session/);
  assert.deepEqual(f.sm.getBranch(), before);
});

test('legacy context fails closed instead of revealing hidden raw history', () => {
  const f = fixture(), before = structuredClone(f.sm.getBranch());
  const result = f.hooks.get('context')({ messages: f.sm.buildSessionContext().messages }, f.ctx);
  assert.deepEqual(result, { messages: [] });
  assert.equal(f.aborted(), 1);
  assert.deepEqual(f.sm.getBranch(), before);
});

test('legacy compaction is cancelled without changing its preparation or adding messages', async () => {
  const f = fixture(), before = structuredClone(f.sm.getBranch());
  const event = { preparation: { fixture: true } };
  assert.deepEqual(await f.hooks.get('session_before_compact')(event, f.ctx), { cancel: true });
  assert.deepEqual(event, { preparation: { fixture: true } });
  assert.deepEqual(f.sm.getBranch(), before);
});

test('legacy tool execution never registers a policy or changes history', async () => {
  const f = fixture(), before = structuredClone(f.sm.getEntries());
  await assert.rejects(f.tool.execute('call', { checkpoint: 0, message: 'Continue' }, undefined, undefined, f.ctx), /Legacy backtrack view/);
  assert.deepEqual(f.sm.getEntries(), before);
});
