import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(process.env.PI_NATIVE_SOURCE || resolve(root, '../pi-native-backtrack'));
const vitest = resolve(source, 'node_modules/vitest/vitest.mjs');
if (!existsSync(vitest)) throw new Error('Native host test dependencies missing. Set PI_NATIVE_SOURCE to the prepared pi-native-backtrack source checkout.');
const result = spawnSync(process.execPath, ['--experimental-strip-types', vitest, 'run', '--config', resolve(root, 'test/native.config.mjs'), ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', env: { ...process.env, PI_NATIVE_SOURCE: source },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
