import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { initTheme, ToolExecutionComponent } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { BacktrackRenderer, boundaryLocation } from '../dist/render.js';
import { STATE } from '../dist/contracts.js';

initTheme('dark', false);
const theme = { fg: (_color, text) => text, bold: text => text };
const context = (args, expanded = false) => ({ args, toolCallId: 'bt', expanded, invalidate() {}, isError: false });
const output = (component, width = 100) => component.render(width).map(line => stripVTControlCharacters(line).trimEnd()).join('\n');
const message = (id, role, content, extra = {}) => ({ id, type: 'message', message: { role, content, ...extra } });
const transaction = (location = []) => ({ id: 'tx', type: 'backtrack', details: { kind: 'backtrack:v2', callId: 'bt', target: 3, location } });
const usage = { before: 80900, after: 18200, window: 272000 };
const metadata = () => ({ type: 'custom', customType: STATE, data: { lastTransaction: 'tx', usage } });
const manager = entries => ({ sessionManager: { getBranch: () => entries } });

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

test('native call preview, expansion, retained tail, partial arguments and narrow terminals', () => {
  const renderer = new BacktrackRenderer();
  const args = { checkpoint: 3, keep_after_checkpoint: 5, message: Array.from({ length: 14 }, (_, i) => `交接 ${i}`).join('\n') };
  renderer.refresh(manager([transaction(['read a', 'bash npm test', 'write b'])]));
  const collapsed = output(renderer.renderCall(args, theme, context(args)));
  assert.match(collapsed, /backtrack checkpoint 3 · keep after 5 · after tools: read a, bash npm test \(\+1\)/);
  assert.match(collapsed, /4 lines omitted/);
  assert.match(collapsed, /交接 0\n交接 1\n交接 2\n交接 3\n交接 4/);
  assert.match(collapsed, /交接 9\n交接 10\n交接 11\n交接 12\n交接 13/);
  assert.doesNotMatch(collapsed, /交接 [5-8](?:\n|$)/);
  const expanded = output(renderer.renderCall(args, theme, context(args, true)));
  assert.match(expanded, /after tools:\n  read a\n  bash npm test\n  write b/);
  assert.ok(expanded.includes(args.message));
  assert.doesNotMatch(expanded, /lines omitted/);
  assert.doesNotThrow(() => renderer.renderCall({}, theme, context({})));
  for (const width of [12, 40, 100]) assert.ok(renderer.renderCall(args, theme, context(args, true)).render(width).every(line => visibleWidth(line) <= width));
});

test('message preview preserves short handoffs and folds only the middle above ten lines', () => {
  const renderer = new BacktrackRenderer();
  for (const count of [1, 10, 11]) {
    const lines = Array.from({ length: count }, (_, i) => `line-${i}`);
    const args = { checkpoint: 1, message: lines.join('\n') };
    const preview = output(renderer.renderCall(args, theme, context(args)));
    if (count <= 10) { assert.ok(preview.includes(args.message)); assert.doesNotMatch(preview, /lines omitted/); }
    else { assert.match(preview, /1 line omitted/); assert.ok(!preview.split('\n').includes('line-5')); assert.ok(preview.includes(lines.slice(-5).join('\n'))); }
    assert.ok(output(renderer.renderCall(args, theme, context(args, true))).includes(args.message));
  }
});

test('native transaction display restores usage without mutating entries; errors override success', () => {
  for (const measured of [false, true]) {
    const entries = [transaction(), ...(measured ? [metadata()] : [])], before = JSON.stringify(entries);
    const renderer = new BacktrackRenderer(); renderer.refresh(manager(entries));
    assert.match(output(renderer.renderResult({ content: [] }, {}, theme, context({}))), measured
      ? /context 80.9K → 18.2K \/ 272K \(7%\) · estimated/ : /Applied; context usage unavailable/);
    assert.match(output(renderer.renderResult({ content: [] }, {}, theme, { ...context({}), isError: true })), /Backtrack failed/);
    assert.equal(JSON.stringify(entries), before); renderer.clear();
  }
});

test('real tool row redraws on native commit, restores records and isolates detached UI errors', () => {
  const entries = [], renderer = new BacktrackRenderer();
  const args = { checkpoint: 3, message: 'Continue.' };
  let renders = 0;
  const definition = { renderCall: renderer.renderCall, renderResult: renderer.renderResult };
  const row = new ToolExecutionComponent('backtrack', 'bt', args, {}, definition, { requestRender() { renders++; } }, '/');
  row.updateResult({ content: [], isError: false });
  assert.match(output(row), /Waiting for tool batch/);
  const before = renders;
  entries.push(transaction(['read src/engine.ts']), metadata()); renderer.refresh(manager(entries));
  assert.match(output(row), /context 80.9K → 18.2K/);
  assert.ok(renders > before);
  const restored = new BacktrackRenderer(); restored.refresh(manager(entries));
  const restoredRow = new ToolExecutionComponent('backtrack', 'bt', args, {}, { renderCall: restored.renderCall, renderResult: restored.renderResult }, { requestRender() {} }, '/');
  restoredRow.updateResult({ content: [], isError: false });
  assert.equal(output(restoredRow), output(row));
  renderer.renderCall(args, theme, { ...context(args), invalidate() { throw new Error('detached'); } });
  assert.doesNotThrow(() => renderer.refresh(manager(entries)));
});
