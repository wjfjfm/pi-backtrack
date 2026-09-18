import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { id: 'test', name: 'test', api: 'openai-completions', provider: 'backtrack-test', baseUrl: 'http://unused.invalid', reasoning: false,
  input: ['text', 'image'], contextWindow: 100000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const call = (name, args, id) => ({ type: 'toolCall', id, name, arguments: args });
const text = (text) => ({ type: 'text', text });
const flatten = (context) => JSON.stringify(context.messages);

async function setup(t, respond, { dynamic = false, reversed = false, persisted = false, compaction = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'backtrack-runtime-'));
  const agentDir = join(cwd, 'agent');
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(cwd, { recursive: true, force: true }); });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: compaction, keepRecentTokens: 100, reserveTokens: 4096 }, retry: { enabled: false } });
  const extensions = [resolve('src/index.ts'), ...(dynamic ? [resolve('node_modules/pi-dynamic-skill/src/index.ts')] : [])];
  if (reversed) extensions.reverse();
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths: extensions, noContextFiles: true,
    extensionFactories: [(pi) => pi.registerProvider('backtrack-test', { apiKey: 'test-key', api: model.api, baseUrl: model.baseUrl, models: [model] })] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const sessionManager = persisted ? SessionManager.create(cwd, join(cwd, 'sessions')) : SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager, model });
  t.after(() => session.dispose());
  const errors = [];
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  const contexts = [];
  session.agent.streamFunction = (_model, context, options) => {
    contexts.push(JSON.parse(JSON.stringify(context)));
    const response = respond(contexts.length, context, { cwd, agentDir, session, options });
    const content = Array.isArray(response) ? response : [];
    const stream = createAssistantMessageEventStream();
    const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
      usage: { ...usage }, stopReason: response.error ? 'error' : content.some((part) => part.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: Date.now(),
      ...(response.error ? { errorMessage: response.error } : {}) };
    stream.push(response.error ? { type: 'error', reason: 'error', error: message } : { type: 'done', reason: message.stopReason, message });
    stream.end();
    return stream;
  };
  t.after(() => {
    const failures = session.messages.filter((m) => m.role === 'assistant' && m.stopReason === 'error');
    assert.deepEqual(failures.map((m) => m.errorMessage), []);
  });
  return { cwd, agentDir, session, contexts, errors, loader };
}

test('one prompt explores, backtracks in place, and automatically continues on the effective context', async (t) => {
  const host = await setup(t, (n, context, { cwd }) => {
    if (n === 1) {
      assert.match(flatten(context), /checkpoint 0/);
      assert.match(flatten(context), /checkpoint 1/);
      return [text('Investigating.'), call('bash', { command: 'printf SECRET_TOOL_OUTPUT' }, 'tool-1')];
    }
    if (n === 2) {
      assert.match(flatten(context), /SECRET_TOOL_OUTPUT/);
      assert.match(flatten(context), /checkpoint 2/);
      return [call('backtrack', { checkpoint: 1, message: 'Continue with the conclusion.' }, 'backtrack-1')];
    }
    assert.equal(n, 3);
    assert.doesNotMatch(flatten(context), /SECRET_TOOL_OUTPUT/);
    assert.match(flatten(context), /assistant: Investigating/);
    assert.match(flatten(context), /Continue with the conclusion/);
    assert.match(flatten(context), /checkpoint 3/);
    return [text('Finished.')];
  });
  await host.session.prompt('Investigate this task.');
  assert.equal(host.contexts.length, 3, JSON.stringify({ messages: host.session.messages, errors: host.errors }));
  assert.deepEqual(host.errors, []);
  const entries = host.session.sessionManager.getEntries();
  assert.match(JSON.stringify(entries), /SECRET_TOOL_OUTPUT/);
  assert.equal(entries.some((e) => e.type === 'branch_summary'), false);
  assert.equal(entries.filter((e) => e.type === 'custom' && e.customType === 'backtrack:state:v1').at(-1).data.lastTransaction !== undefined, true);
});

