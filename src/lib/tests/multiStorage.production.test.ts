// @vitest-environment node
import { beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  createProductionHttp,
  productionOrigin as origin,
  productionCredentials,
  readAuthCookie
} from './helpers/productionHttp';
import { multiStorageProduction } from './helpers/multiStorageProduction';
import type { ConnectionCatalog } from '../server/cloud/storageConnections';
import { productionUploadBody } from './helpers/uploadInputFixtures';
import { OLD_SOURCE } from './helpers/storageSyncFixtures';

let server: Awaited<ReturnType<typeof createProductionHttp>>;
let cookie: string;
const raw = '\uFEFF<!-- markdown-cards: 99 -->\r\nТочный исходник\r\n';
beforeAll(async () => {
  server = await createProductionHttp({
    storages: multiStorageProduction,
    activeStorageId: 'dropbox'
  });
  cookie = readAuthCookie(
    await server.request({
      url: `${origin}/api/auth/login`,
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(productionCredentials)
    })
  );
}, 90000);

afterAll(async () => {
  await server?.close();
});

beforeEach(async () => {
  await server.reset({
    'md-cards/note.md': OLD_SOURCE,
    'dropbox:/note.md': raw,
    'Archive/reserve-only.md': 'reserve source'
  });
});

async function catalog() {
  const response = await server.request({
    url: `${origin}/api/storages`,
    headers: { Cookie: cookie }
  });
  expect(response.status).toBe(200);
  const catalog = JSON.parse(response.text) as ConnectionCatalog;
  expect(catalog.storages.every(storage => storage.status === 'available')).toBe(true);
  return catalog;
}

async function context(id: string) {
  const entry = (await catalog()).storages.find(storage => storage.id === id);
  if (entry?.status !== 'available') throw new Error('Fixture unavailable');
  return entry.contextId;
}

it('exposes three verified instances without credentials and keeps active Dropbox explicit', async () => {
  const result = await catalog();
  expect(result.activeStorageId).toBe('dropbox');
  expect(result.storages.map(storage => storage.id)).toEqual(['disk', 'dropbox', 'archive']);
  const json = JSON.stringify(result);
  for (const secret of [
    'fixture-disk-private',
    'fixture-app-secret',
    'fixture-refresh-token',
    'fixture-archive-private'
  ])
    expect(json).not.toContain(secret);
  expect(result.storages.find(storage => storage.id === 'dropbox')).toMatchObject({
    capabilities: { conditionalUpdate: true, caseSensitivePaths: false }
  });
  const assets = await server.readClientAssets();
  for (const asset of assets)
    for (const marker of [
      'fixture-app-secret',
      'fixture-refresh-token',
      'fixture-disk-private',
      'fixture-archive-private',
      'api.dropboxapi.com',
      'content.dropboxapi.com'
    ])
      expect(asset.content, `${asset.path}: ${marker}`).not.toContain(marker);
});

it('uses active Dropbox for ordinary reading and a selected reserve for management reading', async () => {
  const cloud = await server.request({
    url: `${origin}/api/cloud/download?path=note.md`,
    headers: { Cookie: cookie, 'X-Storage-Context': await context('dropbox') }
  });
  expect(cloud.status).toBe(200);
  expect(cloud.text).toBe(raw);
  expect(cloud.headers['x-cloud-revision']).toEqual(expect.any(String));
  const reserve = await server.request({
    url: `${origin}/api/storages/archive/download?path=reserve-only.md`,
    headers: { Cookie: cookie, 'X-Storage-Context': await context('archive') }
  });
  expect(reserve.status).toBe(200);
  expect(reserve.text).toBe('reserve source');
  expect(reserve.effects.writes).toEqual([]);
  expect(reserve.effects.unexpected).toEqual([]);
});

