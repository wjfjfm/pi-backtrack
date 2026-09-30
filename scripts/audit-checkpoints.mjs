// Compare runtime states and projected messages against a full-snapshot engine.
// Usage: node scripts/audit-checkpoints.mjs /absolute/path/to/baseline/dist/engine.js
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {SessionManager,sessionEntryToContextMessages} from '@earendil-works/pi-coding-agent';
import * as current from '../dist/engine.js';
if(!process.argv[2])throw new Error('Pass a full-snapshot baseline engine module');
const baseline=await import(pathToFileURL(resolve(process.argv[2])).href);
const directory=mkdtempSync(join(tmpdir(),'checkpoint-audit-'));
function fixture(module,name){
 let sm=SessionManager.create(directory,join(directory,name)),engine;
 const pi={appendEntry:(type,data)=>sm.appendCustomEntry(type,structuredClone(data)),getActiveTools:()=>[],getAllTools:()=>[]};
 const ctx={get sessionManager(){return sm;},getContextUsage:()=>({tokens:1234,contextWindow:100000,percent:1.234}),getSystemPrompt:()=>''};
 const restart=()=>{engine=new module.BacktrackEngine(pi);};restart();
 const state=()=>module.latestState(ctx);
 const user=content=>{const id=sm.appendMessage({role:'user',content,timestamp:1});engine.sync(ctx);return id;};
 const tool=(id,name='probe',args={})=>sm.appendMessage({role:'assistant',content:[{type:'toolCall',name,id,arguments:args}],timestamp:2,stopReason:'toolUse'});
 const result=(id,name='probe')=>sm.appendMessage({role:'toolResult',toolName:name,toolCallId:id,content:[{type:'text',text:`result ${id}`}],timestamp:3});
 const round=id=>{tool(id);result(id);engine.sync(ctx);};
 const fold=(id,args)=>{tool(id,'backtrack',args);engine.register(ctx,id,args);result(id,'backtrack');engine.sync(ctx);};
 const epochs=new Map();
 const normalize=value=>{
  const ids=new Map(sm.getEntries().map((e,i)=>[e.id,`entry:${i}`]));
  return JSON.parse(JSON.stringify(value,(key,value)=>{
   if(key==='timestamp')return 0; // SDK-generated entry timestamps differ between isolated sessions.
   if(key==='epoch'&&typeof value==='string'){
    if(!epochs.has(value))epochs.set(value,`epoch:${epochs.size}`);
    return epochs.get(value);
   }
   return typeof value==='string'&&ids.has(value)?ids.get(value):value;
  }));
 };
 return {state,user,round,fold,restart,ctx,tool,result,
  get sm(){return sm;},get engine(){return engine;},
  reopen(){sm=SessionManager.open(sm.getSessionFile());restart();},
  fork(){sm.createBranchedSession(sm.getLeafId());restart();},
  snapshot(){return normalize({state:state(),messages:engine.project(ctx,sm.buildContextEntries().flatMap(sessionEntryToContextMessages))});},
  normalize,
 };
}
try{
 const pair=[fixture(baseline,'old'),fixture(current,'new')];
 let stages=0;
 const step=(label,action)=>{
  pair.forEach(action);
  assert.deepEqual(pair[1].snapshot(),pair[0].snapshot(),label);
  console.log(`PASS ${label}`);stages++;
 };
 step('initial checkpoint',f=>f.user('task'));
 for(let i=0;i<8;i++)step(`complete tool batch ${i}`,f=>f.round(`probe-${i}`));
 const leaves=pair.map(f=>f.sm.getLeafId());
 step('retained tail',f=>f.fold('keep',{checkpoint:1,keep_after_checkpoint:4,message:'TAIL_HANDOFF'}));
 step('reload',f=>f.restart());
 step('disk resume',f=>f.reopen());
 step('new user',f=>f.user('next task'));
 step('nested default fold',f=>f.fold('default',{checkpoint:1,message:'DEFAULT_HANDOFF'}));
 step('zero fold / epoch reset',f=>f.fold('zero',{checkpoint:0,message:'ZERO_HANDOFF'}));
 const foldedLeaves=pair.map(f=>f.sm.getLeafId());
 step('tree before folds',(f,i)=>f.sm.branch(leaves[i]));
 step('new branch numbering',f=>f.user('alternate'));
 step('tree back to folded branch',(f,i)=>f.sm.branch(foldedLeaves[i]));
 step('native branch summary',f=>f.sm.branchWithSummary(f.sm.getLeafId(),'BRANCH_SUMMARY'));
 step('fork with label',f=>{f.sm.appendLabelChange(f.sm.getLeafId(),'label');f.fork();});
 step('fork disk resume',f=>f.reopen());
 step('fork continuation',f=>f.user('fork task'));
 step('post-fork fold',f=>f.fold('fork-fold',{checkpoint:0,message:'FORK_HANDOFF'}));
 for(let i=0;i<2;i++){
  step(`compact boundary ${i}`,f=>{
   const kept=f.user(`kept ${i}`);
   f.sm.appendCompaction(`COMPACT_SUMMARY ${i}`,kept,2000);
   f.engine.sync(f.ctx);
  });
  step(`compact resume ${i}`,f=>f.reopen());
  step(`compact continuation ${i}`,f=>f.user(`continue ${i}`));
  step(`fold after compact ${i}`,f=>f.fold(`compact-fold-${i}`,{checkpoint:0,message:`COMPACT_HANDOFF ${i}`}));
 }
 console.log(`${stages} stages: equal states and context (only generated IDs, epochs and timestamps normalized)`);
}finally{rmSync(directory,{recursive:true,force:true});}
