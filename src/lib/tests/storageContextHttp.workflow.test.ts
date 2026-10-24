// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { mockHttp } from './helpers/http';
import { runHandle } from './helpers/serverRequest';
import { createStorageContextId } from '../server/cloud/storageRegistry';
import { inputSource } from './helpers/requestBodyFixtures';

const environment = vi.hoisted(() => ({ values: {} as Record<string, string | undefined> }));
vi.mock('$env/dynamic/private', () => ({
  get env() {
    return environment.values;
  }
}));

vi.mock('../utils/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

let http: ReturnType<typeof mockHttp>;
const contextId = createStorageContextId('yandex', {
  provider: 'yandex',
  accountId: 'user',
  rootId: JSON.stringify(['folder', 'disk:/Notes'])
});
beforeEach(() => {
  vi.resetModules();
  environment.values = {
    SESSION_SECRET: '77'.repeat(32),
    CLOUD_STORAGE_ACTIVE: 'yandex',
    CLOUD_STORAGES: JSON.stringify([
      {
        id: 'yandex',
        label: 'Яндекс Диск',
        provider: 'yandex',
        accessToken: 'secret',
        rootPath: 'Notes'
      }
    ])
  };
  http = mockHttp();
  http.on(
    'GET',
    'https://cloud-api.yandex.net/v1/disk/resources/upload?path=disk%3A%2FNotes%2Fnote.md&overwrite=true',
    () =>
      Response.json({
        href: 'https://uploader1d.dst.yandex.net/upload-target/test',
        method: 'PUT',
        templated: false
      })
  );
  http.on(
    'PUT',
    'https://uploader1d.dst.yandex.net/upload-target/test',
    () => new Response(null, { status: 201 })
  );
  http.on('GET', 'https://cloud-api.yandex.net/v1/disk?fields=user.uid', () =>
    Response.json({ user: { uid: 'user' } })
  );
  http.on(
    'GET',
    'https://cloud-api.yandex.net/v1/disk/resources?path=disk%3A%2FNotes&fields=type,path,resource_id',
    () => Response.json({ type: 'dir', path: 'disk:/Notes', resource_id: 'folder' })
  );
});

afterEach(() => http.assertHandled());

async function send(expected?: string, revision?: string) {
  const { handle } = await import('../../hooks.server');
  const { issueSession } = await import('../server/session');
  const { POST } = await import('../../routes/api/cloud/upload/+server');
  const form = new FormData();
  form.set('path', 'note.md');
  form.set('content', inputSource);
  form.set('overwrite', 'true');
  const request = new Request('https://app.invalid/api/cloud/upload', {
    method: 'POST',
    headers: {
      Origin: 'https://app.invalid',
      ...(expected ? { 'X-Storage-Context': expected } : {}),
      ...(revision !== undefined ? { 'X-Expected-Revision': revision } : {})
    },
    body: form
  });
  const token = issueSession('user').token;
  const event = {
    request,
    url: new URL(request.url),
    cookies: { get: () => token },
    locals: {},
    params: {},
    route: { id: '/api/cloud/upload' },
    getClientAddress: () => '127.0.0.1'
  } as unknown as RequestEvent;
  const response = await runHandle(handle, {
    event,
    resolve: async current => POST(current as Parameters<typeof POST>[0])
  });
  return { request, response };
}

it.each([undefined, 'ctx-v1-000000', 'wrong', `ctx-v1-${'b'.repeat(64)}`])(
  'refuses old/mismatched context %j before consuming body or asking for upload',
  async expected => {
    const { request, response } = await send(expected);
    expect(response.status).toBe(409);
    expect(request.bodyUsed).toBe(false);
    expect(await response.json()).toMatchObject({
      error: 'CLOUD_CONTEXT_MISMATCH',
      outcome: 'not-written'
    });
    expect(http.fetch.mock.calls.some(([url]) => String(url).includes('/upload'))).toBe(false);
  }
);

it('allows a verified context through the real hook and upload handler', async () => {
  http.on(
    'GET',
    'https://cloud-api.yandex.net/v1/disk/resources/upload?path=disk%3A%2FNotes%2Fnote.md&overwrite=true',
    () =>
      Response.json({
        href: 'https://uploader1d.dst.yandex.net/upload-target/test',
        method: 'PUT',
        templated: false
      })
  );
  http.on(
    'PUT',
    'https://uploader1d.dst.yandex.net/upload-target/test',
    () => new Response(null, { status: 201 })
  );
  const { response } = await send(contextId);
  expect(response.status).toBe(200);
  expect(http.fetch.mock.calls.some(([url]) => String(url).includes('?fields=user.uid'))).toBe(
    true
  );
});

it('blocks a formerly valid context when account verification is unavailable, preserving the unread body', async () => {
  http.on(
    'GET',
    'https://cloud-api.yandex.net/v1/disk?fields=user.uid',
    () => new Response(null, { status: 503 })
  );
  const { request, response } = await send(contextId);
  expect(response.status).toBe(503);
  expect(request.bodyUsed).toBe(false);
  expect(http.fetch.mock.calls.some(([url]) => String(url).includes('/upload'))).toBe(false);
});

it('carries Dropbox CAS and acknowledgement revision through hook and multipart upload', async () => {
  environment.values = {
    SESSION_SECRET: '77'.repeat(32),
    CLOUD_STORAGE_ACTIVE: 'backup',
    CLOUD_STORAGES: JSON.stringify([
      {
        id: 'backup',
        label: 'Dropbox',
        provider: 'dropbox',
        appKey: 'app',
        appSecret: 'secret',
        refreshToken: 'refresh',
        rootPath: '/Notes'
      }
    ])
  };
  http.on('POST', 'https://api.dropboxapi.com/oauth2/token', () =>
    Response.json({ access_token: 'token', expires_in: 3600 })
  );
  http.on('POST', 'https://api.dropboxapi.com/2/users/get_current_account', () =>
    Response.json({ account_id: 'account', root_info: { home_namespace_id: 'home' } })
  );
  http.on('POST', 'https://api.dropboxapi.com/2/files/get_metadata', () =>
    Response.json({ '.tag': 'folder', id: 'folder', path_lower: '/notes' })
  );
  let mode: unknown;
  http.on('POST', 'https://content.dropboxapi.com/2/files/upload', init => {
    mode = JSON.parse(new Headers(init?.headers).get('Dropbox-API-Arg')!).mode;
    return Response.json({
      name: 'note.md',
      path_lower: '/notes/note.md',
      rev: 'new',
      server_modified: '2026-10-19T00:00:00Z'
    });
  });
  const context = createStorageContextId('backup', {
    provider: 'dropbox',
    accountId: 'account',
    rootId: JSON.stringify(['app', 'home', 'folder', '/notes'])
  });
  const { response } = await send(context, 'base');
  expect(response.status).toBe(200);
  expect(mode).toEqual({ '.tag': 'update', update: 'base' });
  expect(response.headers.get('X-Cloud-Revision')).toBe('new');
});

it.each(['/api/cloud/files', '/api/cloud/download?path=note.md'])(
  'guards reads before invoking the file handler: %s',
  async path => {
    const { handle } = await import('../../hooks.server');
    const { issueSession } = await import('../server/session');
    const url = new URL(path, 'https://app.invalid');
    const token = issueSession('user').token;
    for (const expected of [undefined, `ctx-v1-${'d'.repeat(64)}`]) {
      const request = new Request(url, {
        headers: expected ? { 'X-Storage-Context': expected } : {}
      });
      const event = {
        request,
        url,
        cookies: { get: () => token },
        locals: {},
        params: {},
        route: { id: url.pathname },
        getClientAddress: () => '127.0.0.1'
      } as unknown as RequestEvent;
      let called = false;
      const response = await runHandle(handle, {
        event,
        resolve: async () => {
          called = true;
          return new Response('file handler ran');
        }
      });
      expect(response.status).toBe(409);
      expect(called).toBe(false);
    }
  }
);

it('does not silently drop an explicitly empty revision condition', async () => {
  // Current Yandex cannot perform a conditional update. Even an empty condition
  // must be rejected, never downgraded to ordinary overwrite.
  const { response } = await send(contextId, '');
  expect(response.status).toBe(400);
  expect(http.fetch.mock.calls.some(([url]) => String(url).includes('/upload'))).toBe(false);
});

it('does not contact reserve instances during ordinary active-storage traffic', async () => {
  environment.values = {
    SESSION_SECRET: '77'.repeat(32),
    CLOUD_STORAGE_ACTIVE: 'yandex',
    CLOUD_STORAGES: JSON.stringify([
      {
        id: 'yandex',
        label: 'Основное',
        provider: 'yandex',
        accessToken: 'secret',
        rootPath: 'Notes'
      },
      {
        id: 'reserve',
        label: 'Резерв',
        provider: 'dropbox',
        appKey: 'app',
        appSecret: 'secret',
        refreshToken: 'refresh',
        rootPath: ''
      }
    ])
  };
  http.on(
    'POST',
    'https://api.dropboxapi.com/oauth2/token',
    () => new Response(null, { status: 503 })
  );
  const { response } = await send(contextId);
  expect(response.status).toBe(200);
  expect(http.fetch.mock.calls.some(([url]) => String(url).includes('dropboxapi.com'))).toBe(false);
  expect(http.fetch.mock.calls.some(([url]) => String(url).includes('?fields=user.uid'))).toBe(
    true
  );
});

it.each([true, false])(
  'uses only the active connection when a verified reserve is available (active available: %s)',
  async activeAvailable => {
    const settings = JSON.parse(environment.values.CLOUD_STORAGES!);
    settings.push({
      id: 'reserve',
      label: 'Резерв',
      provider: 'yandex',
      accessToken: 'reserve-token',
      rootPath: 'Reserve'
    });
    environment.values.CLOUD_STORAGES = JSON.stringify(settings);
    http.on(
      'GET',
      'https://cloud-api.yandex.net/v1/disk/resources?path=disk%3A%2FReserve&fields=type,path,resource_id',
      () => Response.json({ type: 'dir', path: 'disk:/Reserve', resource_id: 'reserve-folder' })
    );
    if (!activeAvailable) {
      http.on(
        'GET',
        'https://cloud-api.yandex.net/v1/disk/resources?path=disk%3A%2FNotes&fields=type,path,resource_id',
        () => new Response(null, { status: 503 })
      );
    }
    const { GET } = await import('../../routes/api/storages/+server');
    const catalog = await GET({} as Parameters<typeof GET>[0]);
    expect(await catalog.json()).toMatchObject({
      activeStorageId: 'yandex',
      storages: [
        { id: 'yandex', status: activeAvailable ? 'available' : 'unavailable' },
        { id: 'reserve', status: 'available' }
      ]
    });
    const reserveContext = createStorageContextId('reserve', {
      provider: 'yandex',
      accountId: 'user',
      rootId: JSON.stringify(['reserve-folder', 'disk:/Reserve'])
    });

    for (const expected of [contextId, reserveContext]) {
      const firstCall = http.fetch.mock.calls.length;
      const { request, response } = await send(expected);
      const allowed = activeAvailable && expected === contextId;
      expect(response.status).toBe(allowed ? 200 : activeAvailable ? 409 : 503);
      if (!allowed) {
        expect(request.bodyUsed).toBe(false);
        expect(
          http.fetch.mock.calls.slice(firstCall).some(([url]) => String(url).includes('/upload'))
        ).toBe(false);
      }
    }
  }
);