it('copies exact unsupported raw text to Dropbox using captured revision and preserves unrelated clouds', async () => {
  const bound = await context('dropbox');
  const current = await server.request({
    url: `${origin}/api/storages/dropbox/download?path=note.md`,
    headers: { Cookie: cookie, 'X-Storage-Context': bound }
  });
  const source = '\uFEFFlegacy replacement\r\n';
  const copied = await server.request({
    url: `${origin}/api/storages/dropbox/copy?path=note.md`,
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: origin,
      'X-Storage-Context': bound,
      'Content-Type': 'text/markdown',
      'X-Expected-Source-Hash': createHash('sha256').update(raw).digest('hex'),
      'X-Expected-Revision': current.headers['x-cloud-revision']
    },
    body: source
  });
  expect(copied.status).toBe(200);
  expect(JSON.parse(copied.text)).toMatchObject({
    status: 'written',
    revision: expect.any(String)
  });
  expect(copied.effects.remote).toEqual({
    'md-cards/note.md': OLD_SOURCE,
    'dropbox:/note.md': source,
    'Archive/reserve-only.md': 'reserve source'
  });
  expect(copied.effects.writes).toHaveLength(1);
  expect(copied.effects.unexpected).toEqual([]);
});

it('guards missing/stale contexts and foreign Origin before all file I/O', async () => {
  const bound = await context('dropbox');
  const cases: { headers: Record<string, string>; status: number; identity: boolean }[] = [
    {
      headers: { Cookie: '', Origin: origin, 'X-Storage-Context': bound },
      status: 401,
      identity: false
    },
    {
      headers: { Cookie: cookie, Origin: 'https://foreign.invalid', 'X-Storage-Context': bound },
      status: 403,
      identity: false
    },
    { headers: { Cookie: cookie, Origin: origin }, status: 409, identity: false },
    {
      headers: { Cookie: cookie, Origin: origin, 'X-Storage-Context': `ctx-v1-${'a'.repeat(64)}` },
      status: 409,
      identity: true
    }
  ];
  for (const entry of cases) {
    await server.reset();
    const response = await server.request({
      url: `${origin}/api/storages/dropbox/copy?path=note.md`,
      method: 'POST',
      headers: { ...entry.headers, 'Content-Type': 'text/markdown', 'X-Create-Only': 'true' },
      body: raw
    });
    expect(response.status).toBe(entry.status);
    expect(response.bodyUsed).toBe(false);
    expect(response.effects.writes).toEqual([]);
    expect(
      response.effects.requests.every(request =>
        [
          'https://api.dropboxapi.com/oauth2/token',
          'https://api.dropboxapi.com/2/users/get_current_account'
        ].includes(request.url)
      )
    ).toBe(true);
    if (!entry.identity) expect(response.effects.requests).toEqual([]);
  }
});

it('keeps ordinary Save strict while management copy can create an unsupported document', async () => {
  const bound = await context('dropbox');
  const rejected = await server.request({
    url: `${origin}/api/cloud/upload`,
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'X-Storage-Context': bound },
    form: { path: 'future.md', content: raw, overwrite: 'false' }
  });
  expect([400, 422]).toContain(rejected.status);
  expect(rejected.effects.writes).toEqual([]);
  const payload = await productionUploadBody([
    ['path', 'editor-save.md'],
    ['content', new Blob([OLD_SOURCE], { type: 'text/markdown' })],
    ['overwrite', 'false']
  ]);
  const saved = await server.request({
    url: `${origin}/api/cloud/upload`,
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: origin,
      'X-Storage-Context': bound,
      'Content-Type': payload.contentType
    },
    body: payload.body
  });
  expect(saved.status).toBe(200);
  expect(saved.headers['x-cloud-revision']).toEqual(expect.any(String));
  expect(saved.effects.remote['dropbox:/editor-save.md']).toBe(OLD_SOURCE);
  const copied = await server.request({
    url: `${origin}/api/storages/dropbox/copy?path=future.md`,
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: origin,
      'X-Storage-Context': bound,
      'Content-Type': 'text/markdown',
      'X-Create-Only': 'true'
    },
    body: raw
  });
  expect(JSON.parse(copied.text)).toMatchObject({ status: 'written' });
  expect(copied.effects.remote['dropbox:/future.md']).toBe(raw);
});
