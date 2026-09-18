import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { backtrackDescription, backtrackSkillDescription } from '../dist/tool-description.js';

// Optional integration suite: point to an independently installed companion.
const skillExtension = process.env.PI_DYNAMIC_SKILL_EXTENSION;
const skillTest = (name, fn) => test(name, { skip: skillExtension ? false : 'Set PI_DYNAMIC_SKILL_EXTENSION to test the optional companion' }, fn);

const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { id: 'test', name: 'test', api: 'openai-completions', provider: 'backtrack-test', baseUrl: 'http://unused.invalid', reasoning: false,
  input: ['text', 'image'], contextWindow: 100000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const call = (name, args, id) => ({ type: 'toolCall', id, name, arguments: args });
const text = (text) => ({ type: 'text', text });
const flatten = (context) => JSON.stringify(context.messages);

async function setup(t, respond, { dynamic = false, reversed = false, persisted = false, compaction = false, injections = false, injectionFirst = true } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'backtrack-runtime-'));
  const agentDir = join(cwd, 'agent');
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(cwd, { recursive: true, force: true }); });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: compaction, keepRecentTokens: 100, reserveTokens: 4096 }, retry: { enabled: false } });
  const extensions = [resolve('src/index.ts'), ...(dynamic ? [resolve(skillExtension)] : [])];
  if (reversed) extensions.reverse();
  if (injections) {
    const path = join(cwd, 'request-injections.mjs');
    await writeFile(path, `export default function(pi) {
      pi.on('context', (event) => ({ messages: [
        { role: 'custom', customType: 'external-prefix', content: 'FIXED_EXTERNAL_PREFIX', display: false, timestamp: 0 },
        ...event.messages,
        { role: 'custom', customType: 'external-suffix', content: 'REQUEST_LOCAL_SUFFIX', display: false, timestamp: 0 }
      ] }));
    }`);
    if (injectionFirst) extensions.unshift(path); else extensions.push(path);
  }
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
    const response = options?.signal?.aborted ? { aborted: true }
      : respond(contexts.length, context, { cwd, agentDir, session, options });
    const content = Array.isArray(response) ? response : [];
    const stream = createAssistantMessageEventStream();
    const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
      usage: { ...usage }, stopReason: response.aborted ? 'aborted' : response.error ? 'error' : content.some((part) => part.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: Date.now(),
      ...(response.error ? { errorMessage: response.error } : {}) };
    stream.push(response.aborted ? { type: 'error', reason: 'aborted', error: message }
      : response.error ? { type: 'error', reason: 'error', error: message } : { type: 'done', reason: message.stopReason, message });
    stream.end();
    return stream;
  };
  t.after(() => {
    const failures = session.messages.filter((m) => m.role === 'assistant' && m.stopReason === 'error');
    assert.deepEqual(failures.map((m) => m.errorMessage), []);
  });
  return { cwd, agentDir, session, contexts, errors, loader };
}

