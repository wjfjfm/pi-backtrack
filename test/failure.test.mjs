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
  const prepare = async (siblings = []) => {
    sm.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', name: 'backtrack', id: 'bt', arguments: { checkpoint: 0, message: 'Continue' } }, ...siblings], timestamp: 2 });
    return tool.execute('bt', { checkpoint: 0, message: 'Continue' }, undefined, undefined, ctx);
  };
  return { sm, hooks, notices, ctx, project, prepare, tool: () => tool, aborted: () => aborted, failCommit: () => { failCommit = true; } };
}

for (const reason of ['missing', 'duplicate', 'wrong-name', 'error', 'aborted', 'queued', 'input'])
test(`mixed batch is cancelled on ${reason}`, async () => {
  const f = fixture();
  await f.prepare([{ type: 'toolCall', name: 'write', id: 'save', arguments: { path: '/unused', content: 'test' } }]);
  const bt = { role: 'toolResult', toolCallId: 'bt', toolName: 'backtrack', isError: false, content: [], timestamp: 3 };
  const sibling = { ...bt, toolCallId: 'save', toolName: 'write' };
  let results = [bt, sibling];
  if (reason === 'missing') results = [bt];
  if (reason === 'duplicate') results = [bt, bt];
  if (reason === 'wrong-name') sibling.toolName = 'read';
  if (reason === 'error') sibling.isError = true;
  if (reason === 'aborted') f.ctx.signal = AbortSignal.abort();
  if (reason === 'queued') f.ctx.hasPendingMessages = () => true;
  if (reason === 'input') f.hooks.get('input')({});
  results.forEach((result) => f.sm.appendMessage(result));
  f.hooks.get('turn_end')({ toolResults: results }, f.ctx);
  f.hooks.get('turn_end')({ toolResults: results }, f.ctx);
  const entries = f.sm.getBranch();
  assert.equal(entries.filter((e) => e.customType === CANCELLED).length, 1);
  assert.ok(!entries.some((e) => e.customType === STATE && e.data.lastTransaction));
});

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

test('reload publishes commit failure status exactly once without claiming rollback', async () => {
  const f = fixture();
  const result = await f.prepare();
  const toolResult = { role: 'toolResult', toolCallId: 'bt', toolName: 'backtrack', isError: false, content: result.content, timestamp: 3 };
  f.sm.appendMessage(toolResult);
  f.failCommit();
  f.hooks.get('turn_end')({ toolResults: [toolResult] }, f.ctx);
  f.hooks.get('session_start')({ reason: 'reload' }, f.ctx);
  f.hooks.get('session_start')({ reason: 'reload' }, f.ctx);
  f.sm.appendMessage({ role: 'user', content: 'Continue', timestamp: 4 });
  const messages = f.project();
  const notices = messages.filter(m => m.customType === 'backtrack:commit-failed');
  assert.equal(notices.length, 1);
  assert.match(notices[0].content, /injected disk error/);
  assert.match(notices[0].content, /last persisted effective context without replay/);
  assert.match(notices[0].content, /Partial changes may remain/);
  assert.ok(messages.indexOf(notices[0]) > messages.findIndex(m => m.role === 'toolResult'));
  assert.equal(f.sm.getBranch().filter(e => e.customType === 'backtrack:block:v1'
    && e.data.message.customType === 'backtrack:commit-failed').length, 1);
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
