import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { getModel, streamSimple } from '@earendil-works/pi-ai/compat';
import { AgentSession, SessionManager, SettingsManager, convertToLlm } from '@earendil-works/pi-coding-agent';
import { AuthStorage } from 'native-core/auth-storage';
import { createModelRegistry, getModelRuntime } from 'native-test/model-runtime-test-utils';
import { createTestExtensionsResult, createTestResourceLoader } from 'native-test/utilities';
import backtrack from '../src/index.ts';
import { latestState } from '../src/engine.ts';

for (const mode of ['sequential', 'parallel']) for (const keep of [false, true]) for (const handoff of [undefined, '', ' ', 'UNIQUE_HANDOFF']) {
  test(`actual extension commits native fold, mode=${mode}, keep=${keep}, handoff=${handoff}`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'backtrack-native-'));
    let session;
    try {
      const sm = SessionManager.create(cwd, cwd);
      const tools = pi => pi.registerTool({ name: 'read', label: 'read', description: 'fixture read',
        parameters: { type: 'object', properties: {} },
        async execute(id) { return { content: [{ type: 'text', text: `RAW_${id}` }], details: {} }; } });
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
      const requests = [];
      session.agent.streamFunction = (model, context) => {
        requests.push(structuredClone(context.messages));
        const step = requests.length;
        const call = step <= 2 ? { type: 'toolCall', id: `read${step}`, name: 'read', arguments: {} }
          : { type: 'toolCall', id: 'fold', name: 'backtrack', arguments: { checkpoint: 1, ...(handoff === undefined ? {} : { message: handoff }), ...(keep ? { keep_after_checkpoint: 2 } : {}) } };
        const message = { ...fauxAssistantMessage('done'), api: model.api, provider: model.provider, model: model.id,
          ...(step <= 3 ? { content: [call], stopReason: 'toolUse' } : {}) };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => stream.push({ type: 'done', reason: step <= 3 ? 'toolUse' : 'stop', message }));
        return stream;
      };
      await session.prompt('initial task');
      expect(errors).toEqual([]); expect(requests).toHaveLength(4);
      const last = JSON.stringify(requests[3]);
      expect(last).not.toContain('RAW_read1');
      expect(last.includes('RAW_read2')).toBe(keep);
      expect(last.match(/UNIQUE_HANDOFF/g) ?? []).toHaveLength(handoff === 'UNIQUE_HANDOFF' ? 1 : 0);
      expect(last.includes('[Backtrack message — agent handoff]')).toBe(!keep);
      if (!keep) expect(sm.buildSessionContext().messages.find(m => m.customType === 'backtrack:continuation').content)
        .toBe(`[Backtrack message — agent handoff]\n${handoff ?? ''}`);
      expect(last).not.toContain('undefined');
      const reduction = sm.getBranch().find(e => e.type === 'backtrack');
      expect(reduction).toBeDefined();
      expect(reduction.details.state).not.toHaveProperty('view');
      expect(sm.getBranch().filter(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolCallId === 'fold')).toHaveLength(1);
      expect(sm.getBranch().find(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolCallId === 'fold').message.isError).toBeFalsy();
      const reopened = SessionManager.open(sm.getSessionFile());
      expect(reopened.buildSessionContext()).toEqual(sm.buildSessionContext());
      expect(latestState({ sessionManager: reopened }).checkpoints.map(c => c.id)).toEqual(keep ? [0, 1, 3, 4] : [0, 1, 4]);
      expect(last).not.toContain('Backtrack prepared');
      const resultText = keep
        ? 'Backtrack to checkpoint 1 succeeded. No separate handoff message was injected because raw context after checkpoint 2 is preserved. Refer to this tool call’s message argument.'
        : 'Backtrack applied.';
      const result = sm.getBranch().find(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolCallId === 'fold').message;
      expect(result.content).toEqual([{ type: 'text', text: resultText }]);
      expect(last.includes(resultText)).toBe(keep);
    } finally { session?.dispose(); rmSync(cwd, { recursive: true, force: true }); }
  });
}
