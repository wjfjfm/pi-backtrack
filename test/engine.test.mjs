import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEventBus, SessionManager, buildSessionContext } from '@earendil-works/pi-coding-agent';
import { BacktrackEngine, latestState } from '../dist/engine.js';
import { STATE, REQUEST, BLOCK } from '../dist/contracts.js';
import { DYNAMIC_CONTEXT } from '../dist/context.js';
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
  const request = { id, callId: id, assistantId, epoch: state.epoch, target: checkpoint, message: `Continuation ${id}` };
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
  assert.throws(() => engine.apply(ctx, first), /already completed/);
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
  assert.throws(() => engine.apply(ctx, first), /previous epoch/);
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

test('source navigation does not inspect extension command names to approve a backtrack', () => {
  const { sm, pi, ctx, engine } = fixture();
  pi.getCommands = () => { throw new Error('Command-name compatibility probing is not navigation'); };
  sm.appendMessage({ role: 'user', content: 'Input', timestamp: 1 });
  engine.sync(ctx);
  assert.doesNotThrow(() => apply(engine, ctx, sm, 0));
});

test('failed assistant messages removed by native recovery do not corrupt the saved input prefix', () => {
  const { sm, ctx, engine } = fixture();
  sm.appendMessage({ role: 'user', content: 'Input', timestamp: 1 });
  engine.sync(ctx);
  sm.appendMessage({ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'overflow', timestamp: 2 });
  engine.sync(ctx);
  const input = buildSessionContext(sm.getBranch()).messages.filter((message) => message.role !== 'assistant');
  assert.doesNotThrow(() => engine.project(ctx, input));
});

test('native custom-message timestamp normalization preserves anchors across host/session representations', () => {
  const { sm, ctx, engine } = fixture();
  sm.appendCustomMessageEntry('host-prefix', 'Stable host prefix', false);
  const user = { role: 'user', content: 'Task', timestamp: 2 };
  sm.appendMessage(user);
  engine.project(ctx, [{ role: 'custom', customType: 'host-prefix', content: 'Stable host prefix', display: false, timestamp: 1 }, user]);
  const request = apply(engine, ctx, sm, 0);
  assert.match(JSON.stringify(engine.current(ctx)), /Stable host prefix/);
  assert.equal(latestState(ctx).lastTransaction, request.id);
});

test('request-local additions follow retained source nodes without becoming navigation state', () => {
  const { sm, ctx, engine } = fixture();
  const note = (name) => ({ role: 'custom', customType: name, content: name, display: false, timestamp: 0 });
  const input = () => [note('EXTERNAL_PREFIX'), ...buildSessionContext(sm.getBranch()).messages.flatMap((message) => [message,
    ...(message.role === 'user' ? [note('USER_NOTE')] : []),
    ...(message.role === 'toolResult' && message.toolName === 'bash' ? [note('TOOL_NOTE')] : []),
  ]), note('EXTERNAL_SUFFIX')];
  sm.appendMessage({ role: 'user', content: 'Task', timestamp: 1 });
  engine.project(ctx, input());
  toolRound(sm); engine.project(ctx, input());
  apply(engine, ctx, sm, 1, 'keep-user');
  let view = engine.project(ctx, input());
  assert.match(JSON.stringify(view), /USER_NOTE/);
  assert.doesNotMatch(JSON.stringify(view), /TOOL_NOTE|TOOL_DATA/);
  apply(engine, ctx, sm, 0, 'reset');
  view = engine.project(ctx, input());
  assert.equal(view[0].content, 'EXTERNAL_PREFIX');
  assert.equal(view.at(-1).content, 'EXTERNAL_SUFFIX');
  assert.doesNotMatch(JSON.stringify(view), /USER_NOTE|TOOL_NOTE|TOOL_DATA/);
  assert.doesNotMatch(JSON.stringify(sm.getEntries()), /EXTERNAL_PREFIX|EXTERNAL_SUFFIX|USER_NOTE|TOOL_NOTE/);
  const before = JSON.stringify(sm.getEntries());
  view.find((message) => message.customType === 'backtrack:history').content = 'mutated downstream';
  assert.equal(JSON.stringify(sm.getEntries()), before);
});

