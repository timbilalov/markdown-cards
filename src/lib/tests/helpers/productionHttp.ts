import { execFile, fork, type ChildProcess } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';

export const productionOrigin = 'https://app.example.invalid';
export const productionCredentials = { username: 'test-user', password: 'cycle13-test-password' };
export const productionSessionSecret = '88'.repeat(32);
export const productionPrivateCloudToken = 'production-private-cloud-token';
export const productionLegacyClientToken = 'production-legacy-client-token';
export const productionPasswordHash = '$2b$04$dOefitQKRsCSxLbUpW2PDOmCn802Xp74FT5jKLLIqfCTxWQZs1cV6';

export interface ProductionRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  bodyBytes?: number[];
  form?: Record<string, string>;
}

export interface ProductionResponse {
  status: number;
  headers: Record<string, string>;
  cookies: string[];
  text: string;
  bodyUsed: boolean;
  effects: {
    requests: { url: string; method: string }[];
    writes: { path: string; source: string; overwrite: boolean }[];
    remote: Record<string, string>;
    unexpected: string[];
    databaseOpens: number;
  };
}

type ProductionWorkerCommand = { request: ProductionRequest } | { reset: Record<string, string> };
export type ProductionWorkerMessage = { id: number } & ProductionWorkerCommand;

interface WorkerReply {
  id?: number;
  ready?: boolean;
  result?: ProductionResponse;
  error?: string;
}

const execute = promisify(execFile);

const productionTargets: Record<string, {
  publicDirectory: string;
  resolveEntry: (directory: string) => Promise<string>;
}> = {
  vercel: {
    publicDirectory: '.vercel/output/static',
    async resolveEntry(directory) {
      const functionDirectory = join(directory, '.vercel/output/functions/![-]/catchall.func');
      const configuration = JSON.parse(await readFile(join(functionDirectory, '.vc-config.json'), 'utf8')) as { handler: string };
      return resolve(functionDirectory, configuration.handler);
    }
  },
  netlify: {
    publicDirectory: 'build',
    async resolveEntry(directory) {
      return join(directory, '.netlify/functions-internal/sveltekit-render.mjs');
    }
  }
};

// Build the actual working sources/config in isolation on every suite invocation.
// Never consume stale repository output or load the developer's env files.
export async function createProductionHttp() {
  const root = resolve(import.meta.dirname, '../../../..');
  const target = process.env.PRODUCTION_TEST_TARGET ?? 'vercel';
  if (!Object.hasOwn(productionTargets, target)) {
    throw new Error(`Unknown PRODUCTION_TEST_TARGET "${target}". Supported targets: ${Object.keys(productionTargets).join(', ')}.`);
  }
  const deployment = productionTargets[target];
  const directory = await mkdtemp(join(tmpdir(), 'markdown-cards-http-'));
  const publicRoot = join(directory, deployment.publicDirectory);
  let child: ChildProcess | undefined;
  const environment = {
    PATH: process.env.PATH ?? '', NODE_ENV: 'production',
    DEPLOY_TARGET: target,
    ADMIN_USERNAME: productionCredentials.username,
    ADMIN_PASSWORD_HASH: productionPasswordHash,
    SESSION_SECRET: productionSessionSecret,
    VITE_YANDEX_DISK_TOKEN: productionLegacyClientToken,
    CLOUD_STORAGE_PROVIDER: 'yandex', YANDEX_DISK_TOKEN: productionPrivateCloudToken,
    YANDEX_DISK_BASE_PATH: 'md-cards'
  };
  async function close() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>(done => child!.once('exit', () => done()));
      child.kill();
      await stopped;
    }
    await rm(directory, { recursive: true, force: true });
  }
  try {
    await Promise.all([
      ...['package.json', 'svelte.config.js', 'vite.config.ts', 'tsconfig.json', 'vercel.json', 'netlify.toml'].map(
        name => cp(join(root, name), join(directory, name))),
      cp(join(root, 'config'), join(directory, 'config'), { recursive: true }),
      cp(join(root, 'src'), join(directory, 'src'), {
        recursive: true, filter: source => source !== join(root, 'src/lib/tests')
      }),
      cp(join(root, 'static'), join(directory, 'static'), { recursive: true }),
      symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir')
    ]);
    await execute(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build'], {
      cwd: directory, env: environment, timeout: 60_000, maxBuffer: 4 * 1024 * 1024
    });

    const entry = await deployment.resolveEntry(directory);
    child = fork(join(root, 'src/lib/tests/helpers/productionHttpWorker.ts'), [entry], {
      cwd: directory, env: environment, execArgv: ['--import', 'tsx'], silent: true
    });
    const worker = child;
    let nextId = 0;
    let diagnostics = '';
    worker.stdout?.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-8000); });
    worker.stderr?.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-8000); });
    const pending = new Map<number, { resolve: (value: ProductionResponse | undefined) => void; reject: (error: Error) => void }>();
    await new Promise<void>((ready, reject) => {
      worker.on('message', (reply: WorkerReply) => {
        if (reply.ready) { ready(); return; }
        if (reply.id === undefined) { reject(new Error(reply.error ?? 'Worker initialization failed')); return; }
        const call = pending.get(reply.id);
        pending.delete(reply.id);
        if (reply.error) call?.reject(new Error(reply.error));
        else call?.resolve(reply.result);
      });
      worker.once('error', reject);
      worker.once('exit', code => {
        const error = new Error(`Production worker exited (${code}): ${diagnostics}`);
        reject(error);
        for (const call of pending.values()) call.reject(error);
        pending.clear();
      });
    });
    function send(message: ProductionWorkerCommand): Promise<ProductionResponse | undefined> {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.send({ ...message, id }, error => {
          if (error) { pending.delete(id); reject(error); }
        });
      });
    }
    return {
      // Read emitted font/image bytes without passing binary data through UTF-8.
      async readClientAssetBytes(path: string): Promise<Uint8Array> {
        const file = resolve(publicRoot, path);
        if (!file.startsWith(publicRoot + '/')) throw new Error('Invalid public asset path');
        return new Uint8Array(await readFile(file));
      },
      // Inspect every emitted public file, including HTML/CSS/maps if present.
      // Server chunks are deliberately outside this public-output boundary.
      async readClientAssets(): Promise<{ path: string; content: string }[]> {
        const assets: { path: string; content: string }[] = [];
        async function visit(relative: string): Promise<void> {
          for (const entry of await readdir(join(publicRoot, relative), { withFileTypes: true })) {
            const path = join(relative, entry.name);
            if (entry.isDirectory()) await visit(path);
            else assets.push({ path, content: await readFile(join(publicRoot, path), 'utf8') });
          }
        }
        await visit('');
        return assets;
      },
      async request(request: ProductionRequest): Promise<ProductionResponse> {
        const result = await send({ request });
        if (!result) throw new Error('Missing production HTTP response');
        return result;
      },
      async reset(remote: Record<string, string> = {}) { await send({ reset: remote }); },
      close
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export function readAuthCookie(response: ProductionResponse): string {
  const header = response.cookies.find(value => value.startsWith('auth_token='));
  if (!header) throw new Error('Login did not issue the test session');
  return header.split(';', 1)[0];
}
