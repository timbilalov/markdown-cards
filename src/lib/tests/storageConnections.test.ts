// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest';
import { resolveStorageConnections, describeConnections } from '../server/cloud/storageConnections';
import { mockHttp } from './helpers/http';

let http: ReturnType<typeof mockHttp>;
let account = 'user-1';
let folder = 'folder-1';
const config = [
  { id: 'main', label: 'Основное', provider: 'yandex', rootPath: 'Notes', accessToken: 'secret-a' },
  {
    id: 'backup',
    label: 'Dropbox',
    provider: 'dropbox',
    rootPath: '/Notes',
    appKey: 'app',
    appSecret: 'secret-b',
    refreshToken: 'refresh'
  }
];
const environment = () => ({
  CLOUD_STORAGES: JSON.stringify(config),
  CLOUD_STORAGE_ACTIVE: 'main'
});
beforeEach(() => {
  http = mockHttp();
  account = 'user-1';
  folder = 'folder-1';
  http.on('GET', 'https://cloud-api.yandex.net/v1/disk?fields=user.uid', () =>
    Response.json({ user: { uid: account } })
  );
  http.on(
    'GET',
    'https://cloud-api.yandex.net/v1/disk/resources?path=disk%3A%2FNotes&fields=type,path,resource_id',
    () => Response.json({ type: 'dir', path: 'disk:/Notes', resource_id: folder })
  );
  http.on('POST', 'https://api.dropboxapi.com/oauth2/token', () =>
    Response.json({ access_token: 'short', expires_in: 3600 })
  );
  http.on('POST', 'https://api.dropboxapi.com/2/users/get_current_account', () =>
    Response.json({
      account_id: 'dbid:x',
      root_info: { home_namespace_id: 'home', root_namespace_id: 'team' }
    })
  );
  http.on('POST', 'https://api.dropboxapi.com/2/files/get_metadata', () =>
    Response.json({ '.tag': 'folder', id: 'dbfolder', path_lower: '/notes' })
  );
});

afterEach(() => http.assertHandled());

it('publishes configured folder paths for both available and unavailable connections', async () => {
  const configured = describeConnections(await resolveStorageConnections(environment()));
  expect(configured.storages).toMatchObject([{ rootPath: 'disk:/Notes' }, { rootPath: '/Notes' }]);
  http.on(
    'POST',
    'https://api.dropboxapi.com/2/users/get_current_account',
    () => new Response(null, { status: 401 })
  );
  const unavailable = describeConnections(await resolveStorageConnections(environment()));
  expect(unavailable.storages[1]).toMatchObject({ status: 'unavailable', rootPath: '/Notes' });
});

it('displays the Dropbox app-access root', async () => {
  const settings = structuredClone(config);
  settings[1].rootPath = '';
  const resolved = await resolveStorageConnections({
    CLOUD_STORAGES: JSON.stringify(settings),
    CLOUD_STORAGE_ACTIVE: 'main'
  });
  expect(describeConnections(resolved).storages[1]).toMatchObject({ rootPath: '/' });
});

it('resolves an arbitrary collection against real account/folder identities and publishes no credentials', async () => {
  const resolved = await resolveStorageConnections(environment());
  const catalog = describeConnections(resolved);
  expect(catalog).toMatchObject({
    activeStorageId: 'main',
    storages: [
      {
        id: 'main',
        status: 'available',
        provider: 'yandex',
        contextId: expect.stringMatching(/^ctx-v1-/)
      },
      {
        id: 'backup',
        status: 'available',
        provider: 'dropbox',
        capabilities: { conditionalUpdate: true }
      }
    ]
  });
  expect(JSON.stringify(catalog)).not.toMatch(/secret|refresh|accessToken|dbid|folder-1|user-1/);
});

it('changes context when actual account or physical folder changes at the same configured ID', async () => {
  const context = async () =>
    (await resolveStorageConnections(environment()))?.storages[0].descriptor?.contextId;
  const first = await context();
  account = 'user-2';
  const second = await context();
  folder = 'folder-2';
  const third = await context();
  expect([first, second, third].every(id => typeof id === 'string')).toBe(true);
  expect(new Set([first, second, third]).size).toBe(3);
});

it('keeps context when credentials and display name rotate for the same destination', async () => {
  const first = await resolveStorageConnections(environment());
  const changed = structuredClone(config);
  changed[0].label = 'Другой заголовок';
  changed[0].accessToken = 'rotated';
  const next = await resolveStorageConnections({
    CLOUD_STORAGES: JSON.stringify(changed),
    CLOUD_STORAGE_ACTIVE: 'main'
  });
  expect(next?.storages[0].descriptor?.contextId).toEqual(expect.stringMatching(/^ctx-v1-/));
  expect(next?.storages[0].descriptor?.contextId).toBe(first?.storages[0].descriptor?.contextId);
});

it('keeps an unavailable backup in the catalog without blocking the active instance', async () => {
  http.on(
    'POST',
    'https://api.dropboxapi.com/2/users/get_current_account',
    () => new Response(null, { status: 401 })
  );
  const catalog = describeConnections(await resolveStorageConnections(environment()));
  expect(catalog?.storages).toMatchObject([
    { id: 'main', status: 'available' },
    { id: 'backup', status: 'unavailable' }
  ]);
});

