import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { historyBetween, renderHistory } from '../dist/history.js';
import { estimateText, estimateMessages, excerpt, formatCount, graphemes } from '../dist/tokens.js';
import { backtrackParameters, validateArguments } from '../dist/schema.js';
import { backtrackDescription } from '../dist/tool-description.js';
const plain = (message) => message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
const row = (id, role, text, turn = id, images = []) => ({ id, role, text, turn, images });

test('strict arguments reject old schemas, unsafe IDs, fractions and blank continuation', () => {
  for (const args of [null, {}, { checkpoint: -1, message: 'x' }, { checkpoint: 0.5, message: 'x' },
    { checkpoint: Number.MAX_SAFE_INTEGER + 1, message: 'x' }, { checkpoint: 0, message: ' ' },
    { checkpoint: 0, message: 'x', knowledge: 'old' }]) assert.throws(() => validateArguments(args));
  assert.doesNotThrow(() => validateArguments({ checkpoint: 0, message: 'Continue' }));
});

test('tool parameters describe an intact prefix and a checkpoint-relative work handoff', () => {
  assert.deepEqual(Object.keys(backtrackParameters.properties), ['checkpoint', 'message']);
  assert.match(backtrackParameters.properties.checkpoint.description, /Context through this checkpoint is preserved intact/);
  assert.doesNotMatch(backtrackDescription, /managed|request-local|provider|hard limits|minimums to fill|if enabled/);
  assert.match(backtrackDescription, /0-20%.*short tasks, 0-40%.*standard tasks, and 0-80%.*difficult tasks/);
  assert.match(backtrackDescription, /user clearly changes topics/);
  assert.match(backtrackDescription, /returning to the main task/);
  const handoff = backtrackParameters.properties.message.description;
  for (const phrase of ['after the target checkpoint', 'what you did', 'what you examined', 'what you learned',
    'failed attempts and their lessons', 'what you plan to do next']) assert.ok(handoff.includes(phrase));
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

test('omitted source messages lose their images and count as omitted turns', () => {
  const image = { type: 'image', data: 'AA==', mimeType: 'image/png' };
  const messages = [row('a', 'user', 'ancient '.repeat(100)), row('b', 'assistant', 'old answer', 'a'),
    row('c', 'user', 'old image caption '.repeat(100), 'c', [image]), row('d', 'user', 'Latest user')];
  const output = renderHistory(messages, [{ budget: 1, edge: Infinity }]);
  assert.match(plain(output), /^\[2 turns omitted\]/);
  assert.doesNotMatch(plain(output), /old image caption|user: \[\d+ tokens omitted\]/);
  assert.match(plain(output), /user: Latest user/);
  assert.deepEqual(output.content.filter((part) => part.type === 'image'), []);
});

test('excerpts lose images, while intact messages in any tier and the latest user keep them', () => {
  const image = data => ({ type: 'image', data, mimeType: 'image/png' });
  const messages = [row('short', 'user', 'brief', 'short', [image('intact')]),
    row('long', 'user', 'Long caption '.repeat(500), 'long', [image('truncated')]),
    row('last', 'user', 'Latest caption '.repeat(100), 'last', [image('latest')])];
  const output = renderHistory(messages, [{ budget: 1, edge: Infinity }, { budget: 200, edge: 10 }]);
  assert.match(plain(output), /tokens omitted/);
  assert.ok(plain(output).includes(messages[2].text));
  assert.deepEqual(output.content.filter(p => p.type === 'image').map(p => p.data), ['intact', 'latest']);
});

test('intact user content preserves interleaved image positions and pure-image input', () => {
  const sm = SessionManager.inMemory('/');
  const a = { type: 'image', data: 'A', mimeType: 'image/png' };
  const b = { type: 'image', data: 'B', mimeType: 'image/png' };
  const parts = [{ type: 'text', text: 'Below:' }, a, { type: 'text', text: 'Above is A, below is B:' }, b];
  const id = sm.appendMessage({ role: 'user', content: parts, timestamp: 1 });
  const output = renderHistory(historyBetween(sm.getBranch(), null, id), [{ budget: 1, edge: Infinity }]);
  assert.deepEqual(output.content, [{ type: 'text', text: 'user: ' }, ...parts, { type: 'text', text: '\n' }]);
  const pure = sm.appendMessage({ role: 'user', content: [b], timestamp: 2 });
  const pureOutput = renderHistory(historyBetween(sm.getBranch(), id, pure), [{ budget: 0, edge: Infinity }]);
  assert.deepEqual(pureOutput.content.filter(p => p.type === 'image'), [b]);
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
