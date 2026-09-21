import { expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateMessages, formatCount } from '../src/tokens.ts';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { BacktrackEngine, latestState } from '../src/engine.ts';
import { STATE, LEGACY_STATE } from '../src/contracts.ts';
import { validateArguments } from '../src/schema.ts';

function fixture(sm = SessionManager.inMemory('/')) {
  const pi = { appendEntry: (type, data) => sm.appendCustomEntry(type, data), getAllTools: () => [] };
  const ctx = { sessionManager: sm, getSystemPrompt: () => 'system', model: { contextWindow: 100000 } };
  const engine = new BacktrackEngine(pi);
  return { sm, ctx, engine, project: () => engine.project(ctx, sm.buildSessionContext().messages) };
}
const user = (sm, text) => sm.appendMessage({ role: 'user', content: text, timestamp: 1 });
function round(sm, id = 'read') {
  sm.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: {} }], stopReason: 'toolUse', timestamp: 2 });
  return sm.appendMessage({ role: 'toolResult', toolName: 'read', toolCallId: id, content: [{ type: 'text', text: 'SECRET_RESULT' }], timestamp: 3 });
}
function fold(f, args, id = 'fold') {
  f.sm.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'backtrack', arguments: args }], stopReason: 'toolUse', timestamp: 4 });
  const options = f.engine.prepare(f.ctx, id, args);
  f.sm.appendBacktrackBatch([{ role: 'toolResult', toolCallId: id, toolName: 'backtrack', content: [{ type: 'text', text: 'Backtrack applied.' }], timestamp: 5 }], options);
  return f.engine.sync(f.ctx);
}

test('native metadata only; markers are idempotent and complete batches are boundaries', () => {
  const f = fixture(); user(f.sm, 'task');
  expect(f.engine.sync(f.ctx).checkpoints.map(c => c.id)).toEqual([0, 1]);
  round(f.sm); const state = f.engine.sync(f.ctx);
  expect(state.checkpoints.map(c => c.id)).toEqual([0, 1, 2]);
  const leaf = f.sm.getLeafId(); const first = f.project();
  expect(f.project()).toEqual(first); expect(f.sm.getLeafId()).toBe(leaf);
  expect(state).not.toHaveProperty('view');
  expect(f.sm.buildSessionContext().messages.some(m => m.customType === 'backtrack:checkpoint')).toBe(false);
});

test('default native fold preserves prefix and original handoff; repeated zero resets epoch', () => {
  const f = fixture(); f.sm.appendCustomMessageEntry('external', 'stable prefix', false);
  user(f.sm, 'task'); f.project(); round(f.sm); f.project();
  const before = latestState(f.ctx);
  let state = fold(f, { checkpoint: 1, message: 'Continue exactly' });
  expect(state.checkpoints.map(c => c.id)).toEqual([0, 1, 3]);
  let messages = f.sm.buildSessionContext().messages;
  expect(JSON.stringify(messages)).not.toContain('SECRET_RESULT');
  expect(messages.find(m => m.customType === 'backtrack:continuation').content).toBe('[Backtrack message — agent handoff]\nContinue exactly');
  expect(f.sm.getBranch().some(e => e.type === 'backtrack')).toBe(true);
  state = fold(f, { checkpoint: 0, message: 'next' }, 'second');
  expect(state.epoch).not.toBe(before.epoch); expect(state.checkpoints.map(c => c.id)).toEqual([0, 1]);
  messages = f.sm.buildSessionContext().messages;
  expect(messages[0].content).toBe('stable prefix');
  expect(JSON.stringify(messages)).not.toContain('Continue exactly');
});

for (const checkpoint of [0, 1]) test(`keep_after preserves raw tail and numbering including checkpoint=${checkpoint}`, () => {
  const f = fixture(); user(f.sm, 'task'); f.project(); round(f.sm, 'discard'); f.project();
  user(f.sm, 'recent task'); f.project(); round(f.sm, 'retain'); f.project();
  const before = latestState(f.ctx);
  const state = fold(f, { checkpoint, keep_after_checkpoint: 2, message: 'UNIQUE_HANDOFF' });
  expect(state.epoch).toBe(before.epoch);
  expect(state.checkpoints.map(c => c.id)).toEqual(checkpoint === 0 ? [0, 3, 4, 5] : [0, 1, 3, 4, 5]);
  const messages = f.sm.buildSessionContext().messages;
  expect(messages.some(m => m.customType === 'backtrack:continuation')).toBe(false);
  expect(JSON.stringify(messages).match(/UNIQUE_HANDOFF/g)).toHaveLength(1);
  expect(messages.filter(m => m.role === 'toolResult').map(m => m.toolCallId)).toEqual(['retain', 'fold']);
  expect(Boolean(messages.find(m => m.customType === 'backtrack:history'))).toBe(checkpoint === 0);
  expect(() => f.engine.validate(f.ctx, 2)).toThrow(/not active/);
  expect(f.project().filter(m => m.customType === 'backtrack:checkpoint').map(m => m.details.id)).toEqual(state.checkpoints.map(c => c.id));
  expect(f.project()).toEqual(f.project());
});

