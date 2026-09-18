import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEventBus, SessionManager, buildSessionContext } from '@earendil-works/pi-coding-agent';
import { BacktrackEngine, latestState } from '../dist/engine.js';
import { STATE, REQUEST } from '../dist/contracts.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture(sm = SessionManager.inMemory('/')) {
  const pi = { events: createEventBus(), appendEntry(type, data) { sm.appendCustomEntry(type, structuredClone(data)); }, getAllTools: () => [] };
  const ctx = { cwd: '/', sessionManager: sm, getSystemPrompt: () => 'System', model: { contextWindow: 100000 } };
  return { sm, pi, ctx, engine: new BacktrackEngine(pi) };
}
function toolRound(sm, name = 'bash', id = 'x') {
  const assistant = sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Exploring' }, { type: 'toolCall', id, name, arguments: {} }], timestamp: Date.now() });
  sm.appendMessage({ role: 'toolResult', toolCallId: id, toolName: name, isError: false, content: [{ type: 'text', text: 'TOOL_DATA' }], timestamp: Date.now() });
  return assistant;
}
function apply(engine, ctx, sm, checkpoint, id = 'bt') {
  const state = latestState(ctx);
  const assistantId = toolRound(sm, 'backtrack', id);
  const request = { id, callId: id, assistantId, revision: state.revision, epoch: state.epoch, target: checkpoint, message: `Continuation ${id}` };
  sm.appendCustomEntry(REQUEST, request);
  engine.apply(ctx, request);
  return request;
}

test('checkpoint generation is idempotent and batches stay paired, assistant-only replies have no checkpoint', () => {
  const { sm, ctx, engine } = fixture();
  sm.appendMessage({ role: 'user', content: 'user', timestamp: 1 });
  let state = engine.sync(ctx);
  assert.deepEqual(state.checkpoints.map((c) => c.id), [0, 1]);
  const before = sm.getLeafId();
  engine.project(ctx, buildSessionContext(sm.getBranch()).messages);
  assert.equal(sm.getLeafId(), before);
  sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Done.' }], timestamp: 2 });
  state = engine.sync(ctx);
  assert.deepEqual(state.checkpoints.map((c) => c.id), [0, 1]);
  sm.appendMessage({ role: 'user', content: 'next', timestamp: 3 });
  toolRound(sm);
  state = engine.sync(ctx);
  assert.deepEqual(state.checkpoints.map((c) => c.id), [0, 1, 2, 3]);
});

test('nested backtracks re-extract raw dialogue and zero resets IDs without mutating the stable prefix', () => {
  const { sm, ctx, engine } = fixture();
  const prefix = { role: 'custom', customType: 'other-extension', content: 'Stable synthetic prefix', display: false, timestamp: 0 };
  sm.appendCustomMessageEntry(prefix.customType, prefix.content, false);
  sm.appendMessage({ role: 'user', content: 'Original user', timestamp: 1 });
  engine.sync(ctx);
  toolRound(sm);
  engine.sync(ctx);
  const first = apply(engine, ctx, sm, 1, 'first');
  assert.deepEqual(latestState(ctx).checkpoints.map((c) => c.id), [0, 1, 3]);
  assert.throws(() => engine.apply(ctx, first), /Context changed/);
  sm.appendMessage({ role: 'user', content: 'New user', timestamp: 3 });
  engine.sync(ctx);
  apply(engine, ctx, sm, 0, 'second');
  const state = latestState(ctx);
  assert.deepEqual(state.checkpoints.map((c) => c.id), [0, 1]);
  const view = engine.messages(ctx, state);
  assert.equal(view[0].content, prefix.content);
  const history = view.find((m) => m.customType === 'backtrack:history');
  const body = JSON.stringify(history.content);
  assert.match(body, /Original user/);
  assert.match(body, /New user/);
  assert.doesNotMatch(body, /TOOL_DATA|Continuation first/);
  assert.equal((body.match(/user: Original user/g) ?? []).length, 1);
  assert.notEqual(state.epoch, first.epoch);
});

test('older session paths keep epoch high-water marks; source state and tool artifacts are immutable', () => {
  const { sm, ctx, engine } = fixture();
  sm.appendMessage({ role: 'user', content: 'first', timestamp: 1 });
  engine.sync(ctx);
  const at = sm.getLeafId();
  const original = JSON.stringify(sm.getBranch());
  toolRound(sm); engine.sync(ctx);
  sm.appendMessage({ role: 'user', content: 'later', timestamp: 2 }); engine.sync(ctx);
  sm.branch(at);
  sm.appendMessage({ role: 'user', content: 'alternate', timestamp: 3 });
  const state = engine.sync(ctx);
  assert.deepEqual(state.checkpoints.map((c) => c.id), [0, 1, 4]);
  assert.equal(JSON.stringify(sm.getBranch().slice(0, JSON.parse(original).length)), original);
});

