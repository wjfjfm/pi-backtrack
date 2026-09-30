// Public SDK provenance and interval tests; history formatting is tested separately.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {applyFolds,bindSources,sourceNodes} from '../dist/projection.js';
const TYPE='probe:policy';
const key=m=>JSON.stringify(m.role==='custom'?{role:m.role,customType:m.customType,content:m.content,display:m.display,details:m.details}:m);
const source=sm=>sourceNodes(sm.buildSessionProjection().entries);
function project(sm,input=source(sm).map(n=>n.message)) {
 const branch=sm.getBranch();
 const operations=branch.filter(e=>e.type==='custom'&&e.customType===TYPE).map(entry=>({id:entry.id,policy:{
  ...entry.data,messages:[{role:'custom',customType:'probe:replacement',content:entry.data.replacement,display:false,timestamp:1}],
 }}));
 return applyFolds(branch,bindSources(sm.buildSessionProjection().entries,input),operations);
}
const user=(sm,text)=>sm.appendMessage({role:'user',content:text,timestamp:1});
function toolRound(sm,id,text='DUPLICATE_BODY') {
 sm.appendMessage({role:'assistant',content:[{type:'toolCall',id,name:'read',arguments:{path:'probe'}}],timestamp:2,stopReason:'toolUse'});
 return sm.appendMessage({role:'toolResult',toolCallId:id,toolName:'read',content:[{type:'text',text}],timestamp:3});
}
let counter=0;
function fold(sm,anchorId,keepAfterId,replacement='KEY_FINDING') {
 const callId=`fold-${++counter}`;
 const assistantId=sm.appendMessage({role:'assistant',content:[{type:'toolCall',id:callId,name:'backtrack',arguments:{}}],timestamp:4,stopReason:'toolUse'});
 const policyId=sm.appendCustomEntry(TYPE,{anchorId,assistantId,...(keepAfterId?{keepAfterId}:{}),replacement});
 const end=sm.appendMessage({role:'toolResult',toolCallId:callId,toolName:'backtrack',content:[{type:'text',text:'Backtrack applied.'}],timestamp:5});
 return {policyId,end};
}
const ids=nodes=>nodes.map(n=>n.id);
test('identical messages map by occurrence to distinct source IDs; fold only selected interval',()=>{
 const sm=SessionManager.inMemory('/');
 const first=user(sm,'EXACT_DUPLICATE'),anchor=user(sm,'ANCHOR'),hidden=user(sm,'EXACT_DUPLICATE');
 toolRound(sm,'discard');const {policyId}=fold(sm,anchor);
 const later=user(sm,'EXACT_DUPLICATE');
 const input=structuredClone(source(sm).map(n=>n.message));
 assert.equal(key(input[0]),key(input[2]));
 const result=project(sm,input);
 assert.deepEqual(ids(result),[first,anchor,policyId,later]);
 assert.ok(!ids(result).includes(hidden));assert.deepEqual(result[0].message,input[0]);
 assert.equal(result.filter(n=>n.message.content==='EXACT_DUPLICATE').length,2);
});
test('nested folds use effective prefix; raw hidden tools never reappear',()=>{
 const sm=SessionManager.inMemory('/');const anchor=user(sm,'task');toolRound(sm,'hidden-first','FIRST_SECRET');
 const one=fold(sm,anchor,undefined,'FIRST_FINDING');
 const middle=user(sm,'second task');toolRound(sm,'hidden-second','SECOND_SECRET');
 const two=fold(sm,one.policyId,undefined,'SECOND_FINDING');
 assert.deepEqual(ids(project(sm)),[anchor,one.policyId,two.policyId]);
 assert.ok(!JSON.stringify(project(sm)).includes('SECRET'));
 const three=fold(sm,anchor,undefined,'FINAL_FINDING');
 assert.deepEqual(ids(project(sm)),[anchor,three.policyId]);
 assert.ok(!JSON.stringify(project(sm)).includes('FIRST_FINDING'));
 assert.ok(sm.getEntry(middle));
});
for(const zero of [false,true])test(`retained tail is byte-for-byte unchanged; zero=${zero}`,()=>{
 const sm=SessionManager.inMemory('/');const anchor=user(sm,'prefix');
 const b=toolRound(sm,'discard','HIDDEN');const tailUser=user(sm,'recent');toolRound(sm,'retain','KEPT');
 const {policyId,end}=fold(sm,zero?null:anchor,b,'FOLDED_INTERVAL');
 const raw=source(sm);const expectedTail=raw.slice(raw.findIndex(n=>n.id===tailUser));
 const actual=project(sm);
 assert.deepEqual(actual.slice(zero?1:2),expectedTail);
 assert.deepEqual(ids(actual).slice(0,zero?1:2),zero?[policyId]:[anchor,policyId]);
 assert.equal(actual.at(-1).id,end);
 assert.ok(!JSON.stringify(actual).includes('HIDDEN'));
 const final=fold(sm,zero?null:anchor,undefined,'NEXT_FOLD');
 assert.deepEqual(ids(project(sm)),zero?[final.policyId]:[anchor,final.policyId]);
});
test('incomplete batch stays unchanged and later unrelated results cannot complete it',()=>{
 const sm=SessionManager.inMemory('/');const anchor=user(sm,'prefix');
 const assistantId=sm.appendMessage({role:'assistant',content:[{type:'toolCall',id:'one',name:'read',arguments:{}},{type:'toolCall',id:'two',name:'backtrack',arguments:{}}],timestamp:2,stopReason:'toolUse'});
 sm.appendCustomEntry(TYPE,{anchorId:anchor,assistantId,replacement:'MUST_NOT_APPEAR'});
 sm.appendMessage({role:'toolResult',toolName:'backtrack',toolCallId:'two',content:[],timestamp:3});
 assert.deepEqual(project(sm),source(sm));
 toolRound(sm,'one');
 assert.deepEqual(project(sm),source(sm));
});
test('complete failed sibling does not revoke an independent policy',()=>{
 const sm=SessionManager.inMemory('/');const anchor=user(sm,'prefix');
 const assistantId=sm.appendMessage({role:'assistant',content:[{type:'toolCall',id:'one',name:'read',arguments:{}},{type:'toolCall',id:'two',name:'backtrack',arguments:{}}],timestamp:2,stopReason:'toolUse'});
 const policyId=sm.appendCustomEntry(TYPE,{anchorId:anchor,assistantId,replacement:'FINDING'});
 sm.appendMessage({role:'toolResult',toolName:'read',toolCallId:'one',content:[],isError:true,timestamp:3});
 sm.appendMessage({role:'toolResult',toolName:'backtrack',toolCallId:'two',content:[],timestamp:4});
 assert.deepEqual(ids(project(sm)),[anchor,policyId]);
});
test('request-local messages outside fold interval survive; custom timestamps normalize',()=>{
 const sm=SessionManager.inMemory('/');const custom=sm.appendCustomMessageEntry('external','stable',false,{id:'stable'});
 const anchor=user(sm,'task');toolRound(sm,'hidden');fold(sm,anchor);
 const raw=structuredClone(source(sm).map(n=>n.message));raw[0].timestamp=999;
 const extra={role:'custom',customType:'other',content:'request local',display:false,timestamp:0};
 const result=project(sm,[extra,...raw,extra]);
 assert.equal(result[0].message,extra);assert.equal(result.at(-1).message,extra);
 assert.equal(result[1].id,custom);
});
test('disk reopen and old-point branch use only policies on the selected path',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pi-policy-source-'));
 try {
  const sm=SessionManager.create(dir,dir);const anchor=user(sm,'prefix');const at=toolRound(sm,'hidden');fold(sm,anchor);
  const expected=project(sm);const reopened=SessionManager.open(sm.getSessionFile());
  assert.deepEqual(project(reopened),expected);
  reopened.branch(at);user(reopened,'alternate');
  assert.ok(JSON.stringify(project(reopened)).includes('DUPLICATE_BODY'));
  assert.equal(project(reopened).some(n=>n.message.customType==='probe:replacement'),false);
  assert.deepEqual(project(sm),expected);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
