import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager} from '@earendil-works/pi-coding-agent';
import {createAssistantMessageEventStream,getCurrentSystemPrompt,getCurrentTools} from '@earendil-works/pi-ai';
import {POLICY} from '../dist/contracts.js';
import {latestState,operations} from '../dist/engine.js';
const model={id:'public-test',name:'public-test',api:'openai-completions',provider:'public-test',baseUrl:'http://unused.invalid',reasoning:false,input:['text','image'],contextWindow:100000,maxTokens:2000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const call=(name,id,args={})=>({type:'toolCall',name,id,arguments:args});
const text=text=>({type:'text',text});
async function fixture(t,respond,mode='parallel',summary,extensions=[],reverseExtensions=false,configure=()=>{}) {
 const cwd=await mkdtemp(join(tmpdir(),'public-backtrack-')),previous=process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR=join(cwd,'agent');
 t.after(async()=>{if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;await rm(cwd,{recursive:true,force:true});});
 const settingsManager=SettingsManager.inMemory({compaction:{enabled:false,keepRecentTokens:100},retry:{enabled:false}});
 const compactions=[];
 const summaryStream=(_model,context,options)=>{
  assert.ok(summary,'unexpected provider request outside the scripted agent stream');
  const response=summary(context,options);
  const message={role:'assistant',content:[text(response.text??'SUMMARY KEY_FINDING')],api:model.api,provider:model.provider,model:model.id,
   usage:{input:300,output:20,cacheRead:0,cacheWrite:0,totalTokens:320,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:response.error?'error':'stop',timestamp:Date.now(),...(response.error?{errorMessage:response.error}:{})};
  const stream=createAssistantMessageEventStream();stream.push(response.error?{type:'error',reason:'error',error:message}:{type:'done',reason:'stop',message});stream.end();return stream;
 };
 const extensionPaths=[resolve(process.env.PI_BACKTRACK_EXTENSION || 'dist/index.js'),...extensions];
 if(reverseExtensions)extensionPaths.reverse();
 const loader=new DefaultResourceLoader({cwd,agentDir:join(cwd,'agent'),settingsManager,noContextFiles:true,noSkills:true,additionalExtensionPaths:extensionPaths,extensionFactories:[pi=>{
  pi.on('session_before_compact',event=>{compactions.push({reason:event.reason,willRetry:event.willRetry});});
  pi.registerProvider('public-test',{apiKey:'dummy',api:model.api,baseUrl:model.baseUrl,models:[model],streamSimple:summaryStream});
  configure(pi);
  for(const name of ['probe','fail'])pi.registerTool({name,label:name,description:name,executionMode:mode,parameters:{type:'object',properties:{value:{type:'string'}}},execute:async(_id,args)=>{
   if(name==='fail')throw new Error('SIBLING_FAILURE');
   return {content:[text((args.value??'SECRET_TOOL_BODY').repeat(summary?3000:1))]};
  }});
 }]});
 await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
 const sm=SessionManager.create(cwd,join(cwd,'sessions'));
 let {session}=await createAgentSession({cwd,agentDir:join(cwd,'agent'),settingsManager,resourceLoader:loader,sessionManager:sm,model});
 const errors=[],requests=[],injectedErrors=new Set();t.after(()=>{
  session.dispose();
  assert.deepEqual(errors,[]);
  assert.deepEqual(session.messages.filter(m=>m.role==='assistant'&&m.stopReason==='error').map(m=>m.errorMessage).filter(error=>!injectedErrors.has(error)),[]);
 });await session.bindExtensions({onError:e=>errors.push(e)});
 session.agent.streamFunction=(_model,context,options)=>{
  if(options?.signal?.aborted){
   const error={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,stopReason:'aborted',timestamp:Date.now(),
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
   const stream=createAssistantMessageEventStream();stream.push({type:'error',reason:'aborted',error});stream.end();return stream;
  }
  if(summary&&JSON.stringify(context.messages[0]).includes('You are a context summarization assistant.'))return summaryStream(_model,context,options);
  requests.push(JSON.parse(JSON.stringify(context)));
  const response=respond(requests.length,context,session);
  const content=Array.isArray(response)?response:[];
  const message={role:'assistant',content,api:model.api,provider:model.provider,model:model.id,usage:response.usage??{input:100,output:10,cacheRead:0,cacheWrite:0,totalTokens:110,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:content.some(c=>c.type==='toolCall')?'toolUse':'stop',timestamp:Date.now()};
  if(response.error){injectedErrors.add(response.error);message.stopReason='error';message.errorMessage=response.error;}
  const stream=createAssistantMessageEventStream();stream.push(response.error?{type:'error',reason:'error',error:message}:{type:'done',reason:message.stopReason,message});stream.end();return stream;
 };
 return {session,sm,requests,errors,cwd,compactions,async reopen(file=sm.getSessionFile()){
  const stream=session.agent.streamFunction;assert.ok(file,'a disk-backed session is required');
  session.dispose();await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
  ({session}=await createAgentSession({cwd,agentDir:join(cwd,'agent'),settingsManager,resourceLoader:loader,sessionManager:SessionManager.open(file),model}));
  await session.bindExtensions({onError:e=>errors.push(e)});
  session.agent.streamFunction=stream;
  return session;
 }};
}
test('zero reset leaves system/tools unchanged and the new request prefix stable across turns, reload and resume',async t=>{
 let original,baseline,sessionId;
 const host=await fixture(t,(n,context,session)=>{
  if(n===1){original=structuredClone(context.messages);sessionId=session.sessionId;return [call('backtrack','zero',{checkpoint:0,message:'STABLE_HANDOFF'})];}
  assert.equal(session.sessionId,sessionId);
  assert.equal(getCurrentSystemPrompt(context.messages),getCurrentSystemPrompt(original));
  assert.deepEqual(getCurrentTools(context.messages),getCurrentTools(original));
  if(n===2){baseline=structuredClone(context.messages);return [call('probe','next-tool')];}
  // Compare complete request messages, including timestamps: no earlier marker,
  // summary, payload or system checkpoint is regenerated as usage changes.
  assert.deepEqual(context.messages.slice(0,baseline.length),baseline);
  return [text('Done')];
 });
 await host.session.prompt('Reset then continue');
 await host.session.prompt('Another turn');
 await host.session.reload();await host.session.prompt('After reload');
 const resumed=await host.reopen();await resumed.prompt('After resume');
 assert.equal(host.requests.length,6);
 const branch=resumed.sessionManager.getBranch();
 assert.equal(branch.filter(entry=>entry.type==='compaction').length,1);
 const state=latestState({sessionManager:resumed.sessionManager});
 const prefix=JSON.stringify(baseline);
 assert.ok(!prefix.includes(state.epoch));
 assert.ok(!prefix.includes(branch.find(entry=>entry.type==='compaction').id));
});
test('zero resets create native roots without replaying earlier policies or retaining earlier handoffs',async t=>{
 const host=await fixture(t,(n,context,session)=>{
  const visible=JSON.stringify(context.messages);
  if(n===1)return [call('probe','explore',{value:'ARCHIVED_TOOL'})];
  if(n===2)return [call('backtrack','zero-1',{checkpoint:0,message:'HANDOFF_ONE'})];
  assert.doesNotMatch(visible,/ARCHIVED_TOOL/);
  const sm=session.sessionManager,branch=sm.getBranch(),base=branch.findLast(entry=>entry.type==='compaction');
  assert.ok(base);
  assert.deepEqual(operations({sessionManager:sm}),[]);
  const projected=sm.buildSessionProjection().entries;
  assert.ok(projected.every(entry=>branch.indexOf(entry.sourceEntry)>=branch.findIndex(entry=>entry.id===base.firstKeptEntryId)));
  assert.ok(!projected.some(entry=>entry.sourceEntry.type==='message'&&entry.sourceEntry.message.role==='toolResult'));
  const state=latestState({sessionManager:sm});
  assert.equal(state.base,base.id);assert.equal(state.checkpoints[0].boundary,base.id);
  assert.equal(state.checkpoints[0].historyBoundary,base.firstKeptEntryId);
  if(n===3){assert.match(visible,/ORIGINAL_TASK/);assert.match(visible,/HANDOFF_ONE/);return [call('backtrack','zero-2',{checkpoint:0,message:'HANDOFF_TWO'})];}
  assert.doesNotMatch(visible,/ORIGINAL_TASK|HANDOFF_ONE/);
  if(n===4){assert.match(visible,/HANDOFF_TWO/);return [call('backtrack','zero-3',{checkpoint:0,message:'HANDOFF_THREE'})];}
  assert.doesNotMatch(visible,/HANDOFF_TWO/);assert.match(visible,/HANDOFF_THREE/);
  return [text('Done')];
 });
 await host.session.prompt('ORIGINAL_TASK');
 assert.equal(host.requests.length,5);
 const bases=host.sm.getBranch().filter(entry=>entry.type==='compaction');assert.equal(bases.length,3);
 assert.match(JSON.stringify(host.sm.getBranch()),/ORIGINAL_TASK|ARCHIVED_TOOL|HANDOFF_ONE/);
 const reopened=await host.reopen();await reopened.prompt('Continue');
 assert.equal(reopened.sessionManager.getBranch().filter(entry=>entry.type==='compaction').length,3);
 assert.equal(host.requests.length,6);
});
test('zero reset replaces earlier native summaries and stale usage without invoking a summarizer',async t=>{
 const host=await fixture(t,(n,context)=>{
  if(n===1){assert.match(JSON.stringify(context.messages),/PREVIOUS_SUMMARY/);return metered([call('backtrack','zero',{checkpoint:0,message:'CURRENT_HANDOFF'})],90000);}
  assert.doesNotMatch(JSON.stringify(context.messages),/PREVIOUS_SUMMARY/);
  assert.match(JSON.stringify(context.messages),/CURRENT_HANDOFF/);
  return [text('Done')];
 });
 host.sm.appendCompaction('PREVIOUS_SUMMARY',null,1000);
 host.session.setAutoCompactionEnabled(true);
 await host.session.prompt('New task');
 assert.equal(host.requests.length,2);
 assert.equal(host.sm.getBranch().filter(entry=>entry.type==='compaction').length,2);
 assert.deepEqual(host.compactions,[]);
 assert.ok(host.session.getContextUsage().tokens<90000);
});
test('an interrupted zero publication preserves handoff and resumes the native commit without duplication',async t=>{
 const host=await fixture(t,(n,context)=>{
  if(n===1)return [call('backtrack','zero',{checkpoint:0,message:'DURABLE_HANDOFF'})];
  assert.equal(JSON.stringify(context.messages).split('DURABLE_HANDOFF').length-1,1);
  if(n===4)return [call('backtrack','again',{checkpoint:0,message:'DURABLE_HANDOFF'})];
  if(n===5){assert.match(JSON.stringify(context.messages),/WORK_AFTER_INTERRUPTION/);assert.doesNotMatch(JSON.stringify(context.messages),/ORIGINAL_REQUEST/);}
  return [text('Continued')];
 });
 await host.session.prompt('ORIGINAL_REQUEST');
 const branch=host.sm.getBranch(),staged=branch.findIndex(entry=>entry.customType==='backtrack:baseline');
 assert.ok(staged>=0);
 const interrupted=join(host.cwd,'interrupted.jsonl');
 await writeFile(interrupted,[host.sm.getHeader(),...branch.slice(0,staged+1)].map(entry=>JSON.stringify(entry)).join('\n')+'\n');
 const resumed=await host.reopen(interrupted);
 await resumed.prompt('WORK_AFTER_INTERRUPTION');
 const recovered=resumed.sessionManager.getBranch();
 assert.equal(recovered.filter(entry=>entry.type==='compaction').length,1);
 assert.equal(recovered.filter(entry=>entry.customType==='backtrack:baseline').length,1);
 const native=JSON.stringify(resumed.sessionManager.buildSessionProjection().messages);
 assert.match(native,/DURABLE_HANDOFF/);assert.match(native,/WORK_AFTER_INTERRUPTION/);
 assert.doesNotMatch(native,/"toolCall"/);
 await resumed.reload();await resumed.prompt('Still here');
 assert.equal(host.requests.length,5);
 assert.equal(resumed.sessionManager.getBranch().filter(entry=>entry.type==='compaction').length,2);
});
for(const mode of ['parallel','sequential'])test(`zero reset waits for siblings and preserves queued custom messages (${mode})`,async t=>{
 const host=await fixture(t,(n,context)=>{
  if(n===1)return [call('backtrack','zero',{checkpoint:0,message:'SAFE_HANDOFF'}),call('fail','failed'),call('notify','notify')];
  assert.match(JSON.stringify(context.messages),/SAFE_HANDOFF/);
  assert.match(JSON.stringify(context.messages),/UNRELATED_NOTICE/);
  assert.doesNotMatch(JSON.stringify(context.messages),/SIBLING_FAILURE/);
  return [text('Done')];
 },mode,undefined,[],false,pi=>{
  pi.registerTool({name:'notify',label:'notify',description:'notify',executionMode:mode,parameters:{type:'object',properties:{}},
   async execute(){pi.sendMessage({customType:'notice',content:'UNRELATED_NOTICE',display:false},{triggerTurn:false});return {content:[text('sent')],details:undefined};}});
 });
 await host.session.prompt('Reset after all tools');
 assert.equal(host.requests.length,2);
 const branch=host.sm.getBranch(),base=branch.findIndex(entry=>entry.type==='compaction');
 assert.equal(branch.slice(0,base).filter(entry=>entry.type==='message'&&entry.message.role==='toolResult').length,3);
});
test('aborting after a registered zero reset does not force continuation or lose the handoff',async t=>{
 const host=await fixture(t,(n,context)=>{
  if(n===1)return [call('backtrack','zero',{checkpoint:0,message:'ABORT_SAFE_HANDOFF'}),call('wait','wait')];
  assert.match(JSON.stringify(context.messages),/ABORT_SAFE_HANDOFF/);return [text('Done')];
 },'parallel',undefined,[],false,pi=>{
  pi.registerTool({name:'wait',label:'wait',description:'wait for cancellation',parameters:{type:'object',properties:{}},
   async execute(_id,_args,signal){
    if(!signal.aborted)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    return {content:[text('Stopped')],details:undefined};
   }});
 });
 let aborted=false;
 host.session.subscribe(event=>{
  if(event.type==='tool_execution_end'&&event.toolName==='backtrack'&&!aborted){aborted=true;setTimeout(()=>void host.session.abort(),0);}
 });
 await host.session.prompt('Reset then stop');
 assert.equal(aborted,true);assert.equal(host.requests.length,1);
 assert.equal(host.sm.getBranch().filter(entry=>entry.type==='compaction').length,1);
 const resumed=await host.reopen();await resumed.prompt('Continue');assert.equal(host.requests.length,2);
});
test('zero retained-tail folds do not reset the native baseline',async t=>{
 const host=await fixture(t,n=>n===1?[call('probe','one')]:n===2?[call('probe','two')]:n===3?
  [call('backtrack','keep',{checkpoint:0,keep_after_checkpoint:2,message:'TAIL_HANDOFF'})]:[text('Done')]);
 await host.session.prompt('Keep the tail');
 assert.equal(host.requests.length,4);
 assert.equal(host.sm.getBranch().filter(entry=>entry.type==='compaction').length,0);
 assert.equal(operations({sessionManager:host.sm}).length,1);
});
test('native context edits remain authoritative across folds and disk reopen',async t=>{
 const host=await fixture(t,(n,context)=>{
  if(n===1)return [call('probe','explore',{value:'ORIGINAL_BODY'})];
  if(n===2)return [text('Explored')];
  assert.ok(!JSON.stringify(context.messages.filter(message=>message.role==='toolResult')).includes('ORIGINAL_BODY'));
  if(n===3){
   assert.match(JSON.stringify(context.messages),/EDITED_BODY/);
   return [call('backtrack','fold',{checkpoint:1,message:'EDITED_FINDING'})];
  }
  assert.ok(!JSON.stringify(context.messages).includes('EDITED_BODY'));
  assert.match(JSON.stringify(context.messages),/EDITED_FINDING/);
  assert.equal(context.messages[0].role,'system');
  return [text('Done')];
 });
 await host.session.prompt('Explore');
 const result=host.sm.getBranch().find(entry=>entry.type==='message'&&entry.message.role==='toolResult');
 host.sm.appendContextEdit(result.id,{content:[text('EDITED_BODY')]});
 await host.session.prompt('Fold');
 const reopened=await host.reopen();await reopened.prompt('Continue');
 assert.equal(host.requests.length,5);
});

for(const outerFails of [false,true])test(`nested skill reads survive outer failure=${outerFails} while backtrack stays model-only`, {skip:!process.env.PI_DYNAMIC_SKILL_EXTENSION},async t=>{
 let skill;
 const host=await fixture(t,(n,context)=>{
  if(n===1)return [call('orchestrate','outer',{path:skill})];
  if(n===2)return [call('backtrack','fold',{checkpoint:0,message:'NESTED_FINDING'})];
  const visible=JSON.stringify(context.messages);
  assert.ok(!visible.includes('NESTED_PRIVATE_BODY'));
  assert.equal(visible.split('NESTED_PUBLIC_DESCRIPTION').length-1,1);
  return [text('Done')];
 },'parallel',undefined,[resolve(process.env.PI_DYNAMIC_SKILL_EXTENSION)],false,pi=>{
  pi.registerTool({name:'orchestrate',label:'orchestrate',description:'Nested read',exposure:'model-only',
   parameters:{type:'object',properties:{path:{type:'string'}},required:['path']},
   async execute(_id,args,_signal,_update,ctx){
    assert.ok(!ctx.tools.some(tool=>tool.name==='backtrack'));
    const blocked=await ctx.executeTool('backtrack',{checkpoint:0});
    assert.equal(blocked.isError,true);
    const failed=await ctx.executeTool('read',{path:args.path+'.missing'});
    assert.equal(failed.isError,true);
    const result=await ctx.executeTool('read',{path:args.path});
    assert.equal(result.isError,false);
    if(outerFails)throw new Error('OUTER_FAILED_AFTER_SUCCESSFUL_READ');
    return {content:result.result.content,details:undefined};
   }});
 });
 const directory=join(host.cwd,'dynamic-skill','skills','dynamic-skill','skills','nested');
 await mkdir(directory,{recursive:true});skill=join(directory,'SKILL.md');
 await writeFile(skill,'---\nname: nested\ndescription: NESTED_PUBLIC_DESCRIPTION\n---\nNESTED_PRIVATE_BODY');
 await host.session.prompt('Read through a nested tool');
 const accesses=host.sm.getEntries().filter(entry=>entry.customType==='dynamic-skill:nested-access');
 assert.equal(accesses.length,1);assert.equal(accesses[0].data.path,skill);
 const reopened=await host.reopen();await reopened.prompt('Continue');
 assert.equal(reopened.sessionManager.getEntries().filter(entry=>entry.customType==='dynamic-skill:nested-access').length,1);
 assert.equal(host.requests.length,4);
});

const metered=(response,input,output=10)=>Object.assign(response,{usage:{input,output,cacheRead:0,cacheWrite:0,totalTokens:input+output,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
for(const mode of ['stale','manual','overflow','fresh','large','zero-usage'])test(`post-fold threshold recheck preserves ${mode} behavior`,async t=>{
 const summaries=[];
 const host=await fixture(t,(n,ctx)=>{
  if(n===1)return [call('probe','explore',{value:'HIDDEN_EXPLORATION'})];
  if(n===2)return metered([call('backtrack','fold',{checkpoint:1,message:'KEPT_FINDING'+(mode==='large'?'X'.repeat(400000):'')})],90000);
  assert.ok(!JSON.stringify(ctx.messages).includes('HIDDEN_EXPLORATION'));
  assert.ok(JSON.stringify(ctx.messages).includes('KEPT_FINDING'));
  if(mode==='overflow'&&n===3)return {error:'maximum context length exceeded'};
  if(mode==='fresh')return metered([text('Done')],90000);
  if(mode==='zero-usage')return metered([text('Done')],0,0);
  return [text('Done')];
 },'parallel',context=>{
  assert.ok(!JSON.stringify(context).includes('HIDDEN_EXPLORATION'));
  summaries.push(context);return {text:'SUMMARY KEPT_FINDING'};
 });
 const events=[];
 const unsubscribe=host.session.subscribe(event=>{if(event.type==='compaction_end')events.push(event);});
 t.after(unsubscribe);
 host.session.setAutoCompactionEnabled(true);
 await host.session.prompt('Explore then fold');
 if(mode==='manual')await host.session.compact();
 assert.equal(host.requests.length,mode==='overflow'?4:3);
 const expected=['stale','zero-usage'].includes(mode)?0:1;
 assert.equal(summaries.length,expected);
 assert.equal(host.sm.getBranch().filter(entry=>entry.type==='compaction').length,expected);
 if(!expected){
  assert.ok(events.some(event=>event.reason==='threshold'&&event.aborted),'host threshold attempt is cancelled, not summarized');
  assert.ok(host.sm.getBranch().some(entry=>entry.customType===POLICY));
 }else assert.equal(host.compactions.at(-1).reason,mode==='manual'?'manual':mode==='overflow'?'overflow':'threshold');
});
test('retained-tail fold ignores pre-fold usage carried by retained assistant messages',async t=>{
 let summaries=0;
 const host=await fixture(t,(n,ctx)=>{
  if(n===1)return [call('probe','discard',{value:'DISCARD_BODY'})];
  if(n===2)return [call('probe','keep',{value:'KEEP_BODY'})];
  if(n===3)return metered([call('backtrack','fold',{checkpoint:1,keep_after_checkpoint:2,message:'KEEP_FINDING'})],90000);
  assert.equal(n,4);
  assert.ok(!JSON.stringify(ctx.messages).includes('DISCARD_BODY'));
  assert.ok(JSON.stringify(ctx.messages).includes('KEEP_BODY'));
  return [text('Done')];
 },'parallel',()=>{summaries++;return {text:'UNEXPECTED_SUMMARY'};});
 host.session.setAutoCompactionEnabled(true);
 await host.session.prompt('Discard exploration but retain the tail');
 assert.equal(host.requests.length,4);
 assert.equal(summaries,0);
 assert.equal(host.sm.getBranch().filter(entry=>entry.type==='compaction').length,0);
});
for(const recovery of ['reload','resume'])test(`stale usage recheck survives ${recovery} without a persisted suppression flag`,async t=>{
 let summaries=0;
 const host=await fixture(t,(n,ctx)=>{
  if(n===1)return [call('probe','explore',{value:'HIDDEN_EXPLORATION'})];
  if(n===2)return metered([call('backtrack','fold',{checkpoint:1,message:'KEPT_FINDING'})],90000);
  if(n===3)return metered({error:'SCRIPTED_FAILURE_AFTER_FOLD'},0,0);
  assert.equal(n,4);
  assert.ok(!JSON.stringify(ctx.messages).includes('HIDDEN_EXPLORATION'));
  assert.ok(JSON.stringify(ctx.messages).includes('KEPT_FINDING'));
  return [text('Done')];
 },'parallel',()=>{summaries++;return {text:'UNEXPECTED_SUMMARY'};});
 host.session.setAutoCompactionEnabled(true);
 await host.session.prompt('Explore then fold');
 const session=recovery==='resume'?await host.reopen():host.session;
 if(recovery==='reload')await session.reload();
 await session.prompt('Continue');
 assert.equal(host.requests.length,4);
 assert.equal(summaries,0);
 assert.equal(session.sessionManager.getBranch().filter(entry=>entry.type==='compaction').length,0);
});
test('threshold compaction without a fold remains native',async t=>{
 let summaries=0;
 const host=await fixture(t,n=>n===1?[call('probe','explore')]:metered([text('Done')],90000),
  'parallel',()=>{summaries++;return {text:'NATIVE_SUMMARY'};});
 host.session.setAutoCompactionEnabled(true);
 await host.session.prompt('Explore without folding');
 assert.equal(host.requests.length,2);
 assert.equal(summaries,1);
 const compactions=host.sm.getBranch().filter(entry=>entry.type==='compaction');
 assert.equal(compactions.length,1);
 assert.match(compactions[0].summary,/NATIVE_SUMMARY/);
});
for(const compact of [false,true])test(`public extensions rebuild active skills after folding (compact=${compact})`, {skip:!process.env.PI_DYNAMIC_SKILL_EXTENSION}, async t=>{
 let skill;
 const host=await fixture(t,(n,ctx)=>{
  if(n===1)return [call('read','skill-read',{path:skill})];
  if(n===2){
   assert.ok(JSON.stringify(ctx.messages).includes('PRIVATE_SKILL_BODY'));
   return [call('backtrack','fold',{checkpoint:0,message:'SKILL_FINDING'})];
  }
  const visible=JSON.stringify(ctx.messages);
  assert.ok(!visible.includes('PRIVATE_SKILL_BODY'));
  assert.equal(visible.split('PUBLIC_SKILL_DESCRIPTION').length-1,1);
  assert.ok(visible.includes('SKILL_FINDING'));
  return [text('Done '.repeat(1000))];
 },'parallel',compact?context=>{
  assert.ok(!JSON.stringify(context).includes('PRIVATE_SKILL_BODY'));
  return {text:'SUMMARY SKILL_FINDING'};
 }:undefined,[resolve(process.env.PI_DYNAMIC_SKILL_EXTENSION)]);
 const directory=join(host.cwd,'dynamic-skill','skills','dynamic-skill','skills','example');
 await mkdir(directory,{recursive:true});skill=join(directory,'SKILL.md');
 await writeFile(skill,'---\nname: example\ndescription: PUBLIC_SKILL_DESCRIPTION\n---\nPRIVATE_SKILL_BODY');
 await host.session.prompt('Read the skill, then fold. '.repeat(100));
 assert.equal(host.requests.length,3);
 const blocks=host.sm.getEntries().filter(entry=>entry.customType==='dynamic-skill:description:v1');
 assert.ok(blocks.length>=2);
 if(compact)await host.session.compact();
 await host.session.reload();await host.session.prompt('Continue');
 assert.equal(host.requests.length,4);
 const resumed=await host.reopen();await resumed.prompt('Continue after disk reopen');
 assert.equal(host.requests.length,5);
 assert.deepEqual(host.errors,[]);
});
for(const checkpoint of [0,1])for(const reverse of [false,true])test(`discovery retention at checkpoint ${checkpoint} (skills first=${reverse})`, {skip:!process.env.PI_DYNAMIC_SKILL_EXTENSION}, async t=>{
 let root;
 const host=await fixture(t,(n,ctx)=>{
  const visible=JSON.stringify(ctx.messages);
  if(n===1)return [call('read','discover',{path:root})];
  if(n===2){
   assert.ok(visible.includes('ORDER_CHILD_DESCRIPTION'));
   return [call('backtrack','fold',{checkpoint,message:'ORDER_FINDING'})];
  }
  assert.equal(n,3);
  assert.ok(visible.includes('ORDER_FINDING'));
  assert.equal(visible.includes('ORDER_CHILD_DESCRIPTION'),checkpoint!==0&&reverse,
   'zero resets remove native anchors before either context hook; nonzero folds remain order-dependent');
  return [text('Done')];
 },'parallel',undefined,[resolve(process.env.PI_DYNAMIC_SKILL_EXTENSION)],reverse);
 root=join(host.cwd,'dynamic-skill','skills','dynamic-skill','SKILL.md');
 const directory=join(root,'..','skills','order-child');
 await mkdir(directory,{recursive:true});
 await writeFile(join(directory,'SKILL.md'),'---\nname: order-child\ndescription: ORDER_CHILD_DESCRIPTION\n---\n');
 await host.session.prompt('Discover children, then fold.');
 assert.equal(host.requests.length,3);
 const state=host.sm.getEntries().findLast(entry=>entry.customType==='dynamic-skill:access-state');
 assert.ok(state,'queue state was persisted');
 assert.equal(state.data.discovery.length,checkpoint!==0&&reverse?1:0);
});
for(const recovery of ['manual','overflow'])test(`public extensions preserve skills across retained-tail and nested folds, ${recovery} compact and disk reopen`, {skip:!process.env.PI_DYNAMIC_SKILL_EXTENSION}, async t=>{
 let skill;const summaries=[];
 const host=await fixture(t,(n,ctx)=>{
  const visible=JSON.stringify(ctx.messages);
  if(n===1)return [call('read','skill-read',{path:skill})];
  if(n===2)return [call('probe','tail',{value:'RETAINED_PROBE'})];
  if(n===3)return [call('backtrack','keep',{checkpoint:1,keep_after_checkpoint:2,message:'TAIL_FINDING'})];
  assert.ok(!visible.includes('PRIVATE_SKILL_BODY'));
  assert.equal(visible.split('PUBLIC_SKILL_DESCRIPTION').length-1,1);
  if(n===4){
   assert.ok(visible.includes('RETAINED_PROBE'));
   assert.equal(visible.split('TAIL_FINDING').length-1,1);
   return [call('backtrack','nested',{checkpoint:0,message:'NESTED_FINDING '.repeat(100)})];
  }
  assert.ok(!visible.includes('RETAINED_PROBE'));
  assert.ok(visible.includes('NESTED_FINDING'));
  if(recovery==='overflow'&&n===5)return {error:'maximum context length exceeded'};
  return [text('Finished '.repeat(1000))];
 },'parallel',context=>{
  summaries.push(context);
  assert.doesNotMatch(JSON.stringify(context),/PRIVATE_SKILL_BODY|RETAINED_PROBE/);
  return {text:'SUMMARY NESTED_FINDING'};
 },[resolve(process.env.PI_DYNAMIC_SKILL_EXTENSION)]);
 const directory=join(host.cwd,'dynamic-skill','skills','dynamic-skill','skills','nested');
 await mkdir(directory,{recursive:true});skill=join(directory,'SKILL.md');
 await writeFile(skill,'---\nname: nested\ndescription: PUBLIC_SKILL_DESCRIPTION\n---\nPRIVATE_SKILL_BODY');
 if(recovery==='overflow')host.session.setAutoCompactionEnabled(true);
 await host.session.prompt('Explore then retain and fold again. '.repeat(100));
 assert.equal(host.requests.length,recovery==='overflow'?6:5);
 if(recovery==='manual')await host.session.compact();
 assert.ok(summaries.length>0);
 assert.deepEqual(host.compactions,[{reason:recovery,willRetry:recovery==='overflow'}]);
 const resumed=await host.reopen();await resumed.prompt('Continue after disk reopen');
 assert.equal(host.requests.length,recovery==='overflow'?7:6);
});
for(const mode of ['sequential','parallel'])for(const siblingFailure of [false,true])test(`public host folds independently (${mode}, sibling failure=${siblingFailure})`,async t=>{
 const host=await fixture(t,(n,ctx)=>{
  if(n===1)return [call('probe','read')];
  if(n===2)return [call('backtrack','fold',{checkpoint:1,message:'KEY_FINDING'}),...(siblingFailure?[call('fail','failure')]:[])];
  assert.equal(n,3);assert.ok(!JSON.stringify(ctx.messages).includes('SECRET_TOOL_BODY'));assert.ok(JSON.stringify(ctx.messages).includes('KEY_FINDING'));
  return [text('Done.')];
 },mode);
 await host.session.prompt('Task');assert.equal(host.requests.length,3,JSON.stringify({messages:host.session.messages,entries:host.sm.getEntries(),errors:host.errors}));assert.deepEqual(host.errors,[]);
 assert.equal(host.sm.getBranch().filter(e=>e.customType===POLICY).length,1);
 assert.ok(JSON.stringify(host.sm.getEntries()).includes('SECRET_TOOL_BODY'));
 if(siblingFailure)assert.ok(JSON.stringify(host.sm.getEntries()).includes('SIBLING_FAILURE'));
 assert.ok(!host.sm.getBranch().some(e=>e.type==='backtrack'));
});
test('public host continues after folding and preserves its usage snapshot across reload',async t=>{
 const host=await fixture(t,(n,ctx)=>{
  if(n===1)return [text('Answer text.'),call('backtrack','fold',{checkpoint:0,message:'DONE'})];
  assert.ok(!ctx.messages.some(message=>message.role==='assistant'&&message.content.some(part=>part.type==='toolCall'&&part.name==='backtrack')));
  assert.ok(JSON.stringify(ctx.messages).includes('DONE'));return [text('Continue.')];
 });
 await host.session.prompt('Question');assert.equal(host.requests.length,2);
 const snapshot=latestState({sessionManager:host.sm}).usage;
 assert.ok(snapshot.after>0);assert.equal(snapshot.afterEstimated,true);
 await host.session.reload();await host.session.prompt('Next');assert.equal(host.requests.length,3);assert.deepEqual(host.errors,[]);
 assert.deepEqual(latestState({sessionManager:host.sm}).usage,snapshot,'later responses must not overwrite the fold snapshot');
});
test('public host nested zero folds retain conclusions without raw tools',async t=>{
 const host=await fixture(t,(n,ctx)=>{
  if(n===1)return [call('probe','read')];
  if(n===2)return [call('backtrack','one',{checkpoint:1,message:'FIRST'})];
  if(n===3)return [call('backtrack','two',{checkpoint:0,message:'SECOND'})];
  assert.equal(n,4);assert.ok(!JSON.stringify(ctx.messages).includes('SECRET_TOOL_BODY'));assert.ok(JSON.stringify(ctx.messages).includes('SECOND'));return [text('Done')];
 });
 await host.session.prompt('Task');assert.equal(host.requests.length,4);assert.deepEqual(host.errors,[]);
});
test('public host retained tail keeps current backtrack call and adds no separate handoff',async t=>{
 const host=await fixture(t,(n,ctx)=>{
  if(n===1||n===2)return [call('probe',`read-${n}`)];
  if(n===3)return [call('backtrack','fold',{checkpoint:1,keep_after_checkpoint:2,message:'ONLY_ONCE'})];
  assert.equal(n,4);
  assert.equal(JSON.stringify(ctx.messages).split('ONLY_ONCE').length-1,1);
  assert.equal(JSON.stringify(ctx.messages).split('SECRET_TOOL_BODY').length-1,1);
  return [text('Done')];
 });
 await host.session.prompt('Task');assert.equal(host.requests.length,4);assert.deepEqual(host.errors,[]);
});

for(const keep of [false,true])test(`public compact summarizes effective history and retains safe raw tail (keep=${keep})`,async t=>{
 const summaries=[];
 const host=await fixture(t,(n,ctx)=>{
  if(n===1)return [call('probe','hidden')];
  if(keep&&n===2)return [call('probe','retained',{value:'KEPT_TOOL_BODY'})];
  if(n===(keep?3:2))return [call('backtrack','fold',{checkpoint:1,...(keep?{keep_after_checkpoint:2}:{}),message:'KEY_FINDING'})];
  assert.ok(!JSON.stringify(ctx.messages).includes('SECRET_TOOL_BODY'));
  return [text('SAFE_DONE '.repeat(1000))];
 },'parallel',(context)=>{summaries.push(context);return {text:'SUMMARY KEY_FINDING'};});
 await host.session.prompt('Task '.repeat(100));
 const compacted=await host.session.compact();
 assert.equal(compacted.usage.totalTokens,320*summaries.length);
 assert.ok(summaries.length>0);
 assert.ok(!JSON.stringify(summaries).includes('SECRET_TOOL_BODY'));
 await host.session.reload();await host.session.prompt('After compact');
 assert.ok(!JSON.stringify(host.requests.at(-1).messages).includes('SECRET_TOOL_BODY'));
 assert.deepEqual(host.errors,[]);
});

test('tree navigation restores policy branches without reviving removed tool bodies',async t=>{
 const host=await fixture(t,(n,context)=>{
  if(n===1)return [call('probe','hidden')];
  if(n===2)return [call('backtrack','fold',{checkpoint:1,message:'BRANCH_FINDING'})];
  const visible=JSON.stringify(context.messages);
  assert.ok(!visible.includes('SECRET_TOOL_BODY'));
  if(n===4)assert.ok(!visible.includes('BRANCH_FINDING'));
  else assert.ok(visible.includes('BRANCH_FINDING'));
  return [text('Done')];
 });
 await host.session.prompt('Initial task');
 const leaf=host.sm.getLeafId();
 const original=structuredClone(host.sm.getEntries());
 const user=original.find(entry=>entry.type==='message'&&entry.message.role==='user');
 assert.equal((await host.session.navigateTree(user.id,{summarize:false})).cancelled,false);
 await host.session.prompt('Alternative branch');
 assert.equal((await host.session.navigateTree(leaf,{summarize:false})).cancelled,false);
 await host.session.prompt('Resume folded branch');
 assert.equal(host.requests.length,5);
 for(const entry of original)assert.deepEqual(host.sm.getEntry(entry.id),entry);
});

test('native tree summary can revisit folded history and carry the backtrack handoff',async t=>{
 const host=await fixture(t,(n,context)=>{
  if(n===1)return [{type:'thinking',thinking:'FOLDED_REASONING'},call('probe','hidden')];
  if(n===2)return [call('backtrack','fold',{checkpoint:1,message:'TREE_HANDOFF'})];
  const visible=JSON.stringify(context.messages);
  if(n===3){
   assert.doesNotMatch(visible,/FOLDED_REASONING|SECRET_TOOL_BODY/);
   assert.match(visible,/TREE_HANDOFF/);
   return [text('Done')];
  }
  if(n===4){
   // Tree reviews the raw branch, like native compact/tree, not the working context.
   assert.match(visible,/FOLDED_REASONING/);
   assert.match(visible,/TREE_HANDOFF/); // Available through the original tool arguments.
   assert.doesNotMatch(visible,/SECRET_TOOL_BODY/); // Native branch summaries skip tool results.
   return [text('TREE_SUMMARY TREE_HANDOFF')];
  }
  assert.equal(n,5);
  assert.match(visible,/TREE_SUMMARY TREE_HANDOFF/);
  assert.doesNotMatch(visible,/FOLDED_REASONING|SECRET_TOOL_BODY/);
  return [text('Continued')];
 });
 await host.session.prompt('Initial task');
 assert.equal(host.requests.length,3);
 const original=structuredClone(host.sm.getEntries());
 const user=original.find(entry=>entry.type==='message'&&entry.message.role==='user');
 assert.equal((await host.session.navigateTree(user.id,{summarize:true})).cancelled,false);
 assert.equal(host.requests.length,4);
 const summary=host.sm.getBranch().findLast(entry=>entry.type==='branch_summary');
 assert.ok(summary);
 assert.match(summary.summary,/TREE_SUMMARY TREE_HANDOFF/);
 await host.session.prompt('Continue on the new branch');
 assert.equal(host.requests.length,5);
 for(const entry of original)assert.deepEqual(host.sm.getEntry(entry.id),entry);
});

for(const summarize of [false,true])test(`tree checkpoints follow the selected branch and remain callable (summary=${summarize})`,async t=>{
 let phase='initial',targetId,originalPolicyId,restoredTarget,foldedState;
 const state=session=>latestState({sessionManager:session.sessionManager});
 const host=await fixture(t,(n,context,session)=>{
  if(phase==='initial'){
   if(n===1)return [call('probe','history')];
   if(n===2)return [call('backtrack','original-fold',{checkpoint:1,message:'ORIGINAL_HANDOFF'})];
   return [text('Original branch complete')];
  }
  if(phase==='summary')return [text('TREE_SUMMARY')];
  const current=state(session),visible=JSON.stringify(context.messages);
  if(phase==='alternate'){
   restoredTarget=current.checkpoints.find(point=>point.boundary===targetId);
   assert.ok(restoredTarget,'the selected complete tool batch gets a checkpoint');
   assert.match(visible,new RegExp(`backtrack-checkpoint ${restoredTarget.id} context`));
   assert.ok(!current.checkpoints.some(point=>point.boundary===originalPolicyId),'the abandoned fold boundary is not active');
   assert.match(visible,/SECRET_TOOL_BODY/);
   assert.doesNotMatch(visible,/ORIGINAL_HANDOFF/);
   phase='after-alternate-fold';
   return [call('backtrack','alternate-fold',{checkpoint:restoredTarget.id,message:'ALTERNATE_HANDOFF'})];
  }
  if(phase==='after-alternate-fold'){
   assert.match(visible,/SECRET_TOOL_BODY/); // It is in the retained prefix, not the folded interval.
   assert.match(visible,/ALTERNATE_HANDOFF/);
   const policy=session.sessionManager.getBranch().findLast(entry=>entry.customType===POLICY);
   assert.equal(policy.data.anchorId,targetId);
   return [text('Alternate branch complete')];
  }
  assert.equal(phase,'original');
  assert.equal(current.epoch,foldedState.epoch);
  for(const point of foldedState.checkpoints)assert.deepEqual(current.checkpoints.find(p=>p.id===point.id),point);
  assert.doesNotMatch(visible,/SECRET_TOOL_BODY|ALTERNATE_HANDOFF/);
  assert.match(visible,/ORIGINAL_HANDOFF/);
  return [text('Original branch resumed')];
 });
 await host.session.prompt('Initial task');
 assert.equal(host.requests.length,3);
 const leaf=host.sm.getLeafId();
 foldedState=structuredClone(state(host.session));
 originalPolicyId=host.sm.getBranch().findLast(entry=>entry.customType===POLICY).id;
 targetId=host.sm.getBranch().find(entry=>entry.type==='message'&&entry.message.role==='toolResult'&&entry.message.toolName==='probe').id;
 phase='summary';
 assert.equal((await host.session.navigateTree(targetId,{summarize})).cancelled,false);
 phase='alternate';
 await host.session.prompt('Work from this historical batch');
 assert.equal(phase,'after-alternate-fold');
 assert.equal((await host.session.navigateTree(leaf,{summarize:false})).cancelled,false);
 phase='original';
 await host.session.prompt('Resume original branch');
 assert.equal(host.requests.length,summarize?7:6);
});

test('queued user input survives a registered fold and reaches the next request',async t=>{
 const host=await fixture(t,n=>n===1?[call('backtrack','fold',{checkpoint:0,message:'KEY_FINDING'})]:[text('Received')]);
 let queued=false;
 host.session.subscribe(event=>{
  if(event.type==='tool_execution_end'&&event.toolName==='backtrack'&&!queued){
   queued=true;void host.session.steer('NEWER_USER_INSTRUCTION');
  }
 });
 await host.session.prompt('Original instruction');
 assert.ok(queued);
 assert.equal(host.requests.length,2);
 assert.match(JSON.stringify(host.requests.at(-1).messages),/NEWER_USER_INSTRUCTION/);
 assert.match(JSON.stringify(host.requests.at(-1).messages),/KEY_FINDING/);
 assert.equal(host.sm.getBranch().filter(entry=>entry.customType===POLICY).length,1);
});

test('intact folded user images survive native reset and disk reopen until text-only compaction',async t=>{
 let compacted=false;
 const images=context=>context.messages.flatMap(message=>Array.isArray(message.content)?message.content:[]).filter(part=>part.type==='image');
 const image={type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII='};
 const host=await fixture(t,(n,context)=>{
  if(n===1){assert.deepEqual(images(context),[image],'host must deliver the original image before backtrack');return [call('backtrack','fold',{checkpoint:0,message:'IMAGE_FINDING'})];}
  assert.deepEqual(images(context),compacted?[]:[image]);
  return [text('Image finding '.repeat(1000))];
 },'parallel',context=>{assert.deepEqual(images(context),[]);return {text:'SUMMARY IMAGE_FINDING'};});
 await host.session.prompt('Inspect this image. '.repeat(100),{images:[image]});
 assert.deepEqual(host.errors,[]);
 assert.deepEqual(host.session.messages.filter(message=>message.role==='assistant'&&message.stopReason==='error').map(message=>message.errorMessage),[]);
 const reopened=await host.reopen();await reopened.prompt('Continue with image');
 await reopened.compact();compacted=true;await reopened.prompt('Continue');
 assert.equal(host.requests.length,4);
});

for(const compactBeforeFork of [false,true])test(`checkpoint deltas survive disk fork, reload, compact and resume (compact before fork=${compactBeforeFork})`,async t=>{
 let phase='initial';
 const host=await fixture(t,(n,context,session)=>{
  if(phase==='initial'&&n===1)return [call('probe','hidden')];
  if(phase==='initial'&&n===2)return [call('backtrack','fold',{checkpoint:1,message:'ORIGINAL_FINDING'})];
  assert.doesNotMatch(JSON.stringify(context.messages),/SECRET_TOOL_BODY/);
  if(phase==='fork'){
   const state=latestState({sessionManager:session.sessionManager});
   phase='continued';
   return [call('backtrack','fork-fold',{checkpoint:state.checkpoints[0].id,message:'FORK_FINDING'})];
  }
  if(phase==='continued')assert.match(JSON.stringify(context.messages),/FORK_FINDING/);
  return [text('Done '.repeat(1000))];
 },'parallel',context=>{
  const visible=JSON.stringify(context.messages);
  assert.doesNotMatch(visible,/SECRET_TOOL_BODY/);
  return {text:visible.includes('FORK_FINDING')?'SUMMARY FORK_FINDING':'SUMMARY ORIGINAL_FINDING'};
 });
 await host.session.prompt('Initial task '.repeat(100));
 if(compactBeforeFork){await host.session.compact();await host.session.prompt('After compact');}
 host.sm.appendLabelChange(host.sm.getLeafId(),'fork checkpoint');
 const sourceFile=host.sm.getSessionFile(),sourceState=latestState({sessionManager:host.sm});
 const sourceEntries=SessionManager.open(sourceFile).getEntries();
 const forkManager=SessionManager.open(sourceFile);
 const forkFile=forkManager.createBranchedSession(forkManager.getLeafId());
 assert.ok(forkFile);assert.notEqual(forkFile,sourceFile);
 let session=await host.reopen(forkFile);
 assert.deepEqual(latestState({sessionManager:session.sessionManager}),sourceState);
 phase='fork';await session.prompt('Continue fork');assert.equal(phase,'continued');
 const beforeReload=latestState({sessionManager:session.sessionManager});
 await session.reload();
 assert.deepEqual(latestState({sessionManager:session.sessionManager}),beforeReload);
 await session.prompt('After reload');await session.compact();await session.prompt('After fork compact');
 const beforeResume=latestState({sessionManager:session.sessionManager});
 session=await host.reopen(forkFile);
 assert.deepEqual(latestState({sessionManager:session.sessionManager}),beforeResume);
 await session.prompt('After resume');
 const source=SessionManager.open(sourceFile);
 assert.deepEqual(latestState({sessionManager:source}),sourceState);
 assert.deepEqual(source.getEntries(),sourceEntries);
});

test('summary failure leaves policies intact and a later retry succeeds',async t=>{
 let failing=true;const summaries=[];
 const host=await fixture(t,(n,ctx)=>{
  if(n===1)return [call('probe','hidden')];
  if(n===2)return [text('Answer'),call('backtrack','fold',{checkpoint:1,message:'KEY_FINDING'})];
  assert.ok(!JSON.stringify(ctx.messages).includes('SECRET_TOOL_BODY'));return [text('Done')];
 },'parallel',context=>{summaries.push(context);return failing?{error:'Invalid request: injected summary failure'}:{text:'SUMMARY KEY_FINDING'};});
 await host.session.prompt('Task '.repeat(100));
 assert.equal(host.requests.length,3);
 const before=JSON.stringify(host.sm.getEntries());
 await assert.rejects(host.session.compact(),/cancelled/i);
 assert.equal(JSON.stringify(host.sm.getEntries()),before);
 failing=false;
 const result=await host.session.compact();
 assert.ok(host.sm.getEntry(result.firstKeptEntryId),'compaction keeps a real persisted boundary');
 assert.ok(!JSON.stringify(summaries).includes('SECRET_TOOL_BODY'));
 await host.session.prompt('After compact');assert.deepEqual(host.errors,[]);
});