for (const options of [{ dynamic: false }, { dynamic: true }, { dynamic: true, reversed: true }]) {
  (options.dynamic ? skillTest : test)(`tool description includes skill guidance only with the enabled service (${JSON.stringify(options)})`, async (t) => {
    const expected = backtrackDescription + (options.dynamic ? `\n\n${backtrackSkillDescription}` : '');
    const host = await setup(t, (_n, context) => {
      const tool = context.tools.find(tool => tool.name === 'backtrack');
      assert.equal(tool.description, expected);
      assert.doesNotMatch(tool.description, /if enabled|hard limits|minimums to fill/);
      return [text('Done.')];
    }, options);
    await host.session.prompt('Task.');
    await host.session.reload();
    await host.session.prompt('Another task.');
    assert.deepEqual(host.errors, []);
  });
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

for (const reversed of [false, true]) skillTest(`dynamic skills and checkpoint zero rebuild work in both extension orders (${reversed})`, async (t) => {
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

for (const reversed of [false, true]) for (const lifecycle of ['backtrack', 'compact', 'reload'])
skillTest(`manual selection injects next turn and silently expires at ${lifecycle} (${reversed})`, async (t) => {
  let shouldBacktrack = false;
  const host = await setup(t, () => {
    if (shouldBacktrack) {
      shouldBacktrack = false;
      return [call('backtrack', { checkpoint: 0, message: 'Continue.' }, 'manual-reset')];
    }
    return [text('A complete answer with sufficient context for compaction. '.repeat(100))];
  }, { dynamic: true, reversed });
  await host.session.prompt('Initial task with sufficient context. '.repeat(100));
  const path = join(host.agentDir, 'skills', 'dynamic-skill', 'skills', 'manual', 'SKILL.md');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '---\nname: manual\ndescription: MANUAL_SELECTED_DESCRIPTION\n---\nPRIVATE_SKILL_BODY\n');
  host.session.sessionManager.appendCustomEntry('dynamic-skill:manual-selection', { add: [path], remove: [] });
  await host.session.prompt('Use my selection');
  assert.match(flatten(host.contexts.at(-1)), /New active skills/);
  assert.match(flatten(host.contexts.at(-1)), /MANUAL_SELECTED_DESCRIPTION/);
  assert.doesNotMatch(flatten(host.contexts.at(-1)), /PRIVATE_SKILL_BODY/);
  host.session.sessionManager.appendCustomEntry('dynamic-skill:manual-selection', { add: [], remove: [path] });
  if (lifecycle === 'reload') await host.session.reload();
  if (lifecycle === 'compact') await host.session.compact();
  if (lifecycle === 'backtrack') shouldBacktrack = true;
  await host.session.prompt('Continue task');
  const state = host.session.sessionManager.getBranch().findLast((entry) => entry.type === 'custom' && entry.customType === 'dynamic-skill:access-state').data;
  assert.ok(!state.active.includes(path));
  assert.ok(!state.pendingEviction.includes(path));
  assert.equal(await readFile(path, 'utf8'), '---\nname: manual\ndescription: MANUAL_SELECTED_DESCRIPTION\n---\nPRIVATE_SKILL_BODY\n', 'manual eviction never deletes or rewrites the skill');
  assert.deepEqual(host.errors, []);
});

for (const injectionFirst of [false, true]) for (const target of [0, 1])
test(`node navigation preserves external context injections (first=${injectionFirst}, target=${target})`, async (t) => {
  let compacting = false;
  const host = await setup(t, (n, context) => {
    const source = flatten(context);
    if (compacting) {
      assert.doesNotMatch(source, /PRIVATE_TOOL_OUTPUT/);
      return [text('A compacted task baseline.')];
    }
    assert.equal((source.match(/FIXED_EXTERNAL_PREFIX/g) ?? []).length, 1);
    assert.equal((source.match(/REQUEST_LOCAL_SUFFIX/g) ?? []).length, 1);
    assert.match(JSON.stringify(context.messages[0]), /FIXED_EXTERNAL_PREFIX/);
    assert.match(JSON.stringify(context.messages.at(-1)), /REQUEST_LOCAL_SUFFIX/);
    if (n === 1) return [call('bash', { command: 'printf PRIVATE_TOOL_OUTPUT' }, 'explore')];
    if (n === 2) return [call('backtrack', { checkpoint: target, message: 'Continue from the selected node.' }, 'navigate')];
    assert.doesNotMatch(source, /PRIVATE_TOOL_OUTPUT/);
    return [text('Finished without another user intervention. '.repeat(100))];
  }, { injections: true, injectionFirst, persisted: true, dynamic: !!skillExtension });
  await host.session.prompt('Explore and navigate. '.repeat(100));
  assert.equal(host.contexts.length, 3);
  const entries = host.session.sessionManager.getBranch();
  assert.equal(entries.filter((entry) => entry.customType === 'backtrack:request:v1').length, 1);
  assert.equal(entries.some((entry) => entry.customType === 'backtrack:cancelled:v1'), false);
  assert.doesNotMatch(JSON.stringify(entries), /FIXED_EXTERNAL_PREFIX|REQUEST_LOCAL_SUFFIX/,
    'request-local additions must not become persistent source history');
  const frame = entries.findLast((entry) => entry.customType === 'backtrack:state:v1').data;
  assert.equal(typeof frame.cursor, 'string');
  assert.equal('inputKeys' in frame, false);
  assert.equal('revision' in frame, false);
  compacting = true;
  await host.session.compact();
  compacting = false;
  await host.session.prompt('Continue after compact.');
  await host.session.reload();
  await host.session.prompt('Continue after reload.');
  assert.deepEqual(host.errors, []);
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

for (const reversed of [false, true]) skillTest(`compact regenerates checkpoints internally and settles skills once (${reversed})`, async (t) => {
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

for (const reversed of [false, true]) skillTest(`compact then repeated zero rebuild keeps one fresh directory and a stable prefix (${reversed})`, async (t) => {
  let phase = 'initial', steps = 0, prefix, systemPrompt, tools, directoryContent;
  const host = await setup(t, (_n, context) => {
    if (phase === 'compact') {
      assert.doesNotMatch(flatten(context), /## Dynamic skills|Old active description|checkpoint 0/);
      assert.match(flatten(context), /Initial task/);
      return [text('A compact summary.')];
    }
    if (phase === 'reset') {
      steps++;
      if (steps === 1) {
        prefix = structuredClone(context.messages[0]);
        systemPrompt = context.systemPrompt;
        tools = JSON.stringify(context.tools);
        return [call('backtrack', { checkpoint: 0, message: 'Continue after the first reset.' }, 'reset-one')];
      }
      assert.deepEqual(context.messages[0], prefix, 'compact summary before zero stays unchanged');
      assert.equal(context.systemPrompt, systemPrompt);
      assert.equal(JSON.stringify(context.tools), tools);
      const source = flatten(context);
      assert.equal((source.match(/## Dynamic skills/g) ?? []).length, 1);
      assert.equal((source.match(/<name>diagnostics<\/name>/g) ?? []).length, 1);
      assert.doesNotMatch(source, /Root Skills|<name>project<\/name>/);
      assert.match(source, /Rebuilt active description/);
      assert.doesNotMatch(source, /Old active description/);
      assert.equal((source.match(/checkpoint 0/g) ?? []).length, 1);
      assert.equal((source.match(/checkpoint 1/g) ?? []).length, 1);
      const content = JSON.stringify(context.messages.find((message) => JSON.stringify(message.content).includes('## Dynamic skills')).content);
      if (steps === 2) {
        directoryContent = content;
        return [call('backtrack', { checkpoint: 0, message: 'Continue after the second reset.' }, 'reset-two')];
      }
      assert.equal(content, directoryContent, 'unchanged skill state rebuilds identical model-visible directory content');
      assert.equal(steps, 3);
    }
    if (phase === 'reload') {
      assert.equal((flatten(context).match(/## Dynamic skills/g) ?? []).length, 1);
      assert.match(flatten(context), /Rebuilt active description/);
      assert.doesNotMatch(flatten(context), /Old active description/);
    }
    return [text('A complete response. '.repeat(100))];
  }, { dynamic: true, reversed, persisted: true });
  const group = join(host.agentDir, 'skills', 'dynamic-skill', 'skills', 'project', 'SKILL.md');
  await mkdir(dirname(group), { recursive: true });
  await writeFile(group, '---\nname: project\ndescription: Root index entry\n---\n');
  const active = join(dirname(group), 'skills', 'diagnostics', 'SKILL.md');
  await mkdir(dirname(active), { recursive: true });
  await writeFile(active, '---\nname: diagnostics\ndescription: Old active description\n---\n');
  host.session.sessionManager.appendCustomEntry('dynamic-skill:access-state', { version: 1, active: [active], pendingEviction: [] });
  await host.session.prompt('Initial task. '.repeat(100));
  phase = 'compact';
  await host.session.compact();
  const frame = () => host.session.sessionManager.getBranch().findLast((entry) => entry.customType === 'backtrack:state:v1').data;
  const compactEpoch = frame().epoch;
  const settlements = () => host.session.sessionManager.getBranch().filter((entry) => entry.customType === 'dynamic-skill:access-state').length;
  const before = settlements();
  await writeFile(active, '---\nname: diagnostics\ndescription: Rebuilt active description\n---\n');
  phase = 'reset';
  await host.session.prompt('Reset the context.');
  assert.equal(steps, 3);
  assert.notEqual(frame().epoch, compactEpoch);
  assert.deepEqual(frame().checkpoints.map((checkpoint) => checkpoint.id), [0, 1]);
  assert.equal(settlements() - before, 2, 'each zero backtrack settles skills exactly once');
  phase = 'reload';
  await host.session.reload();
  await host.session.prompt('Continue after reload.');
  assert.deepEqual(host.errors, []);
});

for (const reversed of [false, true]) skillTest(`root children are discovered on demand and enter active skills after backtrack (${reversed})`, async (t) => {
  let root, child;
  const host = await setup(t, (n, context) => {
    assert.match(context.systemPrompt, /<name>dynamic-skill<\/name>/);
    assert.doesNotMatch(flatten(context), /### Root Skills/);
    if (n === 1) {
      assert.doesNotMatch(flatten(context), /Root child discovery/);
      return [call('read', { path: root }, 'read-root')];
    }
    if (n === 2) {
      const results = JSON.stringify(context.messages.filter(m => m.role === 'toolResult'));
      assert.match(results, /Root child discovery/);
      assert.match(results, /skills\/project\/SKILL.md/);
      return [call('read', { path: child }, 'read-child')];
    }
    if (n === 3) return [call('backtrack', { checkpoint: 0, message: 'Continue using the saved skill.' }, 'bt-child')];
    assert.match(flatten(context), /Active skills \(1\/20\)/);
    assert.equal((flatten(context).match(/Root child discovery/g) ?? []).length, 1);
    assert.doesNotMatch(flatten(context), /PRIVATE_CHILD_BODY/);
    return [text('Accessed child retained in active skills.')];
  }, { dynamic: true, reversed });
  root = join(host.agentDir, 'skills', 'dynamic-skill', 'SKILL.md');
  child = join(dirname(root), 'skills', 'project', 'SKILL.md');
  await mkdir(dirname(child), { recursive: true });
  await writeFile(child, '---\nname: project\ndescription: Root child discovery\n---\nPRIVATE_CHILD_BODY');
  await host.session.reload();
  await host.session.prompt('Find the available knowledge.');
  assert.deepEqual(host.errors, []);
});

for (const reversed of [false, true]) skillTest(`reload after aborted continuation shows new skill descriptions (${reversed})`, async (t) => {
  let path;
  const host = await setup(t, (n, context) => {
    if (n === 1) return [call('backtrack', { checkpoint: 0, message: 'Continue.' }, 'bt')];
    if (n === 2) return [call('read', { path }, 'skill-read')];
    if (n === 3) return { aborted: true };
    const directories = JSON.stringify(context.messages.filter(m => JSON.stringify(m.content).includes('## Dynamic skill')));
    assert.equal((directories.match(/NEW_ACTIVE_AFTER_ABORT/g) ?? []).length, 1);
    return [text('Finished.')];
  }, { dynamic: true, reversed, persisted: true });
  const group = join(host.agentDir, 'skills', 'dynamic-skill', 'skills', 'group', 'SKILL.md');
  await mkdir(dirname(group), { recursive: true });
  await writeFile(group, '---\nname: group\ndescription: Root index entry\n---\n');
  path = join(dirname(group), 'skills', 'new-active', 'SKILL.md');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '---\nname: new-active\ndescription: NEW_ACTIVE_AFTER_ABORT\n---\n');
  await host.session.prompt('Initial task.');
  await host.session.reload();
  await host.session.prompt('Continue after reload.');
  await host.session.reload();
  await host.session.prompt('Continue again.');
  assert.deepEqual(host.errors, []);
});

test('SDK reload exposes a failed commit status to the model exactly once', async (t) => {
  let recovering = false;
  const host = await setup(t, (_n, context) => {
    if (!recovering) return [call('backtrack', { checkpoint: 0, message: 'Continue.' }, 'bt')];
    const body = flatten(context);
    assert.equal((body.match(/Backtrack recovery — host status/g) ?? []).length, 1);
    assert.match(body, /INJECTED_STATE_WRITE_FAILURE/);
    assert.match(body, /Partial changes may remain/);
    return [text('Recovered.')];
  }, { persisted: true });
  const manager = host.session.sessionManager;
  const append = manager.appendCustomEntry.bind(manager);
  manager.appendCustomEntry = (type, data) => {
    if (type === 'backtrack:state:v1' && data.lastTransaction) throw new Error('INJECTED_STATE_WRITE_FAILURE');
    return append(type, data);
  };
  await host.session.prompt('Initial task.');
  assert.ok(host.contexts.slice(1).every(context => context.messages.length === 0),
    'failed commit must abort with an empty view, never send raw history');
  manager.appendCustomEntry = append;
  recovering = true;
  await host.session.reload();
  await host.session.prompt('Continue after reload.');
  await host.session.reload();
  await host.session.prompt('Continue again.');
  assert.deepEqual(host.errors, []);
});

test('images survive intact backtracked user input, but not text-only compact without a verbatim tail', async (t) => {
  let phase = 'initial';
  const images = context => context.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'image');
  const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' };
  const host = await setup(t, (n, context) => {
    if (phase === 'compact') {
      assert.deepEqual(images(context), []);
      return [text('Image task summary.')];
    }
    if (phase === 'after') {
      assert.deepEqual(images(context), []);
      return [text('Continue from summary.')];
    }
    if (n === 1) return [call('backtrack', { checkpoint: 0, message: 'Continue image task.' }, 'bt')];
    assert.deepEqual(images(context), [image]);
    return [text('Image task pending. '.repeat(100))];
  });
  await host.session.prompt('Inspect this image. '.repeat(100), { images: [image] });
  phase = 'compact';
  await host.session.compact();
  phase = 'after';
  await host.session.prompt('Continue.');
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
  }, { persisted: true, dynamic: !!skillExtension });
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

skillTest('saved skills survive backtrack, are discovered once, and read bodies are folded on a later backtrack', async (t) => {
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
