import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Run the modified host directly from source; never patch or install a global Pi.
const native = resolve(process.env.PI_NATIVE_SOURCE || '../pi-native-backtrack');

for (const mode of ['text', 'json', 'rpc']) test(`real CLI ${mode} mode backtracks and continues without user intervention`, { timeout: 30000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'backtrack-cli-'));
  const provider = join(cwd, 'provider.mjs');
  const ai = import.meta.resolve('@earendil-works/pi-ai');
  await writeFile(provider, `import { createAssistantMessageEventStream } from ${JSON.stringify(ai)};
export default function(pi) {
  let count = 0;
  pi.registerProvider('backtrack-cli-test', {
    api: 'openai-completions', baseUrl: 'http://unused.invalid', apiKey: 'test-only',
    models: [{ id: 'test', name: 'test', reasoning: false, input: ['text'],
      contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      count++;
      const source = JSON.stringify(context.messages);
      if (!source.includes('checkpoint 1')) throw new Error('Checkpoint missing in CLI model request');
      if (count === 2 && !source.includes('CLI_CONTINUATION')) throw new Error('Backtrack was not applied');
      if (count > 2) throw new Error('Unexpected additional generation');
      const content = count === 1
        ? [{ type: 'toolCall', id: 'backtrack-cli', name: 'backtrack', arguments: { checkpoint: 0, message: 'CLI_CONTINUATION' } }]
        : [{ type: 'text', text: 'CLI_COMPLETE' }];
      const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: count === 1 ? 'toolUse' : 'stop', timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(); return stream;
    }
  });
}
`);
  const args = [join(native, 'node_modules/tsx/dist/cli.mjs'), '--tsconfig', join(native, 'tsconfig.json'),
    join(native, 'packages/coding-agent/src/cli.ts'), '--mode', mode, '--no-session',
    '--provider', 'backtrack-cli-test', '--model', 'test', '-e', resolve('src/index.ts'), '-e', provider];
  if (mode !== 'rpc') args.push('-p', 'Complete the task.');
  const child = spawn(process.execPath, args, { cwd, detached: process.platform !== 'win32',
    env: { ...process.env, PI_CODING_AGENT_DIR: join(cwd, 'agent') }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL'); // tsx also owns a child process
      await closed;
    }
    await rm(cwd, { recursive: true, force: true, maxRetries: 3 });
  });
  let stdout = '', stderr = '', buffer = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolveDone, reject) => {
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolveDone() : reject(new Error(`CLI exited ${code}: ${stderr}\n${stdout}`)));
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (mode !== 'rpc') return;
      buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n');
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'agent_settled') resolveDone();
          if (event.type === 'response' && event.success === false) reject(new Error(line));
        } catch (error) { reject(error); }
      }
    });
  });
  if (mode === 'rpc') child.stdin.write(JSON.stringify({ type: 'prompt', id: 'test', message: 'Complete the task.' }) + '\n');
  else child.stdin.end();
  await done;
  assert.match(stdout, /CLI_COMPLETE/, stderr + '\n' + stdout);
  assert.doesNotMatch(stdout, /Checkpoint missing|Backtrack was not applied|Unexpected additional generation/);
});