test('cancelled compaction leaves every completed boundary numbered exactly once', () => {
  const { sm, ctx, engine } = fixture();
  sm.appendMessage({ role: 'user', content: 'Initial', timestamp: 1 });
  const initial = engine.sync(ctx);
  sm.appendMessage({ role: 'user', content: 'New input', timestamp: 2 });
  toolRound(sm);
  const event = { preparation: {} };
  engine.prepareCompact(event, ctx);
  // The summarizer now fails/cancels; no compaction entry is appended.
  const state = engine.sync(ctx);
  assert.equal(state.epoch, initial.epoch);
  assert.deepEqual(state.checkpoints.map((c) => c.id), [0, 1, 2, 3]);
  const leaf = sm.getLeafId();
  engine.project(ctx, buildSessionContext(sm.getBranch()).messages);
  assert.equal(sm.getLeafId(), leaf);
  assert.equal(event.preparation.messagesToSummarize.some((m) => m.customType === 'backtrack:checkpoint'), false);
});

test('old fingerprint snapshots recover their source cursor without replaying history', () => {
  const { sm, ctx, engine } = fixture();
  const user = sm.appendMessage({ role: 'user', content: 'Original', timestamp: 1 });
  const { cursor, ...old } = engine.sync(ctx);
  const legacy = sm.appendCustomEntry(STATE, { ...old, revision: 'legacy', inputKeys: ['legacy external prefix', 'legacy user'] });
  assert.equal(latestState(ctx).cursor, user);
  toolRound(sm);
  const state = engine.sync(ctx);
  assert.deepEqual(state.checkpoints.map((c) => c.id), [0, 1, 2]);
  assert.equal(state.cursor, sm.getBranch().findLast((entry) => entry.type === 'message').id);
  assert.equal('inputKeys' in state, false);
  assert.equal('revision' in state, false);
  assert.deepEqual(sm.getEntry(legacy).data.inputKeys, ['legacy external prefix', 'legacy user']);
  apply(engine, ctx, sm, 0);
  assert.doesNotMatch(JSON.stringify(engine.current(ctx)), /TOOL_DATA/);
});

test('native compact retained tails use source ordering for cursor migration and raw ordering for history', () => {
  const { sm, ctx, engine } = fixture();
  const user = sm.appendMessage({ role: 'user', content: 'Retained native user', timestamp: 1 });
  const reply = sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Retained native reply' }], timestamp: 2 });
  const compact = sm.appendCompaction('Earlier summary', user, 1000);
  const { cursor, ...old } = engine.sync(ctx);
  assert.equal(cursor, reply, 'the native context orders summary before retained tail');
  sm.appendCustomEntry(STATE, { ...old, revision: 'legacy', inputKeys: [] });
  assert.equal(latestState(ctx).cursor, reply, 'do not mistake the later raw compaction entry for the consumed tail');
  assert.notEqual(latestState(ctx).cursor, compact);
  assert.equal(engine.sync(ctx).view.filter((id) => id === user).length, 1);
  apply(engine, ctx, sm, 0);
  const view = engine.current(ctx);
  assert.equal(view[0].role, 'compactionSummary');
  const history = JSON.stringify(view.find((message) => message.customType === 'backtrack:history'));
  assert.match(history, /Retained native user/);
  assert.match(history, /Retained native reply/);
});

test('legacy captured external prefixes are matched by occurrence without modifying saved blocks', () => {
  const { sm, ctx, engine } = fixture();
  sm.appendMessage({ role: 'user', content: 'Task', timestamp: 1 });
  const { cursor, ...old } = engine.sync(ctx);
  const prefix = { role: 'custom', customType: 'external', content: 'LEGACY_PREFIX', display: false, timestamp: 0 };
  const blocks = [sm.appendCustomEntry(BLOCK, { message: prefix }), sm.appendCustomEntry(BLOCK, { message: prefix })];
  const legacy = sm.appendCustomEntry(STATE, { ...old, view: [...blocks, ...old.view], revision: 'old', inputKeys: [] });
  const record = structuredClone(sm.getEntry(legacy));
  const input = () => [prefix, prefix, ...buildSessionContext(sm.getBranch()).messages];
  const check = () => {
    const view = engine.project(ctx, input());
    assert.deepEqual(view.slice(0, 2), [prefix, prefix]);
    assert.equal(view.filter(m => m.content === 'LEGACY_PREFIX').length, 2);
    assert.deepEqual(sm.getEntry(legacy), record);
  };
  check(); check();
  apply(engine, ctx, sm, 0);
  check();
  assert.deepEqual(latestState(ctx).view.slice(0, 2), blocks);
});

