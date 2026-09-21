// Integration only: neither product extension imports the other.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { expect, test } from 'vitest';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { getModel, streamSimple } from '@earendil-works/pi-ai/compat';
import { AgentSession, SessionManager, SettingsManager, convertToLlm, loadSkillsFromDir } from '@earendil-works/pi-coding-agent';
import { AuthStorage } from 'native-core/auth-storage';
import { createModelRegistry, getModelRuntime } from 'native-test/model-runtime-test-utils';
import { createTestExtensionsResult, createTestResourceLoader } from 'native-test/utilities';
import backtrack from '../src/index.ts';
import dynamicSkill from '../../pi-dynamic-skill/src/index.ts';
import { ACCESS_STATE, latestAccessState } from '../../pi-dynamic-skill/src/access.ts';
import { skillDetails, visibleSkills } from '../../pi-dynamic-skill/src/context.ts';

for (const order of ['skills-first', 'skills-last']) for (const mode of ['sequential', 'parallel'])
for (const keep of [false, true]) for (const retain of [false, true]) {
  test(`independent extensions: ${order}, ${mode}, keep=${keep}, retained description=${retain}`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'backtrack-skills-'));
    let session;
    try {
      const root = join(cwd, 'dynamic-skill', 'SKILL.md');
      const paths = ['a', 'b'].map(name => join(dirname(root), 'skills', name, 'SKILL.md'));
      for (const [path, name] of [[root, 'dynamic-skill'], [paths[0], 'a'], [paths[1], 'b']]) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `---\nname: ${name}\ndescription: ${name} description\n---\n`);
      }
      const sm = SessionManager.create(cwd, cwd);
      sm.appendMessage({ role: 'user', content: 'stable prefix', timestamp: 1 });
      sm.appendCustomEntry(ACCESS_STATE, { version: 1, active: [paths[0]], pendingEviction: [] });
      sm.appendCustomMessageEntry('dynamic-skill:context', 'Original loaded A', false,
        { id: 'original-a', paths: [paths[0]], pendingPaths: [] });
      const tools = pi => pi.registerTool({ name: 'read', label: 'read', description: 'fixture successful access',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        async execute() { return { content: [{ type: 'text', text: 'read completed' }], details: {} }; } });
      const extensionsResult = await createTestExtensionsResult(order === 'skills-first'
        ? [dynamicSkill, backtrack, tools] : [backtrack, tools, dynamicSkill], cwd);
      const resourceLoader = createTestResourceLoader({ extensionsResult });
      resourceLoader.getSkills = () => loadSkillsFromDir({ dir: dirname(root), source: 'test' });
      const auth = AuthStorage.create(join(cwd, 'auth.json'));
      await auth.modify('anthropic', async () => ({ type: 'api_key', key: 'test-key' }));
      const registry = await createModelRegistry(auth, cwd);
      session = new AgentSession({ agent: new Agent({ streamFn: streamSimple, convertToLlm,
        transformContext: messages => session.extensionRunner.emitContext(messages),
        initialState: { model: getModel('anthropic', 'claude-sonnet-4-5') } }),
        sessionManager: sm, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
        cwd, modelRuntime: getModelRuntime(registry), resourceLoader });
      const errors = [];
      await session.bindExtensions({ onError: error => errors.push(error) });
      session.agent.toolExecution = mode;
      session.agent.state.messages = sm.buildSessionContext().messages;
      const requests = [];
      session.agent.streamFunction = (model, context) => {
        requests.push(JSON.stringify(context.messages));
        const first = requests.length === 1;
        const message = { ...fauxAssistantMessage('done'), api: model.api, provider: model.provider, model: model.id,
          ...(first ? { content: [
            { type: 'toolCall', id: 'access', name: 'read', arguments: { path: paths[1] } },
            { type: 'toolCall', id: 'fold', name: 'backtrack', arguments: { checkpoint: retain ? 1 : 0,
              message: 'UNIQUE_HANDOFF', ...(keep ? { keep_after_checkpoint: 2 } : {}) } },
          ], stopReason: 'toolUse' } : {}) };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => stream.push({ type: 'done', reason: first ? 'toolUse' : 'stop', message }));
        return stream;
      };
      await session.prompt('start');
      expect(errors).toEqual([]);
      expect(requests).toHaveLength(2);
      const reduction = sm.getBranch().find(e => e.type === 'backtrack');
      expect(reduction).toBeDefined();
      expect(requests[1].includes('read completed')).toBe(keep);
      expect(requests[1].match(/UNIQUE_HANDOFF/g)).toHaveLength(1);
      expect(requests[1].match(/<name>b<\/name>/g)).toHaveLength(1);
      expect(requests[1].includes('Original loaded A')).toBe(retain);
      const messages = sm.buildSessionContext().messages;
      expect(new Set(visibleSkills(messages))).toEqual(new Set(paths));
      expect(new Set(skillDetails(messages.filter(skillDetails).at(-1)).paths)).toEqual(new Set(retain ? [paths[1]] : paths));
      expect(new Set(latestAccessState(sm.getBranch()).state.active)).toEqual(new Set(paths));
      const leaf = sm.getLeafId();
      await session.extensionRunner.emit({ type: 'session_backtrack', backtrackEntry: reduction });
      expect(sm.getLeafId()).toBe(leaf);
      expect(SessionManager.open(sm.getSessionFile()).buildSessionContext()).toEqual(sm.buildSessionContext());
    } finally { session?.dispose(); rmSync(cwd, { recursive: true, force: true }); }
  });
}
