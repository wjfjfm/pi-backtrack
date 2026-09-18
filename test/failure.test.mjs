import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEventBus, SessionManager, buildSessionContext } from '@earendil-works/pi-coding-agent';
import extension from '../dist/index.js';
import { STATE, CANCELLED } from '../dist/contracts.js';

function fixture() {
  const sm = SessionManager.inMemory('/');
  const hooks = new Map();
  const notices = [];
  let tool, aborted = 0, failCommit = false;
  const pi = {
    events: createEventBus(), on: (name, handler) => hooks.set(name, handler),
    getCommands: () => [], getAllTools: () => [],
    registerTool: (definition) => { tool = definition; },
    appendEntry(type, data) {
      if (failCommit && type === STATE && data.lastTransaction) throw new Error('injected disk error');
      sm.appendCustomEntry(type, structuredClone(data));
    },
    sendMessage(message) { sm.appendCustomMessageEntry(message.customType, message.content, message.display, message.details); },
  };
  const ctx = { cwd: '/', sessionManager: sm, getSystemPrompt: () => 'System', model: { contextWindow: 100000 },
    hasPendingMessages: () => false, abort: () => { aborted++; }, hasUI: true, ui: { notify: (message) => notices.push(message) } };
  extension(pi);
  sm.appendMessage({ role: 'user', content: 'Initial user', timestamp: 1 });
  const project = () => hooks.get('context')({ messages: buildSessionContext(sm.getBranch()).messages }, ctx).messages;
  project();
  const prepare = async () => {
    sm.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', name: 'backtrack', id: 'bt', arguments: { checkpoint: 0, message: 'Continue' } }], timestamp: 2 });
    return tool.execute('bt', { checkpoint: 0, message: 'Continue' }, undefined, undefined, ctx);
  };
  return { sm, hooks, notices, ctx, project, prepare, tool: () => tool, aborted: () => aborted, failCommit: () => { failCommit = true; } };
}

test('commit failure stops generation before reporting, without claiming rollback or replaying the transaction', async () => {
  const f = fixture();
  const result = await f.prepare();
  const toolResult = { role: 'toolResult', toolCallId: 'bt', toolName: 'backtrack', isError: false, content: result.content, timestamp: 3 };
  f.sm.appendMessage(toolResult);
  f.failCommit();
  f.hooks.get('turn_end')({ toolResults: [toolResult] }, f.ctx);
  assert.equal(f.aborted(), 1);
  assert.match(f.notices.join('\n'), /Commit did not finish/);
  assert.ok(f.sm.getBranch().some((entry) => entry.customType === CANCELLED && entry.data.phase === 'commit-failed'));
  assert.deepEqual(f.project(), []);
  assert.equal(f.aborted(), 2, 'context-hook failure must abort instead of falling back to raw history');
  await assert.rejects(f.tool().execute('bt', { checkpoint: 0, message: 'Again' }, undefined, undefined, f.ctx), /unavailable/);
});

test('restart cancels an uncommitted prepared call, repairs missing tool pairing in the view, and never replays it', async () => {
  const f = fixture();
  await f.prepare();
  f.hooks.get('session_start')({ reason: 'resume' }, f.ctx);
  assert.match(f.notices.join('\n'), /interrupted by session restart/);
  f.sm.appendMessage({ role: 'user', content: 'New request after restart', timestamp: 4 });
  const messages = f.project();
  const callIndex = messages.findIndex((message) => message.role === 'assistant');
  assert.equal(messages[callIndex + 1].role, 'toolResult');
  assert.equal(messages[callIndex + 1].toolCallId, 'bt');
  assert.equal(messages[callIndex + 1].isError, true);
  assert.match(JSON.stringify(messages), /checkpoint 2/);
  assert.equal(f.sm.getBranch().some((entry) => entry.customType === STATE && entry.data.lastTransaction), false);
  assert.deepEqual(f.project(), messages, 'repair is persisted once, not duplicated on request retry');
  await assert.rejects(f.tool().execute('bt', { checkpoint: 0, message: 'Again' }, undefined, undefined, f.ctx), /already been prepared/);
});