test('repeated zero resets create distinct epochs and subsequent nonzero backtracks continue numbering', () => {
  const { sm, ctx, engine } = fixture();
  assert.throws(() => engine.validate(ctx, 0), /No current checkpoints/);
  sm.appendMessage({ role: 'user', content: 'Keep the task', timestamp: 1 });
  engine.sync(ctx);
  const first = apply(engine, ctx, sm, 0, 'zero-one');
  const epoch = latestState(ctx).epoch;
  apply(engine, ctx, sm, 0, 'zero-two');
  assert.notEqual(latestState(ctx).epoch, epoch);
  assert.deepEqual(latestState(ctx).checkpoints.map((c) => c.id), [0, 1]);
  assert.throws(() => engine.apply(ctx, first), /Context changed/);
  toolRound(sm, 'bash', 'after-reset'); engine.sync(ctx);
  apply(engine, ctx, sm, 1, 'nonzero');
  assert.deepEqual(latestState(ctx).checkpoints.map((c) => c.id), [0, 1, 3]);
});

test('a persisted session can be reopened with the same effective view and checkpoint epoch', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'backtrack-reopen-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = fixture(SessionManager.create(dir, dir));
  first.sm.appendMessage({ role: 'user', content: 'Persist this', timestamp: 1 });
  first.engine.sync(first.ctx);
  toolRound(first.sm);
  first.engine.sync(first.ctx);
  apply(first.engine, first.ctx, first.sm, 0);
  const expected = latestState(first.ctx);
  const view = first.engine.messages(first.ctx, expected);
  const reopened = fixture(SessionManager.open(first.sm.getSessionFile()));
  const actual = reopened.engine.sync(reopened.ctx);
  assert.equal(actual.epoch, expected.epoch);
  assert.deepEqual(actual.checkpoints, expected.checkpoints);
  assert.deepEqual(reopened.engine.messages(reopened.ctx, actual), view);
  assert.doesNotMatch(JSON.stringify(view), /TOOL_DATA/);
  assert.match(JSON.stringify(reopened.sm.getEntries()), /TOOL_DATA/);
  const cloneFile = reopened.sm.createBranchedSession(reopened.sm.getLeafId());
  const cloned = fixture(SessionManager.open(cloneFile));
  assert.notEqual(cloned.sm.getSessionId(), first.sm.getSessionId());
  assert.deepEqual(cloned.engine.messages(cloned.ctx, cloned.engine.sync(cloned.ctx)), view,
    'fork/clone copies the source path and all immutable block references without a companion memory directory');
});

test('projection consumers cannot mutate persisted history or immutable checkpoint blocks', () => {
  const { sm, ctx, engine } = fixture();
  sm.appendMessage({ role: 'user', content: 'Original', timestamp: 1 });
  const state = engine.sync(ctx);
  const before = JSON.stringify(sm.getEntries());
  const view = engine.messages(ctx, state);
  view[0].content = 'Overwritten marker';
  view.find((message) => message.role === 'user').content = 'Overwritten input';
  assert.equal(JSON.stringify(sm.getEntries()), before);
  assert.equal(engine.messages(ctx, state).find((message) => message.role === 'user').content, 'Original');
});

test('incompatible legacy dynamic-skill instances are rejected rather than silently replacing the prefix', () => {
  const { sm, pi, ctx, engine } = fixture();
  pi.getCommands = () => [{ source: 'extension', name: 'dynamic-skill' }];
  sm.appendMessage({ role: 'user', content: 'Input', timestamp: 1 });
  assert.throws(() => engine.sync(ctx), /compatible dynamic-skill/);
});

test('failed assistant messages removed by native recovery do not corrupt the saved input prefix', () => {
  const { sm, ctx, engine } = fixture();
  sm.appendMessage({ role: 'user', content: 'Input', timestamp: 1 });
  engine.sync(ctx);
  sm.appendMessage({ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'overflow', timestamp: 2 });
  engine.sync(ctx, undefined, false);
  const input = buildSessionContext(sm.getBranch()).messages.filter((message) => message.role !== 'assistant');
  assert.doesNotThrow(() => engine.project(ctx, input));
});

test('native custom-message timestamp normalization preserves anchors across host/session representations', () => {
  const { sm, ctx, engine } = fixture();
  sm.appendCustomMessageEntry('host-prefix', 'Stable host prefix', false);
  const user = { role: 'user', content: 'Task', timestamp: 2 };
  sm.appendMessage(user);
  engine.sync(ctx, [{ role: 'custom', customType: 'host-prefix', content: 'Stable host prefix', display: false, timestamp: 1 }, user]);
  const request = apply(engine, ctx, sm, 0);
  assert.match(JSON.stringify(engine.current(ctx)), /Stable host prefix/);
  assert.equal(latestState(ctx).lastTransaction, request.id);
});

test('identical messages are not deduplicated by text or timestamp', () => {
  const { sm, ctx, engine } = fixture();
  const message = { role: 'user', content: 'same', timestamp: 1 };
  const a = sm.appendMessage(message), b = sm.appendMessage({ ...message });
  const state = engine.sync(ctx);
  assert.ok(state.view.includes(a)); assert.ok(state.view.includes(b));
  const checkpoints = state.checkpoints.filter((c) => c.id !== 0);
  assert.deepEqual(checkpoints.map((c) => c.boundary), [a, b]);
});
