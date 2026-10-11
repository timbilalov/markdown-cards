import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers';
import { BrowserCloudStorage } from '../adapters/browserCloudStorage';
import { YandexDiskAdapter } from '../server/cloud/yandexDiskAdapter';
import { mockHttp } from './helpers/http';
import { fileList } from './helpers/fixtures';
import { v1, v1Card } from './helpers/markdownReadFixtures';
import { installWebLocks } from './helpers/webLocks';

beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // Simulate the platform deadline with the controllable test clock; keep the
  // real AbortSignal, stream and production error classification.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds);
    return controller.signal;
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function delayed(http: ReturnType<typeof mockHttp>, method: string, url: string, body: boolean) {
  const started = Promise.withResolvers<void>(); const response = Promise.withResolvers<Response>();
  let finishBody: (() => void) | undefined;
  http.on(method, url, init => {
    started.resolve();
    if (!body) return new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      response.promise.then(resolve, reject);
    });
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('unfinished'));
      init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
      finishBody = () => { try { controller.close(); } catch {} };
    } }), { status: method === 'POST' ? 503 : 200 });
  });
  return { started: started.promise, finish() { response.resolve(new Response(v1)); finishBody?.(); } };
}

it.each([
  ['list', false], ['list', true], ['read', false], ['read', true], ['write', false], ['write', true]
] as const)('bounds browser %s through %s body completion without retry', async (mode, body) => {
  const http = mockHttp();
  const url = mode === 'list' ? '/api/cloud/files' : mode === 'read' ? '/api/cloud/download?path=a.md' : '/api/cloud/upload';
  const wait = delayed(http, mode === 'write' ? 'POST' : 'GET', url, body);
  const cloud = new BrowserCloudStorage();
  const pending = mode === 'list' ? cloud.list() : mode === 'read' ? cloud.readListed('a.md')
    : cloud.write({ path: 'a.md', source: v1 });
  const settled = vi.fn(); void pending.then(settled);
  try {
    await wait.started; await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toHaveBeenCalledWith({ status: 'unavailable', reason: 'network',
      ...(mode === 'write' ? { outcome: 'unknown' } : {}) });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  } finally { wait.finish(); await pending; }
  http.assertHandled();
});

it.each(['link body', 'PUT headers'] as const)('bounds provider write at %s with the correct delivery certainty', async mode => {
  const http = mockHttp();
  const linkUrl = 'https://cloud-api.yandex.net/v1/disk/resources/upload?path=disk%3A%2Fmd-cards%2Fa.md&overwrite=true';
  const target = 'https://uploader1.disk.yandex.net/upload-target/test';
  if (mode === 'PUT headers') http.on('GET', linkUrl, () => Response.json({ href: target, method: 'PUT', templated: false }));
  const wait = delayed(http, mode === 'link body' ? 'GET' : 'PUT', mode === 'link body' ? linkUrl : target, mode === 'link body');
  const cloud = new YandexDiskAdapter({ accessToken: 'test-only', rootPath: 'md-cards' });
  const pending = cloud.write({ path: 'a.md', source: v1 }); const settled = vi.fn(); void pending.then(settled);
  try {
    await wait.started; await vi.advanceTimersByTimeAsync(20_000);
    expect(settled).toHaveBeenCalledWith({ status: 'unavailable', reason: 'network',
      outcome: mode === 'link body' ? 'not-written' : 'unknown' });
    expect(http.fetch).toHaveBeenCalledTimes(mode === 'link body' ? 1 : 2);
  } finally { wait.finish(); await pending; }
  http.assertHandled();
});

it('releases synchronization ownership after a stalled upload and delivers another path', async () => {
  installWebLocks();
  const http = mockHttp();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  (await import('../stores/cloudStore')).setAuthenticationStatus(true);
  const db = (await import('../services/dbService')).dbService;
  const { saves } = await db.getSyncRepositories();
  for (const path of ['a.md', 'b.md']) await saves.save({ id: path, path,
    document: { version: 1, card: v1Card, source: v1 }, createOnly: false,
    base: { kind: 'present', revision: null }, baseSource: v1, createdAt: 0 });
  http.on('GET', '/api/cloud/files', () => Response.json(fileList(['a.md', 'b.md'].map(name => ({ name, path: name })))));
  for (const path of ['a.md', 'b.md']) http.on('GET', `/api/cloud/download?path=${path}`, () => new Response(v1));
  const started = Promise.withResolvers<void>(); const release = Promise.withResolvers<Response>();
  let uploads = 0;
  http.on('POST', '/api/cloud/upload', init => {
    if (++uploads > 1) return new Response('written');
    started.resolve();
    return new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      release.promise.then(resolve, reject);
    });
  });
  const runtime = await import('../services/cardSyncRuntime');
  const pending = runtime.retryCardSync(); const settled = vi.fn(); void pending.then(settled);
  try {
    await started.promise; await vi.advanceTimersByTimeAsync(30_000);
    for (let i = 0; i < 40; i++) await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toHaveBeenCalled();
    expect((await saves.readCurrent('a.md')).operation?.state.status).toBe('uncertain');
    expect((await saves.readCurrent('b.md')).draft).toBeNull();
    expect(uploads).toBe(2);
    // A subsequent owner can acquire the lock; unknown upload is not replayed.
    await runtime.retryCardSync(); expect(uploads).toBe(2);
  } finally { release.resolve(new Response('written')); await pending; }
  http.assertHandled();
});
