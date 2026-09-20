import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { createEventBus, SessionManager, buildSessionContext, initTheme, ToolExecutionComponent } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import extension from '../dist/index.js';
import { BacktrackRenderer, boundaryLocation } from '../dist/render.js';
import { REQUEST, STATE, CANCELLED } from '../dist/contracts.js';

initTheme('dark', false);
const theme = { fg: (_color, text) => text, bold: (text) => text };
const context = (args, expanded = false) => ({ args, toolCallId: 'bt', expanded, invalidate() {}, isError: false });
const output = (component, width = 100) => component.render(width).map((line) => stripVTControlCharacters(line).trimEnd()).join('\n');
const message = (id, role, content, extra = {}) => ({ id, type: 'message', message: { role, content, ...extra } });

test('boundary labels identify user, context start, compaction and the whole tool batch', () => {
  const branch = [message('u', 'user', 'Investigate\ncontext'), message('a', 'assistant', [
    { type: 'toolCall', name: 'read', arguments: { path: 'src/index.ts' } },
    { type: 'toolCall', name: 'bash', arguments: { command: 'npm test' } },
    { type: 'toolCall', name: 'edit', arguments: { path: 'src/engine.ts' } },
  ]), message('r1', 'toolResult', []), message('r2', 'toolResult', []), message('r3', 'toolResult', [])];
  assert.deepEqual(boundaryLocation(branch, 'u', 1), ['after user: Investigate context']);
  assert.deepEqual(boundaryLocation(branch, 'r3', 2), ['read src/index.ts', 'bash npm test', 'edit src/engine.ts']);
  assert.deepEqual(boundaryLocation(branch, null, 0), ['context start']);
  assert.deepEqual(boundaryLocation([{ id: 'c', type: 'compaction' }], 'c', 1), ['after compaction']);
  assert.deepEqual(boundaryLocation(branch, 'missing', 3), []);
});

