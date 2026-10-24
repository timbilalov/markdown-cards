import { historicalContextDatabase, historicalLocalId } from './helpers/historicalStorageContext';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mockHttp } from './helpers/http';
import { OLD_SOURCE, NEW_SOURCE } from './helpers/storageSyncFixtures';

let http: ReturnType<typeof mockHttp>;

const first = {
  id: 'first',
  label: 'First',
  provider: 'yandex',
  status: 'available',
  contextId: `ctx-v1-${'a'.repeat(64)}`,
  capabilities: { revisions: false, conditionalCreate: true }
};

const second = { ...first, id: 'second', label: 'Second', contextId: `ctx-v1-${'b'.repeat(64)}` };
beforeEach(() => {
  vi.resetModules();
  http = mockHttp();
  http.on('GET', '/api/storages', () =>
    Response.json({ activeStorageId: 'first', storages: [first, second] })
  );
  http.on('GET', '/api/cloud/files', () => Response.json({ _embedded: { items: [] } }));
  for (const [descriptor, source] of [
    [first, OLD_SOURCE],
    [second, NEW_SOURCE]
  ] as const) {
    http.on('GET', `/api/storages/${descriptor.id}/files`, () =>
      Response.json({ _embedded: { items: [{ name: 'note.md', path: 'note.md' }] } })
    );
    http.on(
      'GET',
      `/api/storages/${descriptor.id}/download?path=note.md`,
      () => new Response(source)
    );
  }
});

afterEach(() => http.assertHandled());

it('keeps the old folder attached to its cache when the configured folder changes', async () => {
  const previous = { ...first, rootPath: 'disk:/Old', contextId: `ctx-v1-${'c'.repeat(64)}` };
  http.on('GET', '/api/storages', () =>
    Response.json({ activeStorageId: 'first', storages: [previous] })
  );
  const session = await import('../services/storageSession');
  await session.initializeStorageSession(true);
  http.on('GET', '/api/storages', () =>
    Response.json({
      activeStorageId: 'first',
      storages: [{ ...first, rootPath: 'disk:/New' }, second]
    })
  );
  const model = await (await import('../services/storageManagement')).loadStorageComparison();
  expect(model.columns.find(column => column.id === 'first')).toMatchObject({
    rootPath: 'disk:/New'
  });
  expect(model.columns.find(column => column.id === `local:${previous.contextId}`)).toMatchObject({
    rootPath: 'disk:/Old',
    storageId: 'first'
  });
  expect(model.columns.find(column => column.id === `local:${first.contextId}`)).toMatchObject({
    rootPath: 'disk:/New'
  });
});

it('combines all clouds and local contexts without rebinding the normal runtime database', async () => {
  const dbModule = await import('../services/dbService');
  const normal = dbModule.dbService;
  await normal.saveMarkdownDocument('runtime-only', 'normal runtime source');
  const historical = await historicalContextDatabase();
  await historical.saveMarkdownDocument('local-only', 'exact local raw');
  const model = await (await import('../services/storageManagement')).loadStorageComparison();
  expect(model?.columns.map(column => column.id)).toEqual(
    expect.arrayContaining([
      'first',
      'second',
      historicalLocalId,
      `local:${first.contextId}`,
      `local:${second.contextId}`
    ])
  );
  expect(model?.rows.map(row => row.path)).toEqual(
    expect.arrayContaining(['note.md', 'local-only.md'])
  );
  expect(model?.rows.find(row => row.path === 'note.md')?.comparison.freshness).toEqual({
    status: 'latest',
    storageIds: ['second']
  });
  expect((await dbModule.dbService.getMarkdownDocument('runtime-only'))?.result).toMatchObject({
    source: 'normal runtime source'
  });
});

it('keeps known filenames when an individual cloud source cannot be read', async () => {
  http.on(
    'GET',
    '/api/storages/second/download?path=note.md',
    () => new Response(null, { status: 503 })
  );
  const model = await (await import('../services/storageManagement')).loadStorageComparison();
  expect(
    model?.rows
      .find(row => row.path === 'note.md')
      ?.copies.find(copy => copy.storageId === 'second')
  ).toEqual({ storageId: 'second', status: 'unavailable' });
});

it('keeps an unavailable backup as a column and leaves healthy source data visible', async () => {
  http.on('GET', '/api/storages', () =>
    Response.json({
      activeStorageId: 'first',
      storages: [
        first,
        { id: 'second', label: 'Second', provider: 'yandex', status: 'unavailable' }
      ]
    })
  );
  const model = await (await import('../services/storageManagement')).loadStorageComparison();
  expect(model?.columns.map(column => column.id)).toContain('second');
  expect(model?.snapshots.find(snapshot => snapshot.storageId === 'second')).toEqual({
    storageId: 'second',
    status: 'unavailable'
  });
  expect(model?.rows.map(row => row.path)).toContain('note.md');
});

it('keeps local sources readable and latest undetermined when the whole cloud catalog fails', async () => {
  const historical = await historicalContextDatabase();
  await historical.saveMarkdownDocument('local', OLD_SOURCE);
  http.on('GET', '/api/storages', () => new Response(null, { status: 503 }));
  const model = await (await import('../services/storageManagement')).loadStorageComparison();
  expect(model?.catalogError).toEqual(expect.any(String));
  expect(model?.rows.find(row => row.path === 'local.md')?.comparison.freshness).toEqual({
    status: 'undetermined',
    reason: 'unavailable'
  });
  expect(
    model?.rows
      .find(row => row.path === 'local.md')
      ?.copies.find(copy => copy.storageId === historicalLocalId)
  ).toMatchObject({ status: 'present', source: OLD_SOURCE });
});

it('keeps an old local context absent from the new server catalog as a distinct source', async () => {
  const previous = {
    ...first,
    id: 'previous',
    label: 'Previous account',
    contextId: `ctx-v1-${'c'.repeat(64)}`
  };
  http.on('GET', '/api/storages', () =>
    Response.json({ activeStorageId: 'previous', storages: [previous] })
  );
  await (await import('../services/storageSession')).initializeStorageSession(true);
  const dbModule = await import('../services/dbService');
  const normal = dbModule.dbService;
  await normal.saveMarkdownDocument('orphan', 'exact previous context source');
  http.on('GET', '/api/storages', () =>
    Response.json({ activeStorageId: 'first', storages: [first, second] })
  );
  const model = await (await import('../services/storageManagement')).loadStorageComparison();
  expect(model?.columns.map(column => column.id)).toContain(`local:${previous.contextId}`);
  expect(
    model?.rows
      .find(row => row.path === 'orphan.md')
      ?.copies.find(copy => copy.storageId === `local:${previous.contextId}`)
  ).toMatchObject({ status: 'present', source: 'exact previous context source' });
  expect((await dbModule.dbService.getMarkdownDocument('orphan'))?.result).toMatchObject({
    source: 'exact previous context source'
  });
});
