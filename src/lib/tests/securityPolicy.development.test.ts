// @vitest-environment node
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { expectPageCsp, parseCsp } from './helpers/securityPolicy';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');

// Execute the real project config and the installed Kit CSP generator in fresh
// Node processes. No Vite test transform, cached config or developer env files.
// Kit's internal entry is intentionally isolated here, as in serverRequest.ts.
const generateHeader = `
  import { createRequire } from 'node:module';
  import { dirname, resolve } from 'node:path';
  import { pathToFileURL } from 'node:url';
  const require = createRequire(resolve('package.json'));
  globalThis.__SVELTEKIT_DEV__ = process.env.NODE_ENV === 'development';
  const kit = dirname(require.resolve('@sveltejs/kit/package.json'));
  const { Csp } = await import(pathToFileURL(resolve(kit, 'src/runtime/server/page/csp.js')).href);
  const { default: config } = await import(pathToFileURL(resolve('svelte.config.js')).href);
  const policy = new Csp({ ...config.kit.csp, reportOnly: config.kit.csp.reportOnly ?? {} }, { prerender: false });
  policy.add_script('console.log("test bootstrap")');
  process.stdout.write(JSON.stringify({ header: policy.csp_provider.get_header(), nonce: policy.nonce }));
`;

async function renderCsp(mode: 'development' | 'production'): Promise<{ header: string; nonce: string }> {
  const { stdout } = await execute(process.execPath, ['--input-type=module', '--eval', generateHeader], {
    cwd: root, env: { PATH: process.env.PATH ?? '', NODE_ENV: mode },
    timeout: 10_000, maxBuffer: 256 * 1024
  });
  return JSON.parse(stdout);
}

it('emits a valid dev style policy while retaining strict production attributes and bootstrap nonces', async () => {
  const [development, production] = await Promise.all([renderCsp('development'), renderCsp('production')]);
  const dev = parseCsp(development.header);
  const prod = expectPageCsp(new Headers({ 'Content-Security-Policy': production.header }));

  // Kit injects development styles. Its allowance must not coexist with 'none'.
  expect.soft(dev.get('style-src-attr')).toEqual(["'unsafe-inline'"]);
  expect.soft(dev.get('style-src')).toEqual(["'self'", "'unsafe-inline'"]);
  expect.soft(prod.get('style-src-attr')).toEqual(["'unsafe-hashes'", "'sha256-S8qMpvofolR8Mpjy4kQvEm7m1q8clzU4dfDH0AmvZjo='"]);
  expect.soft(prod.get('style-src')).toEqual(["'self'"]);

  for (const [mode, policy, nonce] of [
    ['development', dev, development.nonce], ['production', prod, production.nonce]
  ] as const) {
    for (const [directive, sources] of policy) {
      if (sources.includes("'none'")) {
        expect.soft(sources, `${mode}: ${directive} cannot mix 'none' with another source`).toEqual(["'none'"]);
      }
    }
    expect.soft(policy.get('script-src')).toEqual(["'self'", `'nonce-${nonce}'`]);
    expect.soft(Buffer.from(nonce, 'base64').byteLength).toBeGreaterThanOrEqual(16);
    for (const name of ['script-src-attr', 'base-uri', 'object-src', 'frame-src', 'frame-ancestors']) {
      expect.soft(policy.get(name), `${mode}: ${name}`).toEqual(["'none'"]);
    }
    expect.soft(policy.get('connect-src')).toEqual(["'self'"]);
    expect.soft(policy.get('font-src')).toEqual(["'self'"]);
  }
});
