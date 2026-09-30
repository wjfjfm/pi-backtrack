import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateTokens } from '@earendil-works/pi-coding-agent';
import { checkpointTokens, estimateAfterFold, estimateRequestTokens } from '../dist/usage.js';
const msg = content => ({ role: 'user', content, timestamp: 1 });
const point = (tokens, boundary = 'prefix') => ({ id: 1, boundary, historyBoundary: boundary, tokens,
  marker: { role: 'custom', customType: 'backtrack:checkpoint', content: 'backtrack-checkpoint 1 context 18.2K/272K 7%', display: false, timestamp: 0 } });
const unavailable = new Proxy({}, { get() { throw Error('Known baseline must not re-estimate system or tools'); } });

test('known checkpoint adds only replacement and retained tail, ignoring old assistant usage', () => {
  const target = point(18234);
  const replacement = msg('summary and handoff');
  const tail = { role: 'assistant', content: [{ type: 'text', text: 'retained tail' }], usage: { input: 999999 } };
  const nodes = [{ id: 'prefix', message: msg('large prefix'.repeat(10000)) }, { id: 'fold', message: replacement }, { id: 'tail', message: tail }];
  assert.equal(estimateAfterFold(nodes, target, [target], unavailable, unavailable), 18234 + estimateTokens(replacement) + estimateTokens(tail));
});

test('unknown/zero checkpoint falls back to visible messages, system and active tools only', () => {
  const target = point(null, null), message = msg('handoff');
  const active = { name: 'read', description: 'Read', parameters: { type: 'object' } };
  const ctx = { getSystemPrompt: () => 'SYSTEM' };
  const pi = { getActiveTools: () => ['read'], getAllTools: () => [active, { name: 'disabled', description: 'X'.repeat(10000) }] };
  const expected = Math.ceil(('SYSTEM'.length + JSON.stringify([active]).length) / 4) + estimateTokens(message) + estimateTokens(target.marker);
  assert.equal(estimateAfterFold([{ id: 'fold', message }], target, [target], ctx, pi), expected);
});

test('request recheck includes system and active tools without trusting or mutating saved usage', () => {
  const message = { role: 'assistant', content: [{ type: 'text', text: 'retained answer' }], timestamp: 1,
    usage: { input: 999999, output: 10 }, stopReason: 'stop' };
  const before = structuredClone(message);
  const tool = { name: 'read', description: 'Read', parameters: { type: 'object' } };
  const ctx = { getSystemPrompt: () => 'SYSTEM' };
  const pi = { getActiveTools: () => ['read'], getAllTools: () => [tool, { name: 'disabled', description: 'X'.repeat(10000) }] };
  assert.equal(estimateRequestTokens([message], ctx, pi), Math.ceil(('SYSTEM'.length + JSON.stringify([tool]).length) / 4) + estimateTokens(message));
  assert.deepEqual(message, before);
});

test('legacy formatted checkpoints remain usable, explicit unknown stays unknown', () => {
  assert.equal(checkpointTokens(point(undefined)), 18200);
  assert.equal(checkpointTokens(point(18234)), 18234);
  assert.equal(checkpointTokens(point(null)), null);
  const old = point(undefined); old.marker.content = 'backtrack-checkpoint 0 context unknown';
  assert.equal(checkpointTokens(old), null);
});