for (const reversed of [false, true]) test(`dynamic skills and checkpoint zero rebuild work in both extension orders (${reversed})`, async (t) => {
  const host = await setup(t, (n, context) => {
    const source = flatten(context);
    if (n === 1) {
      assert.ok(source.indexOf('checkpoint 0') < source.indexOf('Dynamic skills'));
      assert.ok(source.indexOf('Dynamic skills') < source.indexOf('Initial user prompt'));
      return [call('backtrack', { checkpoint: 0, message: 'Continue after a fresh start.' }, 'reset')];
    }
    assert.equal(n, 2);
    assert.equal((source.match(/checkpoint 0/g) ?? []).length, 1);
    assert.equal((source.match(/checkpoint 1/g) ?? []).length, 1);
    assert.equal((source.match(/## Dynamic skills/g) ?? []).length, 1);
    assert.match(source, /user: Initial user prompt/);
    assert.match(source, /Continue after a fresh start/);
    return [text('Done.')];
  }, { dynamic: true, reversed });
  await host.session.prompt('Initial user prompt');
  assert.deepEqual(host.errors, []);
  assert.equal(host.contexts.length, 2, JSON.stringify({ messages: host.session.messages, errors: host.errors }));
});

test('backtrack with sibling tools is rejected; tools remain paired and history is unchanged', async (t) => {
  const host = await setup(t, (n, context) => {
    if (n === 1) return [call('backtrack', { checkpoint: 0, message: 'Nope' }, 'bad'), call('bash', { command: 'printf STILL_HERE' }, 'other')];
    assert.match(flatten(context), /only tool call/);
    assert.match(flatten(context), /STILL_HERE/);
    return [text('Recovered.')];
  });
  await host.session.prompt('Check isolation.');
  assert.equal(host.session.sessionManager.getBranch().some((entry) => entry.customType === 'backtrack:request:v1'), false);
  assert.deepEqual(host.errors, []);
});

test('native compact summarizes effective context, not removed tools; regenerates checkpoints', async (t) => {
  let summarizing = false;
  const host = await setup(t, (n, context) => {
    if (summarizing) {
      assert.doesNotMatch(flatten(context), /SECRET_TOOL_OUTPUT/);
      return [text('A compact summary of the task.')];
    }
    if (n === 1) return [call('bash', { command: 'printf SECRET_TOOL_OUTPUT' }, 'read')];
    if (n === 2) return [call('backtrack', { checkpoint: 0, message: 'Now finish.' }, 'reset')];
    return [text('Done with this investigation. '.repeat(100))];
  });
  await host.session.prompt('Explore then condense.');
  summarizing = true;
  await host.session.compact();
  summarizing = false;
  await host.session.prompt('Continue after compact.');
  const latest = flatten(host.contexts.at(-1));
  assert.match(latest, /A compact summary/);
  assert.doesNotMatch(latest, /SECRET_TOOL_OUTPUT/);
  assert.match(latest, /checkpoint 0/);
  assert.match(latest, /checkpoint 1/);
  assert.deepEqual(host.errors, []);
});

for (const reversed of [false, true]) test(`compact regenerates checkpoints internally and settles skills once (${reversed})`, async (t) => {
  let compacting = false;
  const host = await setup(t, (_n, context) => {
    if (compacting) return [text('A fresh compacted baseline.')];
    return [text('A complete answer with enough content for compaction. '.repeat(100))];
  }, { dynamic: true, reversed });
  await host.session.prompt('A task with sufficient context. '.repeat(100));
  const count = () => host.session.sessionManager.getBranch().filter((e) => e.customType === 'dynamic-skill:access-state').length;
  const before = count();
  compacting = true;
  await host.session.compact();
  compacting = false;
  assert.equal(count() - before, 1);
  const frame = host.session.sessionManager.getBranch().filter((e) => e.customType === 'backtrack:state:v1').at(-1).data;
  assert.deepEqual(frame.checkpoints.map((checkpoint) => checkpoint.id), [0, 1]);
  await host.session.prompt('Continue.');
  const source = flatten(host.contexts.at(-1));
  assert.equal((source.match(/## Dynamic skills/g) ?? []).length, 1);
  assert.ok(source.indexOf('checkpoint 0') < source.indexOf('## Dynamic skills'));
  assert.deepEqual(host.errors, []);
});

test('failed native compaction leaves the checkpoint epoch and effective history usable', async (t) => {
  let failCompact = false;
  const host = await setup(t, (_n, context) => failCompact ? { error: 'Deliberate summarizer failure' }
    : [text('A complete response to preserve. '.repeat(100))]);
  await host.session.prompt('Initial context. '.repeat(100));
  const frame = () => host.session.sessionManager.getBranch().filter((e) => e.customType === 'backtrack:state:v1').at(-1).data;
  const epoch = frame().epoch;
  failCompact = true;
  await assert.rejects(host.session.compact(), /Deliberate summarizer failure/);
  assert.equal(frame().epoch, epoch);
  assert.equal(host.session.sessionManager.getBranch().some((e) => e.type === 'compaction'), false);
  failCompact = false;
  await host.session.prompt('Continue on the original context.');
  assert.match(flatten(host.contexts.at(-1)), /A complete response to preserve/);
  assert.deepEqual(host.errors, []);
});

test('reload preserves a committed backtrack and keeps old tool output out of later requests', async (t) => {
  const host = await setup(t, (n, context) => {
    if (n === 1) return [call('bash', { command: 'printf ARCHIVED_SECRET' }, 'tool')];
    if (n === 2) return [call('backtrack', { checkpoint: 0, message: 'Resume here.' }, 'bt')];
    assert.doesNotMatch(flatten(context), /ARCHIVED_SECRET/);
    assert.match(flatten(context), /Resume here/);
    return [text('Ready.')];
  }, { persisted: true, dynamic: true });
  await host.session.prompt('First request');
  const file = host.session.sessionManager.getSessionFile();
  assert.match(await readFile(file, 'utf8'), /ARCHIVED_SECRET/);
  await host.session.reload();
  await host.session.prompt('Second request');
  assert.equal(host.contexts.length, 4);
  assert.deepEqual(host.errors, []);
  assert.equal(host.session.sessionManager.getBranch().filter((e) => e.customType === 'backtrack:cancelled:v1').length, 0);
});

test('invalid and legacy arguments fail without preparing or changing the effective history', async (t) => {
  const host = await setup(t, (n, context) => {
    if (n === 1) return [call('backtrack', { checkpoint: 999, message: 'Unknown' }, 'invalid')];
    if (n === 2) {
      assert.match(flatten(context), /not active/);
      return [call('backtrack', { checkpoint: 0, message: 'old', description: 'old', knowledge: 'old' }, 'legacy')];
    }
    assert.match(flatten(context), /error|Error|requires only/);
    return [text('Continue normally.')];
  });
  await host.session.prompt('Keep this user input');
  assert.equal(host.contexts.length, 3);
  assert.equal(host.session.sessionManager.getBranch().some((e) => e.customType === 'backtrack:request:v1'), false);
});

test('queued user input cancels a prepared backtrack rather than swallowing the new request', async (t) => {
  const host = await setup(t, (n, context) => n === 1
    ? [call('backtrack', { checkpoint: 0, message: 'Should not apply' }, 'cancel')]
    : [text('I received the newer instruction.')]);
  let queued = false;
  host.session.subscribe((event) => {
    if (event.type === 'tool_execution_end' && event.toolName === 'backtrack' && !queued) {
      queued = true;
      void host.session.steer('Newer user instruction');
    }
  });
  await host.session.prompt('Original user instruction');
  assert.ok(queued);
  assert.match(flatten(host.contexts.at(-1)), /Newer user instruction/);
  const branch = host.session.sessionManager.getBranch();
  assert.ok(branch.some((e) => e.customType === 'backtrack:cancelled:v1'));
  assert.equal(branch.some((e) => e.customType === 'backtrack:state:v1' && e.data.lastTransaction), false);
});

test('saved skills survive backtrack, are discovered once, and read bodies are folded on a later backtrack', async (t) => {
  let skill;
  const host = await setup(t, (n, context, { agentDir }) => {
    const source = flatten(context);
    const group = join(agentDir, 'skills', 'dynamic-skill', 'skills', 'project', 'SKILL.md');
    skill = join(dirname(group), 'skills', 'finding', 'SKILL.md');
    if (n === 1) return [
      call('write', { path: group, content: '---\nname: project\ndescription: Project knowledge\n---\n' }, 'group'),
      call('write', { path: skill, content: '---\nname: finding\ndescription: Reusable finding\n---\nSECRET_KNOWLEDGE_BODY\n' }, 'finding'),
    ];
    if (n === 2) return [call('backtrack', { checkpoint: 1, message: 'Use saved findings.' }, 'first')];
    if (n === 3) {
      assert.match(source, /New active skills/);
      assert.equal((source.match(/<name>finding<\/name>/g) ?? []).length, 1);
      assert.doesNotMatch(source, /SECRET_KNOWLEDGE_BODY/);
      return [call('read', { path: skill }, 'read-finding')];
    }
    if (n === 4) {
      assert.match(source, /SECRET_KNOWLEDGE_BODY/);
      return [call('backtrack', { checkpoint: 3, message: 'Finish using retained descriptions.' }, 'second')];
    }
    assert.equal(n, 5);
    assert.equal((source.match(/<name>finding<\/name>/g) ?? []).length, 1);
    assert.doesNotMatch(source, /SECRET_KNOWLEDGE_BODY/);
    return [text('Finished with saved knowledge.')];
  }, { dynamic: true, reversed: true });
  await host.session.prompt('Save the useful finding before backtracking.');
  assert.equal(host.contexts.length, 5);
  assert.match(await readFile(skill, 'utf8'), /SECRET_KNOWLEDGE_BODY/);
  assert.deepEqual(host.errors, []);
});


test('provider context overflow after backtrack follows native compact and retries without replaying backtrack', async (t) => {
  const host = await setup(t, (n, context) => {
    if (n === 1) return [text('Exploration commentary. '.repeat(100)), call('backtrack', { checkpoint: 0, message: 'Continue the work.' }, 'once')];
    if (n === 2) return { error: 'This model maximum context length is 100000 tokens; the request exceeds the context window.' };
    if (n === 3) return [text('Compacted continuation state.')];
    assert.equal(n, 4);
    assert.match(flatten(context), /Compacted continuation state/);
    return [text('Successfully continued.')];
  }, { compaction: true });
  await host.session.prompt('Some initial context. '.repeat(100));
  assert.equal(host.contexts.length, 4);
  const branch = host.session.sessionManager.getBranch();
  assert.equal(branch.filter((e) => e.customType === 'backtrack:request:v1').length, 1);
  assert.equal(branch.filter((e) => e.type === 'compaction').length, 1);
  assert.deepEqual(host.errors, []);
});
