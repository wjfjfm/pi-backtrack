import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { historyBetween, renderHistory } from '../dist/history.js';

test('custom goal messages are folded as user input regardless of UI visibility', () => {
  const sm = SessionManager.inMemory('/');
  const first = sm.appendCustomMessageEntry('pi-goal', 'goal set: finish task', true);
  sm.appendMessage({role:'assistant',content:[{type:'text',text:'working'}],timestamp:1});
  const last = sm.appendCustomMessageEntry('pi-goal', 'goal still active: finish task', false);
  const rows = historyBetween(sm.getBranch(), null, last);
  assert.deepEqual(rows.map(r=>[r.role,r.text,r.turn]), [
    ['user','goal set: finish task',first], ['assistant','working',first],
    ['user','goal still active: finish task',last],
  ]);
  const text = renderHistory(rows).content.filter(p=>p.type==='text').map(p=>p.text).join('');
  assert.match(text,/user: goal set: finish task/);
  assert.match(text,/user: goal still active: finish task/);
  assert.deepEqual(historyBetween(sm.getBranch(),first,last).map(r=>r.text),['working','goal still active: finish task']);
});

test('all backtrack internal messages and custom state entries remain excluded', () => {
  const sm = SessionManager.inMemory('/');
  sm.appendCustomEntry('pi-goal-state', {text:'STATE_ONLY'});
  for (const type of ['history','checkpoint','baseline','boundary','continuation']) {
    sm.appendCustomMessageEntry(`backtrack:${type}`, `INTERNAL_${type}`, true);
  }
  const end = sm.appendCustomMessageEntry('another-extension', 'VISIBLE_TO_MODEL', false);
  const rows = historyBetween(sm.getBranch(),null,end);
  assert.equal(rows.length,1);
  assert.equal(rows[0].text,'VISIBLE_TO_MODEL');
});

test('custom message images retain their original positions and pure images survive', () => {
  const sm=SessionManager.inMemory('/');
  const image={type:'image',data:'AA==',mimeType:'image/png'};
  const content=[{type:'text',text:'before'},image,{type:'text',text:'after'}];
  const first=sm.appendCustomMessageEntry('extension-image',content,false);
  const folded=renderHistory(historyBetween(sm.getBranch(),null,first));
  assert.deepEqual(folded.content,[{type:'text',text:'user: '},...content,{type:'text',text:'\n'}]);
  const last=sm.appendCustomMessageEntry('extension-image',[image],false);
  assert.deepEqual(historyBetween(sm.getBranch(),first,last)[0].images,[image]);
});