test('native observers append context once, continuation marker and usage finalize once', () => {
  const f = fixture(); user(f.sm, 'task'); f.project();
  // Commit without the next context pass, then emulate an independent lifecycle observer.
  f.sm.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'fold', name: 'backtrack', arguments: {} }], stopReason: 'toolUse', timestamp: 4 });
  f.sm.appendBacktrackBatch([{ role: 'toolResult', toolCallId: 'fold', toolName: 'backtrack', content: [], timestamp: 5 }], f.engine.prepare(f.ctx, 'fold', { checkpoint: 0, message: 'next' }));
  f.sm.appendCustomMessageEntry('unrelated', 'observer description', false);
  const state = f.engine.sync(f.ctx), leaf = f.sm.getLeafId();
  expect(f.engine.sync(f.ctx)).toEqual(state); expect(f.sm.getLeafId()).toBe(leaf);
  expect(f.project().filter(m => m.content === 'observer description')).toHaveLength(1);
});

test('recovery anchors continuation before a later user rather than duplicating its checkpoint', () => {
  const f = fixture(); user(f.sm, 'original'); f.project();
  f.sm.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'fold', name: 'backtrack', arguments: {} }], stopReason: 'toolUse', timestamp: 4 });
  const reduction = f.sm.appendBacktrackBatch([{ role: 'toolResult', toolCallId: 'fold', toolName: 'backtrack', content: [], timestamp: 5 }], f.engine.prepare(f.ctx, 'fold', { checkpoint: 0, message: 'next' }));
  const observer = f.sm.appendCustomMessageEntry('unrelated', 'observer', false);
  const later = user(f.sm, 'later user');
  const restored = fixture(f.sm);
  const state = restored.engine.sync(restored.ctx);
  expect(state.checkpoints.map(c => [c.id, c.boundary])).toEqual([[0, null], [1, observer], [2, later]]);
  expect(state.checkpoints[1].historyBoundary).toBe(reduction);
  expect(restored.engine.sync(restored.ctx)).toEqual(state);
});

test('foreign native folds reset metadata from effective context, including empty replacements', () => {
  const f = fixture(); user(f.sm, 'hidden'); f.project();
  const epoch = latestState(f.ctx).epoch;
  f.sm.appendBacktrack(null, []);
  const state = f.engine.sync(f.ctx);
  expect(state.epoch).not.toBe(epoch);
  expect(state.checkpoints.map(c => c.id)).toEqual([0]);
  expect(f.engine.sync(f.ctx)).toEqual(state);
  user(f.sm, 'new');
  expect(f.engine.sync(f.ctx).checkpoints.map(c => c.id)).toEqual([0, 1]);
});

test('native compact rebuilds checkpoint epoch without overriding compaction preparation', () => {
  const f = fixture(); const first = user(f.sm, 'retained task'); f.project();
  const epoch = latestState(f.ctx).epoch;
  f.sm.appendCompaction('native summary', first, 1000);
  const state = f.engine.sync(f.ctx); expect(state.epoch).not.toBe(epoch);
  fold(f, { checkpoint: 0, message: 'continue' });
  const messages = f.sm.buildSessionContext().messages;
  expect(messages[0].role).toBe('compactionSummary');
  expect(JSON.stringify(messages)).toContain('retained task');
});

test('request-local additions are unchanged; duplicate native messages remain distinct', () => {
  const f = fixture(); user(f.sm, 'same'); user(f.sm, 'same');
  const input = [{ role: 'custom', customType: 'external', content: 'local', display: false, timestamp: 0 }, ...f.sm.buildSessionContext().messages];
  const projected = f.engine.project(f.ctx, input);
  expect(projected.filter(m => m.customType !== 'backtrack:checkpoint')).toEqual(input);
  expect(projected.filter(m => m.customType === 'backtrack:checkpoint')).toHaveLength(3);
  expect(JSON.stringify(f.sm.getEntries())).not.toContain('"local"');
});

test('legacy sessions fail closed without rewriting or restoring their raw view', () => {
  const f = fixture(); user(f.sm, 'hidden'); f.sm.appendCustomEntry(LEGACY_STATE, { version: 1, view: [] });
  const before = JSON.stringify(f.sm.getEntries());
  expect(() => f.project()).toThrow(/Legacy backtrack view/);
  expect(JSON.stringify(f.sm.getEntries())).toBe(before);
});

test('assistant-only and failed responses do not allocate checkpoints or restore filtered messages', () => {
  const f = fixture(); user(f.sm, 'task'); f.project();
  f.sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop', timestamp: 2 });
  expect(f.engine.sync(f.ctx).checkpoints.map(c => c.id)).toEqual([0, 1]);
  f.sm.appendMessage({ role: 'assistant', content: [], stopReason: 'error', timestamp: 3 });
  const input = f.sm.buildSessionContext().messages.filter(m => m.role !== 'assistant');
  expect(f.engine.project(f.ctx, input).filter(m => m.customType !== 'backtrack:checkpoint')).toEqual(input);
});

