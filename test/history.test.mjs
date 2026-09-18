import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { historyBetween, renderHistory } from '../dist/history.js';
import { estimateText, estimateMessages, excerpt, formatCount, graphemes } from '../dist/tokens.js';
import { validateArguments } from '../dist/schema.js';
const plain = (message) => message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
const row = (id, role, text, turn = id, images = []) => ({ id, role, text, turn, images });

test('strict arguments reject old schemas, unsafe IDs, fractions and blank continuation', () => {
  for (const args of [null, {}, { checkpoint: -1, message: 'x' }, { checkpoint: 0.5, message: 'x' },
    { checkpoint: Number.MAX_SAFE_INTEGER + 1, message: 'x' }, { checkpoint: 0, message: ' ' },
    { checkpoint: 0, message: 'x', knowledge: 'old' }]) assert.throws(() => validateArguments(args));
  assert.doesNotThrow(() => validateArguments({ checkpoint: 0, message: 'Continue' }));
});

test('classified token estimates and omission formatting preserve grapheme boundaries', () => {
  assert.equal(estimateText('abcd'), 1);
  assert.equal(estimateText('中文'), 3);
  assert.equal(estimateText('!?'), 2);
  assert.equal(estimateMessages([{ role: 'bashExecution', command: 'private', output: 'hidden'.repeat(100), excludeFromContext: true, timestamp: 0 }]), 0);
  assert.equal(formatCount(2000), '2000');
  assert.equal(formatCount(2400), '2.4K');
  assert.equal(formatCount(10000), '10K');
  assert.equal(excerpt('short', 100), 'short');
  const original = '👨‍👩‍👧‍👦汉字e\u0301'.repeat(100);
  const value = excerpt(original, 20);
  assert.match(value, /\[\d+(\.\d+)?K? tokens omitted\]/);
  const [start, end] = value.split(/\[[^\]]+\]/);
  assert.ok(original.startsWith(start));
  assert.ok(original.endsWith(end));
  assert.ok(graphemes(start).every((segment) => graphemes(original).includes(segment)));
  assert.ok(graphemes(end).every((segment) => graphemes(original).includes(segment)));
});

test('raw history includes nested backtracks, not their injected history or tool artifacts', () => {
  const sm = SessionManager.inMemory('/');
  const before = sm.appendCustomEntry('checkpoint', { id: 0 });
  sm.appendMessage({ role: 'user', content: 'same text', timestamp: 1 });
  sm.appendMessage({ role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE' }, { type: 'text', text: 'answer' }, { type: 'toolCall', name: 'bash', id: 'x', arguments: {} }], timestamp: 2 });
  sm.appendMessage({ role: 'toolResult', toolCallId: 'x', toolName: 'bash', content: [{ type: 'text', text: 'SECRET' }], isError: false, timestamp: 3 });
  sm.appendCustomMessageEntry('backtrack:history', 'DO NOT NEST', false);
  sm.appendCustomEntry('backtrack:state:v1', {});
  const end = sm.appendMessage({ role: 'user', content: 'same text', timestamp: 4 });
  sm.appendMessage({ role: 'user', content: 'OUTSIDE', timestamp: 5 });
  const result = historyBetween(sm.getBranch(), before, end);
  assert.deepEqual(result.map((item) => item.text), ['same text', 'answer', 'same text']);
  const output = plain(renderHistory(result));
  assert.equal((output.match(/same text/g) ?? []).length, 2);
  assert.doesNotMatch(output, /PRIVATE|SECRET|DO NOT NEST|OUTSIDE/);
  assert.throws(() => historyBetween(sm.getBranch(), 'invalid', end));
});

test('whole messages downgrade, older messages never backfill; last user is always complete', () => {
  const long = 'newest user '.repeat(1000);
  const messages = [row('old', 'user', 'ancient '.repeat(100)), row('a', 'assistant', 'response '.repeat(100), 'old'),
    row('last', 'user', long), row('b', 'assistant', 'L'.repeat(1000), 'last')];
  const output = plain(renderHistory(messages, [{ budget: 30, edge: Infinity }, { budget: 50, edge: 10 }, { budget: 30, edge: 2 }]));
  assert.ok(output.includes(`user: ${long}\n`));
  assert.match(output, /assistant: L+\[\d+ tokens omitted\]L+/);
  assert.equal((output.match(/user: newest user/g) ?? []).length, 1);
  assert.ok(output.indexOf('user: newest') < output.indexOf('assistant: L'));
});

test('omits complete old turns, retains all user images even when their text is omitted', () => {
  const image = { type: 'image', data: 'AA==', mimeType: 'image/png' };
  const messages = [row('a', 'user', 'ancient '.repeat(100)), row('b', 'assistant', 'old answer', 'a'),
    row('c', 'user', 'old image caption '.repeat(100), 'c', [image]), row('d', 'user', 'Latest user')];
  const output = renderHistory(messages, [{ budget: 1, edge: Infinity }]);
  assert.match(plain(output), /^\[1 turns omitted\]/);
  assert.match(plain(output), /user: \[\d+ tokens omitted\]/);
  assert.match(plain(output), /user: Latest user/);
  assert.deepEqual(output.content.filter((part) => part.type === 'image'), [image]);
});

test('source extraction preserves pure-image user messages and rejects unsupported user content', () => {
  const sm = SessionManager.inMemory('/');
  const image = { type: 'image', data: 'AA==', mimeType: 'image/png' };
  const id = sm.appendMessage({ role: 'user', content: [image], timestamp: 0 });
  const result = historyBetween(sm.getBranch(), null, id);
  assert.deepEqual(result[0].images, [image]);
  const invalid = sm.appendMessage({ role: 'user', content: [{ type: 'audio', data: 'bad' }], timestamp: 1 });
  assert.throws(() => historyBetween(sm.getBranch(), null, invalid), /content type/);
});
