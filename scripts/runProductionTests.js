import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PLATFORMS } from '../config/deploymentAdapters.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const tests = globSync('src/lib/tests/*.production.test.ts', { cwd: root }).sort();
if (tests.length === 0) throw new Error('No production tests found.');

for (const target of Object.keys(PLATFORMS)) {
  console.log(`\nProduction tests: ${target}`);
  const result = spawnSync(process.execPath, [vitest, 'run', ...tests, ...process.argv.slice(2)], {
    cwd: root,
    env: { ...process.env, PRODUCTION_TEST_TARGET: target },
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
