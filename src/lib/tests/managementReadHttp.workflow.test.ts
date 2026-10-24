// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { runHandle } from './helpers/serverRequest';
import { mockHttp } from './helpers/http';
import { createStorageContextId } from '../server/cloud/storageRegistry';

const environment = vi.hoisted(() => ({ values: {} as Record<string, string | undefined> }));
vi.mock('$env/dynamic/private', () => ({
  get env() {
    return environment.values;
  }
}));

vi.mock('../utils/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

let http: ReturnType<typeof mockHttp>;
const root = 'disk:/Reserve';
const filename = 'note.md';
const context = createStorageContextId('reserve', {
  provider: 'yandex',
  accountId: 'account',
  rootId: JSON.stringify(['reserve-folder', root])
});
beforeEach(() => {
  vi.resetModules();
  http = mockHttp();
  environment.values = {
    SESSION_SECRET: '88'.repeat(32),
    CLOUD_STORAGE_ACTIVE: 'main',
    CLOUD_STORAGES: JSON.stringify([
      {
        id: 'main',
        label: 'Main',
        provider: 'yandex',
        accessToken: 'main-token',
        rootPath: 'Main'
      },
      {
        id: 'reserve',
        label: 'Reserve',
        provider: 'yandex',
        accessToken: 'reserve-token',
        rootPath: 'Reserve'
      }
    ])
  };
  http.on('GET', 'https://cloud-api.yandex.net/v1/disk?fields=user.uid', () =>
    Response.json({ user: { uid: 'account' } })
  );
  http.on(
    'GET',
    'https://cloud-api.yandex.net/v1/disk/resources?path=disk%3A%2FReserve&fields=type,path,resource_id',
    () => Response.json({ type: 'dir', path: root, resource_id: 'reserve-folder' })
  );
  http.on(
    'GET',
    'https://cloud-api.yandex.net/v1/disk/resources?path=disk%3A%2FReserve&limit=100&offset=0&sort=name',
    () =>
      Response.json({
        type: 'dir',
        path: root,
        _embedded: {
          path: root,
          offset: 0,
          limit: 100,
          total: 1,
          items: [{ type: 'file', name: filename, path: `${root}/${filename}` }]
        }
      })
  );
  http.on(
    'GET',
    'https://cloud-api.yandex.net/v1/disk/resources/download?path=disk%3A%2FReserve%2Fnote.md',
    () =>
      Response.json({
        href: 'https://downloader.disk.yandex.ru/disk/reserve',
        method: 'GET',
        templated: false
      })
  );
  http.on(
    'GET',
    'https://downloader.disk.yandex.ru/disk/reserve',
    () => new Response('\uFEFFreserve raw\r\n')
  );
});

afterEach(() => http.assertHandled());

async function send(
  operation: 'files' | 'download' | 'copy',
  expected: string | null = context,
  id = 'reserve'
) {
  const { handle } = await import('../../hooks.server');
  const { issueSession } = await import('../server/session');
  const token = issueSession('user').token;
  const handler = (
    operation === 'files'
      ? (await import('../../routes/api/storages/[storageId]/files/+server')).GET
      : operation === 'download'
        ? (await import('../../routes/api/storages/[storageId]/download/+server')).GET
        : (await import('../../routes/api/storages/[storageId]/copy/+server')).POST
  ) as RequestHandler;
  const url = new URL(
    `https://app.invalid/api/storages/${id}/${operation}${operation === 'files' ? '' : '?path=note.md'}`
  );
  const request = new Request(url, {
    method: operation === 'copy' ? 'POST' : 'GET',
    headers: {
      Origin: url.origin,
      ...(expected === null ? {} : { 'X-Storage-Context': expected }),
      ...(operation === 'copy' ? { 'Content-Type': 'text/markdown', 'X-Create-Only': 'true' } : {})
    },
    ...(operation === 'copy' ? { body: new TextEncoder().encode('raw source') } : {})
  });
  const event = {
    url,
    request,
    params: { storageId: id },
    locals: {},
    cookies: { get: () => token },
    route: { id: `/api/storages/[storageId]/${operation}` },
    getClientAddress: () => '127.0.0.1'
  } as unknown as RequestEvent;
  return runHandle(handle, { event, resolve: async current => handler(current) });
}

it('lists a chosen reserve through its verified port without changing active storage', async () => {
  const response = await send('files');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    _embedded: { items: [{ name: 'note.md', path: 'note.md' }] }
  });
  expect(http.fetch.mock.calls.some(([url]) => String(url).includes('Main'))).toBe(false);
});

it('reads exact unsupported bytes from a reserve, independently of active', async () => {
  const response = await send('download');
  expect(response.status).toBe(200);
  expect(new TextDecoder('utf8', { ignoreBOM: true }).decode(await response.arrayBuffer())).toBe(
    '\uFEFFreserve raw\r\n'
  );
});

it.each(['files', 'download', 'copy'] as const)(
  'rejects missing, stale and unknown management destination for %s',
  async operation => {
    for (const [expected, id] of [
      [null, 'reserve'],
      [`ctx-v1-${'a'.repeat(64)}`, 'reserve'],
      [context, 'unknown']
    ] as const) {
      const response = await send(operation, expected, id);
      expect(response.status).toBe(409);
    }
    expect(
      http.fetch.mock.calls.some(
        ([url]) => String(url).includes('/download') || String(url).includes('&limit=')
      )
    ).toBe(false);
  }
);

it('routes a guarded raw copy preflight to the selected reserve rather than active', async () => {
  const response = await send('copy');
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ status: 'conflict' });
  expect(http.fetch.mock.calls.some(([url]) => String(url).includes('Main'))).toBe(false);
  expect(http.fetch.mock.calls.some(([url]) => String(url).includes('/resources/download'))).toBe(
    true
  );
});
