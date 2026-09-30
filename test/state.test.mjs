import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SessionManager,sessionEntryToContextMessages} from '@earendil-works/pi-coding-agent';
import {BacktrackEngine,latestState} from '../dist/engine.js';
import {STATE,SNAPSHOT_STATE,POLICY} from '../dist/contracts.js';
import {storeState,restoreStates} from '../dist/state.js';

function fixture() {
 const sm=SessionManager.inMemory('/');
 const pi={appendEntry:(type,data)=>sm.appendCustomEntry(type,structuredClone(data)),getActiveTools:()=>[],getAllTools:()=>[]};
 const ctx={sessionManager:sm,getContextUsage:()=>({tokens:1000,contextWindow:100000,percent:1}),getSystemPrompt:()=>''};
 const engine=new BacktrackEngine(pi);
 const user=content=>{const id=sm.appendMessage({role:'user',content,timestamp:1});engine.sync(ctx);return id;};
 return {sm,pi,ctx,engine,user};
}
const assistant=(sm,content)=>sm.appendMessage({role:'assistant',content,timestamp:2,stopReason:'toolUse'});
const finish=sm=>sm.appendMessage({role:'toolResult',toolName:'backtrack',toolCallId:'fold',content:[{type:'text',text:'Backtrack applied.'}],timestamp:3});
function register(f) {
 assistant(f.sm,[{type:'toolCall',name:'backtrack',id:'fold',arguments:{checkpoint:1,message:'FINDING'}}]);
 f.engine.register(f.ctx,'fold',{checkpoint:1,message:'FINDING'});
 return f.sm.getLeafEntry();
}

test('checkpoint bodies grow linearly; cursor-only revisions store no checkpoint copies',()=>{
 const sizes=[];
 for(const n of [40,80]){
  const f=fixture();for(let i=0;i<n;i++)f.user('task');
  const entries=f.sm.getEntries().filter(e=>e.customType===STATE);
  assert.equal(entries.reduce((n,e)=>n+e.data.checkpoints.length,0),n+1);
  assert.equal(latestState(f.ctx).checkpoints.length,n+1);
  sizes.push(Buffer.byteLength(JSON.stringify(entries)));
  assistant(f.sm,[{type:'text',text:'Done'}]);f.engine.sync(f.ctx);
  assert.deepEqual(f.sm.getLeafEntry().data.checkpoints,[]);
  const leaf=f.sm.getLeafId();f.engine.sync(f.ctx);assert.equal(f.sm.getLeafId(),leaf);
 }
 assert.ok(sizes[1]<sizes[0]*2.2);
});

test('obsolete full snapshots are rejected rather than silently migrated',()=>{
 const f=fixture();f.user('one');const old=latestState(f.ctx);
 f.sm.appendCustomEntry(SNAPSHOT_STATE,structuredClone(old));
 assert.throws(()=>f.engine.sync(f.ctx),/unsupported/);
 assert.throws(()=>restoreStates([old]),/unsupported/);
});
test('delta restoration does not mutate persisted markers',()=>{
 const f=fixture();f.user('one');const state=latestState(f.ctx);
 state.checkpoints[0].marker.content='mutated caller';
 assert.notEqual(latestState(f.ctx).checkpoints[0].marker.content,'mutated caller');
 const saved=storeState(state);
 assert.deepEqual(restoreStates([saved]),state);
});

test('completed policy recovers before settlement, while incomplete policy is ignored',()=>{
 const f=fixture();f.user('one');f.user('two');const before=latestState(f.ctx);
 const policy=register(f);
 assert.equal(policy.customType,POLICY);
 assert.equal(policy.data.details.state.version,3);
 assert.deepEqual(policy.data.details.state.checkpoints,[]);
 assert.deepEqual(latestState(f.ctx),before);
 finish(f.sm);
 const committed=latestState(f.ctx);
 assert.deepEqual(committed.checkpoints.map(p=>p.id),[0,1]);
 assert.equal(committed.cursor,policy.id);
 new BacktrackEngine(f.pi).sync(f.ctx);
 const view=JSON.stringify(f.engine.project(f.ctx,f.sm.buildContextEntries().flatMap(sessionEntryToContextMessages)));
 assert.match(view,/FINDING/);
 assert.equal(latestState(f.ctx).lastTransaction,policy.id);
});

test('state revisions name their actual base, not an intervening incomplete policy',()=>{
 const f=fixture();f.user('one');f.user('two');register(f);
 f.engine.sync(f.ctx); // A reload/observation before the tool result must not consume the policy.
 const observation=latestState(f.ctx);
 finish(f.sm);
 assert.deepEqual(latestState(f.ctx),observation,'completion must not retroactively rebase an already saved revision');
});

test('obsolete policy snapshots fail closed on recovery',()=>{
 const f=fixture();f.user('one');f.user('two');const before=latestState(f.ctx);
 const policy=register(f);
 const full=restoreStates([storeState(before),policy.data.details.state]);
 f.sm.branch(policy.parentId);
 f.sm.appendCustomEntry(POLICY,{...policy.data,details:{...policy.data.details,state:full}});
 finish(f.sm);
 assert.throws(()=>f.engine.sync(f.ctx),/unsupported/);
});

test('a delta cannot borrow a base from another branch or before compaction',()=>{
 const f=fixture();f.user('one');const root=f.sm.getLeafId();
 f.user('abandoned');const foreign=f.sm.getLeafId(),data=f.sm.getLeafEntry().data;
 f.sm.branch(root);
 f.sm.appendCustomEntry(STATE,{...data,parent:foreign});
 assert.throws(()=>latestState(f.ctx),/delta base/);
 f.sm.branch(root);
 const kept=f.user('kept');f.sm.appendCompaction('SUMMARY',kept,1000);
 assert.equal(latestState(f.ctx),undefined);
 f.engine.sync(f.ctx);
 assert.equal(f.sm.getLeafEntry().data.parent,null);
 const after=latestState(f.ctx);assert.notEqual(after.epoch,data.epoch);
 f.sm.appendCustomEntry(STATE,{...data,parent:root});
 assert.throws(()=>latestState(f.ctx),/delta base/);
});

test('failed state persistence can retry without consuming checkpoints',()=>{
 const f=fixture();f.user('one');const before=latestState(f.ctx);
 f.sm.appendMessage({role:'user',content:'two',timestamp:4});
 const append=f.pi.appendEntry;
 f.pi.appendEntry=()=>{throw new Error('injected save failure');};
 assert.throws(()=>f.engine.sync(f.ctx),/injected save failure/);
 assert.deepEqual(latestState(f.ctx),before);
 f.pi.appendEntry=append;f.engine.sync(f.ctx);
 assert.equal(latestState(f.ctx).checkpoints.length,before.checkpoints.length+1);
 assert.equal(f.sm.getLeafEntry().data.checkpoints.length,1);
});

test('missing and malformed delta bases fail closed',()=>{
 const f=fixture();f.user('one');const old=latestState(f.ctx),leaf=f.sm.getLeafId();
 for(const data of [
  {...storeState(old),parent:'missing'},
  {...storeState(old),version:99},
  {...storeState(old),removed:null},
 ]){
  f.sm.branch(leaf);f.sm.appendCustomEntry(STATE,data);
  assert.throws(()=>latestState(f.ctx),/Corrupt|delta base/);
 }
});