test('native-style call preview, full expansion, partial arguments and narrow terminals', () => {
  const renderer = new BacktrackRenderer();
  const sm = SessionManager.inMemory('/');
  const args = { checkpoint: 3, message: Array.from({ length: 14 }, (_, i) => `交接 ${i}`).join('\n') };
  sm.appendCustomEntry(REQUEST, { id: 'tx', callId: 'bt', target: 3, location: ['read a', 'bash npm test', 'write b'] });
  renderer.refresh({ sessionManager: sm });
  const collapsed = output(renderer.renderCall(args, theme, context(args)));
  assert.match(collapsed, /backtrack checkpoint 3 · after tools: read a, bash npm test \(\+1\)/);
  assert.match(collapsed, /4 lines omitted/);
  assert.match(collapsed, /交接 0\n交接 1\n交接 2\n交接 3\n交接 4/);
  assert.match(collapsed, /交接 9\n交接 10\n交接 11\n交接 12\n交接 13/);
  assert.doesNotMatch(collapsed, /交接 [5-8](?:\n|$)/);
  const expanded = output(renderer.renderCall(args, theme, context(args, true)));
  assert.match(expanded, /after tools:\n  read a\n  bash npm test\n  write b/);
  assert.match(expanded, /交接 5\n交接 6\n交接 7\n交接 8/);
  assert.match(expanded, /交接 13/);
  assert.doesNotMatch(expanded, /lines omitted/);
  assert.doesNotThrow(() => renderer.renderCall({}, theme, context({})));
  for (const width of [12, 40, 100]) {
    const lines = renderer.renderCall(args, theme, context(args, true)).render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
});

test('message preview preserves short handoffs and folds only the middle above ten lines', () => {
  const renderer = new BacktrackRenderer();
  for (const count of [1, 10, 11]) {
    const lines = Array.from({ length: count }, (_, i) => `line-${i}`);
    const args = { checkpoint: 1, message: lines.join('\n') };
    const preview = output(renderer.renderCall(args, theme, context(args)));
    if (count <= 10) {
      assert.ok(preview.includes(args.message));
      assert.doesNotMatch(preview, /lines omitted/);
    } else {
      assert.match(preview, /1 line omitted/);
      assert.ok(!preview.split('\n').includes('line-5'));
      assert.ok(preview.includes(lines.slice(-5).join('\n')));
    }
    assert.ok(output(renderer.renderCall(args, theme, context(args, true))).includes(args.message));
  }
});

test('transaction display restores committed, cancelled, failed and legacy states without writing history', () => {
  for (const status of ['applied', 'cancelled', 'failed', 'legacy']) {
    const sm = SessionManager.inMemory('/');
    sm.appendCustomEntry(REQUEST, { id: 'tx', callId: 'bt', target: 1 });
    if (status === 'applied' || status === 'legacy') sm.appendCustomEntry(STATE, {
      lastTransaction: 'tx', ...(status === 'applied' ? { usage: { before: 80900, after: 18200, window: 272000 } } : {}),
    });
    else sm.appendCustomEntry(CANCELLED, { id: 'tx', reason: 'injected', ...(status === 'failed' ? { phase: 'commit-failed' } : {}) });
    const count = sm.getEntries().length;
    const renderer = new BacktrackRenderer();
    renderer.refresh({ sessionManager: sm });
    const result = output(renderer.renderResult({ content: [] }, {}, theme, context({})));
    assert.match(result, status === 'applied' ? /context 80.9K → 18.2K \/ 272K \(7%\) · estimated/
      : status === 'legacy' ? /Applied; context usage unavailable/
        : status === 'failed' ? /Commit incomplete; partial changes may remain/ : /Not applied/);
    assert.equal(sm.getEntries().length, count);
    renderer.clear();
  }
});

test('empty error results never display prepared or success', () => {
  const renderer = new BacktrackRenderer();
  const result = renderer.renderResult({ content: [] }, {}, theme, { ...context({}), isError: true });
  assert.match(output(result), /Backtrack failed/);
  assert.doesNotMatch(output(result), /Prepared/);
});

test('real Pi tool component redraws the same row on commit and restores it from session records', () => {
  const sm = SessionManager.inMemory('/');
  const renderer = new BacktrackRenderer();
  const args = { checkpoint: 2, message: 'Continue with the implementation.' };
  let renders = 0;
  const definition = { renderCall: renderer.renderCall, renderResult: renderer.renderResult };
  const row = new ToolExecutionComponent('backtrack', 'bt', args, {}, definition, { requestRender() { renders++; } }, '/');
  sm.appendCustomEntry(REQUEST, { id: 'tx', callId: 'bt', target: 2, location: ['read src/engine.ts'] });
  renderer.refresh({ sessionManager: sm });
  row.updateResult({ content: [], isError: false });
  assert.match(output(row), /Prepared/);
  sm.appendCustomEntry(STATE, { lastTransaction: 'tx', usage: { before: 10000, after: 5000, window: 100000 } });
  renderer.refresh({ sessionManager: sm });
  assert.match(output(row), /context 10K → 5K/);
  assert.doesNotMatch(output(row), /Prepared/);
  assert.ok(renders >= 2);
  const restored = new BacktrackRenderer();
  restored.refresh({ sessionManager: sm });
  const restoredRow = new ToolExecutionComponent('backtrack', 'bt', args, {},
    { renderCall: restored.renderCall, renderResult: restored.renderResult }, { requestRender() {} }, '/');
  restoredRow.updateResult({ content: [], isError: false });
  assert.equal(output(restoredRow), output(row));
});

test('same live tool row changes from prepared to committed; UI errors cannot fail commit', async () => {
  const sm = SessionManager.inMemory('/');
  const hooks = new Map();
  let tool, redraws = 0;
  const pi = {
    events: createEventBus(), on: (name, fn) => hooks.set(name, fn),
    registerTool: (definition) => { tool = definition; }, getAllTools: () => [],
    appendEntry: (type, data) => sm.appendCustomEntry(type, structuredClone(data)),
  };
  const ctx = { sessionManager: sm, getSystemPrompt: () => 'system', model: { contextWindow: 100000 }, hasPendingMessages: () => false };
  extension(pi);
  sm.appendMessage({ role: 'user', content: 'Investigate', timestamp: 1 });
  hooks.get('context')({ messages: buildSessionContext(sm.getBranch()).messages }, ctx);
  const args = { checkpoint: 1, message: 'Carry this handoff exactly.' };
  sm.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', name: 'backtrack', id: 'bt', arguments: args }], timestamp: 2 });
  const rc = { ...context(args), invalidate() { redraws++; throw new Error('detached UI'); } };
  tool.renderCall(args, theme, rc);
  const prepared = await tool.execute('bt', args, undefined, undefined, ctx);
  assert.match(output(tool.renderResult(prepared, {}, theme, rc)), /Prepared/);
  assert.match(output(tool.renderCall(args, theme, rc)), /after user: Investigate/);
  const result = { ...prepared, role: 'toolResult', toolName: 'backtrack', toolCallId: 'bt', isError: false, timestamp: 3 };
  sm.appendMessage(result);
  hooks.get('turn_end')({ toolResults: [result] }, ctx);
  assert.match(output(tool.renderResult(prepared, {}, theme, rc)), /context .* → .*estimated/);
  assert.ok(redraws >= 2);
  const state = sm.getBranch().findLast((entry) => entry.customType === STATE).data;
  assert.ok(state.usage.before > 0 && state.usage.after > 0);
  const projected = hooks.get('context')({ messages: buildSessionContext(sm.getBranch()).messages }, ctx).messages;
  assert.doesNotMatch(JSON.stringify(projected), /waiting for tool batch|· estimated/);
  assert.match(JSON.stringify(projected), /Carry this handoff exactly/);
});
