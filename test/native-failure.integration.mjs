import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { getModel, streamSimple } from '@earendil-works/pi-ai/compat';
import { AgentSession, SessionManager, SettingsManager, convertToLlm } from '@earendil-works/pi-coding-agent';
import { AuthStorage } from 'native-core/auth-storage';
import { createModelRegistry, getModelRuntime } from 'native-test/model-runtime-test-utils';
import { createTestExtensionsResult, createTestResourceLoader } from 'native-test/utilities';
import backtrack from '../src/index.ts';

const call = (name, id, args = {}) => ({ type: 'toolCall', name, id, arguments: args });
const fold = (id = 'fold', args = {}) => call('backtrack', id, { checkpoint: 0, message: 'HANDOFF', ...args });

async function fixture(run, mode, calls, configure = () => {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'backtrack-failure-'));
  let session;
  try {
    const sm = SessionManager.create(cwd, cwd);
    const tools = pi => {
      for (const name of ['save', 'failure', 'abort']) pi.registerTool({ name, label: name, description: name,
        parameters: { type: 'object', properties: {} },
        async execute() {
          if (name === 'failure') throw new Error('FAILED_SIBLING');
          if (name === 'save') writeFileSync(join(cwd, 'saved'), 'PERSISTED_SIDE_EFFECT');
          if (name === 'abort') session.agent.abort();
          return { content: [{ type: 'text', text: name === 'save' ? 'PERSISTED_SIDE_EFFECT' : name }], details: {} };
        } });
    };
    const extensionsResult = await createTestExtensionsResult([backtrack, tools], cwd);
    const auth = AuthStorage.create(join(cwd, 'auth.json'));
    await auth.modify('anthropic', async () => ({ type: 'api_key', key: 'test-key' }));
    const registry = await createModelRegistry(auth, cwd);
    session = new AgentSession({ agent: new Agent({ streamFn: streamSimple, convertToLlm,
      transformContext: messages => session.extensionRunner.emitContext(messages),
      initialState: { model: getModel('anthropic', 'claude-sonnet-4-5') } }),
      sessionManager: sm, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }), cwd,
      modelRuntime: getModelRuntime(registry), resourceLoader: createTestResourceLoader({ extensionsResult }) });
    const errors = [];
    await session.bindExtensions({ onError: error => errors.push(error) });
    session.agent.toolExecution = mode;
    const requests = [], published = [];
    session.subscribe(event => { if (event.type === 'tool_execution_end') published.push(event); });
    session.agent.streamFunction = (model, context) => {
      requests.push(structuredClone(context.messages));
      const first = requests.length === 1;
      const message = { ...fauxAssistantMessage('done'), api: model.api, provider: model.provider, model: model.id,
        ...(first ? { content: calls, stopReason: 'toolUse' } : {}) };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({ type: 'done', reason: first ? 'toolUse' : 'stop', message }));
      return stream;
    };
    const host = { session, sm, cwd, requests, published, errors };
    await configure(host);
    await session.prompt('ORIGINAL_USER');
    expect(errors).toEqual([]);
    expect(SessionManager.open(sm.getSessionFile()).buildSessionContext()).toEqual(sm.buildSessionContext());
    await run(host);
  } finally { vi.restoreAllMocks(); session?.dispose(); rmSync(cwd, { recursive: true, force: true }); }
}

for (const mode of ['sequential', 'parallel']) for (const first of [false, true]) {
  test(`failed sibling prevents fold, retains real writes (${mode}, first=${first})`, async () => {
    const siblings = [call('save', 'save'), call('failure', 'failure')];
    await fixture(({ sm, cwd, requests, published }) => {
      expect(readFileSync(join(cwd, 'saved'), 'utf8')).toBe('PERSISTED_SIDE_EFFECT');
      expect(sm.getBranch().some(e => e.type === 'backtrack')).toBe(false);
      expect(published.find(e => e.toolCallId === 'fold').isError).toBe(true);
      expect(requests).toHaveLength(2);
      const last = JSON.stringify(requests[1]);
      expect(last).toContain('FAILED_SIBLING');
      expect(last).toContain('Backtrack failed: A tool in the batch failed');
      expect(last).not.toContain('Backtrack applied.');
    }, mode, first ? [fold(), ...siblings] : [...siblings, fold()]);
  });
  test(`successful siblings persist before fold without undoing writes (${mode}, first=${first})`, async () => {
    await fixture(({ sm, cwd, requests, published }) => {
      expect(readFileSync(join(cwd, 'saved'), 'utf8')).toBe('PERSISTED_SIDE_EFFECT');
      const branch = sm.getBranch(), reduction = branch.findIndex(e => e.type === 'backtrack');
      expect(reduction).toBeGreaterThan(0);
      for (const id of ['save', 'fold']) {
        const results = branch.filter(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolCallId === id);
        expect(results).toHaveLength(1);
        expect(branch.indexOf(results[0])).toBeLessThan(reduction);
      }
      expect(published.every(e => !e.isError)).toBe(true);
      expect(JSON.stringify(requests[1])).not.toContain('PERSISTED_SIDE_EFFECT');
    }, mode, first ? [fold(), call('save', 'save')] : [call('save', 'save'), fold()]);
  });
}

for (const mode of ['sequential', 'parallel']) {
  for (const failure of ['storage', 'invalid', 'duplicate', 'abort']) test(`actual extension fails closed on ${failure} (${mode})`, async () => {
    const calls = failure === 'duplicate' ? [fold(), call('save', 'save'), fold('second')]
      : failure === 'abort' ? [fold(), call('abort', 'abort')]
      : [fold('fold', failure === 'invalid' ? { checkpoint: 999 } : {})];
    await fixture(async ({ sm, session, requests, published }) => {
      expect(sm.getBranch().some(e => e.type === 'backtrack')).toBe(false);
      expect(published.find(e => e.toolCallId === 'fold').isError).toBe(true);
      expect(sm.getBranch().some(e => e.customType?.includes('recovery') || e.customType?.includes('cancelled'))).toBe(false);
      if (failure === 'storage') {
        expect(requests).toHaveLength(2);
        expect(JSON.stringify(requests[1])).toContain('Backtrack failed: INJECTED_DISK_FAILURE');
        await session.prompt('Continue after failure');
        expect(JSON.stringify(requests.at(-1)).match(/Backtrack failed: INJECTED_DISK_FAILURE/g)).toHaveLength(1);
        expect(JSON.stringify(requests.at(-1))).not.toContain('Backtrack applied.');
      }
    }, mode, calls, ({ sm }) => {
      if (failure === 'storage') vi.spyOn(sm, 'appendBacktrackBatch').mockImplementationOnce(() => { throw new Error('INJECTED_DISK_FAILURE'); });
    });
  });
  test(`user input queued at publication survives committed fold (${mode})`, async () => {
    let queued = false;
    await fixture(({ sm, requests }) => {
      expect(queued).toBe(true);
      expect(sm.getBranch().filter(e => e.type === 'backtrack')).toHaveLength(1);
      expect(JSON.stringify(requests.at(-1))).toContain('NEWER_USER_INSTRUCTION');
      expect(sm.getBranch().filter(e => e.type === 'message' && e.message.role === 'user'
        && JSON.stringify(e.message.content).includes('NEWER_USER_INSTRUCTION'))).toHaveLength(1);
    }, mode, [fold()], ({ session }) => {
      session.subscribe(event => {
        if (event.type === 'tool_execution_end' && event.toolName === 'backtrack' && !queued) {
          queued = true;
          void session.steer('NEWER_USER_INSTRUCTION');
        }
      });
    });
  });
}