test('tool-only discarded intervals do not inject or persist an empty history block', () => {
  const { sm, ctx, engine } = fixture();
  sm.appendMessage({ role: 'user', content: 'Task', timestamp: 1 });
  const state = engine.sync(ctx);
  const assistantId = sm.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'bt', name: 'backtrack', arguments: {} }], timestamp: 2 });
  sm.appendMessage({ role: 'toolResult', toolCallId: 'bt', toolName: 'backtrack', content: [], timestamp: 3 });
  engine.apply(ctx, { id: 'tx', callId: 'bt', assistantId, epoch: state.epoch, target: 1, message: 'Next action.' });
  assert.equal(engine.current(ctx).some(m => m.customType === 'backtrack:history'), false);
  assert.equal(sm.getBranch().some(e => e.customType === BLOCK && e.data.message.customType === 'backtrack:history'), false);
  assert.equal(engine.current(ctx).find(m => m.customType === 'backtrack:continuation').content,
    '[Backtrack message — agent handoff]\nNext action.');
});

test('compact excludes regenerable skill directories but retains skill reads and task handoff', () => {
  const { sm, ctx, engine } = fixture();
  sm.appendMessage({ role: 'user', content: 'Task', timestamp: 1 });
  const state = engine.sync(ctx);
  const directory = sm.appendCustomEntry(BLOCK, { message: { role: 'custom', customType: DYNAMIC_CONTEXT,
    content: 'REGENERABLE_DIRECTORY', display: false, timestamp: 0 } });
  sm.appendCustomEntry(STATE, { ...state, view: [state.view[0], directory, ...state.view.slice(1)] });
  apply(engine, ctx, sm, 1);
  toolRound(sm, 'read', 'skill-read');
  const before = engine.sync(ctx);
  assert.match(JSON.stringify(engine.current(ctx)), /REGENERABLE_DIRECTORY/);
  const event = { preparation: {} };
  engine.prepareCompact(event, ctx);
  const body = JSON.stringify(event.preparation.messagesToSummarize);
  assert.doesNotMatch(body, /REGENERABLE_DIRECTORY|backtrack:checkpoint/);
  assert.match(body, /Continuation bt/);
  assert.match(body, /TOOL_DATA/);
  assert.deepEqual(engine.sync(ctx), before, 'preparing compact does not edit the retained view');
});

test('recovery notice requires a committed view and is not resurrected after compact', () => {
  const { sm, pi, ctx, engine } = fixture();
  sm.appendMessage({ role: 'user', content: 'Task', timestamp: 1 });
  engine.sync(ctx);
  const append = pi.appendEntry;
  pi.appendEntry = (type, data) => {
    if (type === STATE && data.view.some(id => sm.getEntry(id)?.data?.message?.customType === 'backtrack:commit-failed')) {
      throw new Error('recovery state write failed');
    }
    append(type, data);
  };
  assert.throws(() => engine.recoverFailure(ctx, 'tx', 'original failure'), /recovery state write failed/);
  assert.equal(engine.current(ctx).some(m => m.customType === 'backtrack:commit-failed'), false);
  pi.appendEntry = append;
  engine.recoverFailure(ctx, 'tx', 'original failure');
  const leaf = sm.getLeafId();
  engine.recoverFailure(ctx, 'tx', 'original failure');
  assert.equal(sm.getLeafId(), leaf);
  assert.equal(engine.current(ctx).filter(m => m.customType === 'backtrack:commit-failed').length, 1);
  const event = { preparation: {} };
  engine.prepareCompact(event, ctx);
  assert.match(JSON.stringify(event.preparation.messagesToSummarize), /original failure/);
  sm.appendCompaction('Summary includes the failure.', event.preparation.firstKeptEntryId, 1000);
  engine.sync(ctx);
  engine.recoverFailure(ctx, 'tx', 'original failure');
  assert.equal(engine.current(ctx).some(m => m.customType === 'backtrack:commit-failed'), false);
});

test('checkpoint labels stay concise and estimates do not discard external injections', () => {
  const { sm, ctx, engine } = fixture();
  sm.appendMessage({ role: 'user', content: 'Task', timestamp: 1 });
  const input = [{ role: 'custom', customType: 'external', content: '中'.repeat(20000), display: false, timestamp: 0 },
    ...buildSessionContext(sm.getBranch()).messages];
  const view = engine.project(ctx, input);
  const marker = view.find(m => m.customType === 'backtrack:checkpoint' && m.details.id === 1);
  assert.match(marker.content, /^\[checkpoint 1 \| context [\d.]+K?\/[\d.]+K? \d+%\]$/);
  assert.doesNotMatch(marker.content, /managed|~/);
  assert.equal(marker.details.accuracy, 'estimated');
  const before = marker.content;
  assert.equal(engine.project(ctx, input).find(m => m.customType === 'backtrack:checkpoint' && m.details.id === 1).content, before);
  assert.equal(view[0].content, input[0].content, 'scope labeling does not discard external injections');
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
