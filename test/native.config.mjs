import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const native = resolve(process.env.PI_NATIVE_SOURCE || resolve(root, '../pi-native-backtrack'));
const { mergeConfig } = await import(pathToFileURL(resolve(native, 'node_modules/vitest/dist/config.js')).href);
const { default: config } = await import(pathToFileURL(resolve(native, 'packages/coding-agent/vitest.config.ts')).href);
export default mergeConfig(config, {
  root,
  test: { include: ['test/*.integration.mjs'] },
  resolve: { alias: [
    { find: /^native-core\/(.+)$/, replacement: `${native}/packages/coding-agent/src/core/$1.ts` },
    { find: /^vitest$/, replacement: `${native}/node_modules/vitest/dist/index.js` },
    { find: /^native-test\/(.+)$/, replacement: `${native}/packages/coding-agent/test/$1.ts` },
    { find: /^@earendil-works\/pi-coding-agent$/, replacement: `${native}/packages/coding-agent/src/index.ts` },
    { find: /^@earendil-works\/pi-ai\/utils\/(.+)$/, replacement: `${native}/packages/ai/src/utils/$1.ts` },
  ] },
});