it('does not fall back to a backup when the active identity becomes unavailable', async () => {
  const before = await resolveStorageConnections(environment());
  expect(before.storages[0].descriptor).toBeDefined();
  http.on(
    'GET',
    'https://cloud-api.yandex.net/v1/disk?fields=user.uid',
    () => new Response(null, { status: 503 })
  );
  const failed = await resolveStorageConnections(environment());
  expect(describeConnections(failed)).toMatchObject({
    activeStorageId: 'main',
    storages: [
      { id: 'main', status: 'unavailable' },
      { id: 'backup', status: 'available' }
    ]
  });
  expect(failed.storages[0]).not.toHaveProperty('descriptor');
});

it('supports a third instance of an existing provider', async () => {
  http.on(
    'GET',
    'https://cloud-api.yandex.net/v1/disk/resources?path=disk%3A%2FReserve&fields=type,path,resource_id',
    () => Response.json({ type: 'dir', path: 'disk:/Reserve', resource_id: 'third-folder' })
  );
  const env = {
    CLOUD_STORAGES: JSON.stringify([...config, { ...config[0], id: 'third', rootPath: 'Reserve' }]),
    CLOUD_STORAGE_ACTIVE: 'third'
  };
  expect(describeConnections(await resolveStorageConnections(env))).toMatchObject({
    activeStorageId: 'third',
    storages: [{ id: 'main' }, { id: 'backup' }, { id: 'third', status: 'available' }]
  });
});

it('rejects duplicate physical destinations even when configured instance IDs differ', async () => {
  await expect(
    resolveStorageConnections({
      CLOUD_STORAGES: JSON.stringify([config[0], { ...config[0], id: 'alias' }]),
      CLOUD_STORAGE_ACTIVE: 'main'
    })
  ).rejects.toThrow(/^Invalid cloud storage configuration$/);
});

it('never accepts an unverified account or a file as the configured Yandex root', async () => {
  http.on(
    'GET',
    'https://cloud-api.yandex.net/v1/disk/resources?path=disk%3A%2FNotes&fields=type,path,resource_id',
    () => Response.json({ type: 'file', path: 'disk:/Notes', resource_id: 'file' })
  );
  expect(describeConnections(await resolveStorageConnections(environment()))?.storages[0]).toEqual({
    id: 'main',
    label: 'Основное',
    provider: 'yandex',
    rootPath: 'disk:/Notes',
    status: 'unavailable'
  });
});

it.each([
  { account: {} },
  { account: { user: { uid: '' } } },
  { root: { type: 'dir', path: 'disk:/Notes' } },
  { root: { type: 'dir', path: 'disk:/Other', resource_id: 'folder' } }
])('keeps incomplete or unrelated Yandex identity unavailable: %j', async invalid => {
  if ('account' in invalid)
    http.on('GET', 'https://cloud-api.yandex.net/v1/disk?fields=user.uid', () =>
      Response.json(invalid.account)
    );
  if ('root' in invalid)
    http.on(
      'GET',
      'https://cloud-api.yandex.net/v1/disk/resources?path=disk%3A%2FNotes&fields=type,path,resource_id',
      () => Response.json(invalid.root)
    );
  expect(describeConnections(await resolveStorageConnections(environment()))?.storages[0]).toEqual({
    id: 'main',
    label: 'Основное',
    provider: 'yandex',
    rootPath: 'disk:/Notes',
    status: 'unavailable'
  });
});

it.each([{ provider: 'unknown' }, { accessToken: '' }, { id: 'main\n' }])(
  'rejects invalid adapter configuration before identity I/O: %j',
  async change => {
    await expect(
      resolveStorageConnections({
        CLOUD_STORAGES: JSON.stringify([{ ...config[0], ...change }]),
        CLOUD_STORAGE_ACTIVE: 'id' in change ? change.id : 'main'
      })
    ).rejects.toThrow(/^Invalid cloud storage configuration$/);
    expect(http.fetch).not.toHaveBeenCalled();
  }
);

it.each([
  {},
  { CLOUD_STORAGES: '{', CLOUD_STORAGE_ACTIVE: 'main' },
  { CLOUD_STORAGES: JSON.stringify(config), CLOUD_STORAGE_ACTIVE: 'missing' },
  { CLOUD_STORAGES: JSON.stringify([config[0], config[0]]), CLOUD_STORAGE_ACTIVE: 'main' }
])('rejects invalid configuration without exposing any values', async env => {
  await expect(resolveStorageConnections(env)).rejects.toThrow(
    /^Invalid cloud storage configuration$/
  );
});

it('requires explicit connections instead of guessing a default storage', async () => {
  await expect(resolveStorageConnections({})).rejects.toThrow(
    /^Invalid cloud storage configuration$/
  );
  expect(http.fetch).not.toHaveBeenCalled();
});

it('projects only public fields even when internal descriptors acquire private metadata', async () => {
  const connections = await resolveStorageConnections(environment());
  const descriptor = connections.storages[0].descriptor!;
  Object.assign(descriptor, { privateMarker: 'private-value' });
  Object.assign(descriptor.capabilities, { privateMarker: 'private-value' });
  expect(JSON.stringify(describeConnections(connections))).not.toContain('private-value');
});