test('tree navigation preserves epoch high-water marks without mutating the source path', () => {
  const f = fixture(); user(f.sm, 'first'); f.project();
  const at = f.sm.getLeafId(), original = JSON.stringify(f.sm.getBranch());
  round(f.sm); f.project(); user(f.sm, 'later'); f.project();
  f.sm.branch(at); user(f.sm, 'alternate');
  expect(f.engine.sync(f.ctx).checkpoints.map(c => c.id)).toEqual([0, 1, 4]);
  expect(JSON.stringify(f.sm.getBranch().slice(0, JSON.parse(original).length))).toBe(original);
});

test('reopen and fork preserve native context and checkpoint metadata without companion state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'checkpoint-fork-'));
  try {
    const f = fixture(SessionManager.create(dir, dir)); user(f.sm, 'task'); f.project();
    round(f.sm); f.project(); fold(f, { checkpoint: 0, message: 'resume' });
    const expected = f.project(), state = latestState(f.ctx);
    const reopened = fixture(SessionManager.open(f.sm.getSessionFile()));
    expect(reopened.project()).toEqual(expected);
    expect(latestState(reopened.ctx)).toEqual(state);
    const fork = fixture(SessionManager.open(reopened.sm.createBranchedSession(reopened.sm.getLeafId())));
    expect(fork.project()).toEqual(expected);
    expect(fork.sm.getSessionId()).not.toBe(f.sm.getSessionId());
    expect(JSON.stringify(fork.sm.getBranch())).toContain('SECRET_RESULT');
    expect(JSON.stringify(expected)).not.toContain('SECRET_RESULT');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mixed default and retained-tail folds re-extract dialogue once without resurrecting tool results', () => {
  const f = fixture(); f.sm.appendCustomMessageEntry('external', 'stable prefix', false);
  user(f.sm, 'original'); f.project(); round(f.sm, 'discard'); f.project();
  user(f.sm, 'recent'); f.project(); round(f.sm, 'retain'); f.project();
  fold(f, { checkpoint: 1, keep_after_checkpoint: 2, message: 'intermediate' });
  fold(f, { checkpoint: 0, message: 'final' }, 'last');
  const messages = f.sm.buildSessionContext().messages, text = JSON.stringify(messages);
  expect(messages[0].content).toBe('stable prefix');
  expect(text).not.toMatch(/SECRET_RESULT|intermediate/);
  expect(text.match(/user: original/g)).toHaveLength(1);
  expect(text.match(/user: recent/g)).toHaveLength(1);
  expect(latestState(f.ctx).checkpoints.map(c => c.id)).toEqual([0, 1]);
});

test('projection is immutable and timestamp-normalized custom anchors survive', () => {
  const f = fixture(); f.sm.appendCustomMessageEntry('external', 'stable prefix', false);
  user(f.sm, 'task'); f.project();
  const input = f.sm.buildSessionContext().messages;
  input[0].timestamp = 123;
  const before = JSON.stringify(f.sm.getEntries());
  const view = f.engine.project(f.ctx, input);
  expect(view.find(m => m.customType === 'backtrack:checkpoint' && m.details.id === 0)).toBeDefined();
  view[0].content = 'mutation'; view.find(m => m.role === 'user').content = 'changed';
  expect(JSON.stringify(f.sm.getEntries())).toBe(before);
  expect(f.project().find(m => m.role === 'user').content).toBe('task');
});

test('tool-only folds omit empty history, and observer usage is estimated from native messages once', () => {
  const f = fixture(); user(f.sm, 'task'); f.project();
  const state = fold(f, { checkpoint: 1, message: 'next' });
  const messages = f.sm.buildSessionContext().messages;
  expect(messages.some(m => m.customType === 'backtrack:history')).toBe(false);
  expect(state.usage.after).toBe(estimateMessages(messages, f.ctx.getSystemPrompt(), '[]'));
  expect(state.checkpoints.at(-1).marker.content).toContain(`context ${formatCount(state.usage.after)}/`);
});

test('invalid suffix or arguments fail before any fold is appended', () => {
  const f = fixture(); user(f.sm, 'task'); f.project();
  f.sm.appendMessage({ role: 'assistant', content: [], timestamp: 2 });
  expect(() => f.engine.prepare(f.ctx, 'fold', { checkpoint: 1, keep_after_checkpoint: 0, message: 'next' })).toThrow(/must follow/);
  expect(() => f.engine.prepare(f.ctx, 'fold', { checkpoint: 0, keep_after_checkpoint: 100, message: 'next' })).toThrow(/not active/);
  for (const keep_after_checkpoint of [-1, 0.5, NaN, Infinity, '2']) expect(() => validateArguments({ checkpoint: 0, message: 'next', keep_after_checkpoint })).toThrow();
  expect(f.sm.getBranch().some(e => e.type === 'backtrack')).toBe(false);
  expect(f.sm.getBranch().filter(e => e.customType === STATE)).toHaveLength(1);
});
