import { initializeTestStorage, currentTestDatabaseName } from './helpers/browserStorageContext';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { mockCardDocumentHttp, documentSlug, documentFilename } from './helpers/cardDocumentHttp';
import { IDBDatabase } from 'fake-indexeddb';
import { v1, v1Card } from './helpers/markdownReadFixtures';
import { fileList } from './helpers/fixtures';
vi.mock('$app/environment', () => ({ browser: true }));
let cards: typeof import('../stores/cardStore');
let db: typeof import('../services/dbService')['dbService'];
let http: ReturnType<typeof mockCardDocumentHttp>;
beforeEach(async () => {
  vi.resetModules(); http = mockCardDocumentHttp(v1); await initializeTestStorage(http.http);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  cards = await import('../stores/cardStore'); db = (await import('../services/dbService')).dbService;
});
async function outbox() {
  const databaseName=await currentTestDatabaseName();
  const connection = await new Promise<IDBDatabase>(resolve => {
    const request = indexedDB.open(databaseName); request.onsuccess = () => resolve(request.result);
  });
  const rows = await new Promise<unknown[]>(resolve => {
    const tx = connection.transaction('outbox'); const request = tx.objectStore('outbox').getAll();
    tx.oncomplete = () => resolve(request.result);
  }); connection.close(); return rows;
}
describe('editor and board share durable synchronization', () => {
  it('reopens sync repositories after the borrowed connection closes', async () => {
    await cards.loadCard(documentSlug);
    const transaction = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementationOnce(function (this: IDBDatabase, ...args) {
      this.dispatchEvent(new Event('versionchange'));
      return transaction.apply(this, args);
    });
    await cards.saveCard(documentSlug, { ...get(cards.cardStore)!, title: 'First attempt after close' });
    await cards.saveCard(documentSlug, { ...get(cards.cardStore)!, title: 'Recovered connection' });
    expect(http.uploads.at(-1)?.content).toContain('# Recovered connection');
    expect(get(cards.cardSaveError)).toBeNull();
  });
  it('saves offline without HTTP, exposes pending status, then sends once on reconnect', async () => {
    await cards.loadCard(documentSlug);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await cards.saveCard(documentSlug, { ...get(cards.cardStore)!, title: 'Offline edit' });
    expect(await outbox()).toEqual([expect.objectContaining({ path: documentFilename, state: { status: 'pending', nextAttemptAt: expect.any(Number) } })]);
    expect(http.uploads).toEqual([]);
    expect(get(cards.cardSaveMessage)).toMatch(/локально.*синхронизации/i);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    await cards.processOfflineQueue();
    expect(http.uploads).toHaveLength(1);
    expect((await db.getCard(v1Card.meta.id))?.title).toBe('Offline edit');
    expect(await db.getLocalMarkdownSnapshot(documentSlug)).toBeNull();
    http.http.assertHandled();
  });

  it('detects an external edit before Save and preserves both versions', async () => {
    await cards.loadCard(documentSlug);
    http.http.on('GET', `/api/cloud/download?path=${documentFilename}`, () => new Response(v1.replace('Карточка 🗂', 'External')));
    await cards.saveCard(documentSlug, { ...get(cards.cardStore)!, title: 'My edit' });
    expect(await outbox()).toEqual([expect.objectContaining({ state: { status: 'conflict' } })]);
    expect(http.uploads).toEqual([]);
    expect(get(cards.cardSaveError)).toMatch(/конфликт/i);
    expect((await db.getCard(v1Card.meta.id))?.title).toBe('My edit');
    cards.resetCardDocument(); await cards.loadCard(documentSlug);
    expect(get(cards.cardSaveError)).toMatch(/конфликт/i);
    http.http.assertHandled();
  });

  it('board loading does not overwrite a local pending document', async () => {
    await cards.loadCard(documentSlug);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await cards.saveCard(documentSlug, { ...get(cards.cardStore)!, title: 'Local pending' });
    const before = await outbox();
    expect(before).toHaveLength(1);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const { loadCardFromCloud } = await import('../stores/cloudStore');
    expect(await loadCardFromCloud({ name: documentFilename, path: documentFilename }))
      .toMatchObject({ status: 'loaded', card: { title: 'Local pending' } });
    expect((await db.getCard(v1Card.meta.id))?.title).toBe('Local pending');
    expect(await outbox()).toEqual(before); http.http.assertHandled();
  });
});

it('keeps unsaved edits visible in the status after background delivery', async () => {
  await cards.loadCard(documentSlug);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  await cards.saveCard(documentSlug, { ...get(cards.cardStore)!, title: 'Submitted' });
  cards.cardStore.update(card => card && { ...card, title: 'Still editing' });
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  await cards.processOfflineQueue();
  expect(get(cards.cardSaveMessage)).toMatch(/несохранённые изменения/i);
  expect(get(cards.cardStore)?.title).toBe('Still editing');
  expect(http.uploads[0]?.content).toContain('# Submitted');
  http.http.assertHandled();
});

it('notifies other observers and retains a local commit when one subscriber throws', async () => {
  await cards.loadCard(documentSlug);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const { subscribeSync } = await import('../services/cardSyncRuntime');
  const notified = vi.fn();
  const stopBroken = subscribeSync(() => { throw new Error('Broken view'); });
  const stopHealthy = subscribeSync(notified);
  try {
    await cards.saveCard(documentSlug, { ...get(cards.cardStore)!, title: 'Committed despite observer' });
    expect(notified).toHaveBeenCalledTimes(1);
    expect(get(cards.cardSaveError)).toBeNull();
    expect(await db.getLocalMarkdownSnapshot(documentSlug)).toMatchObject({ source: expect.stringContaining('Committed despite observer') });
  } finally { stopBroken(); stopHealthy(); }
  http.http.assertHandled();
});

it('restores the delivery status for a failed Save after reopening', async () => {
  await cards.loadCard(documentSlug);
  http.http.on('POST', '/api/cloud/upload', () => Response.json({ error: 'CLOUD_AUTH_FAILED', outcome: 'not-written' }, { status: 502 }));
  await cards.saveCard(documentSlug, get(cards.cardStore)!);
  cards.resetCardDocument();
  await cards.loadCard(documentSlug);
  expect(get(cards.cardDeliveryStatus)).toBe('unauthorized');
  expect(get(cards.cardSaveMessage)).toMatch(/войдите/i);
  http.http.assertHandled();
});

it.each([false, true])('waits for session confirmation before loading the board (previous authentication=%s)', async authenticated => {
  (await import('../stores/cloudStore')).setAuthenticationStatus(authenticated);
  const started = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  http.http.on('GET', '/api/auth/status', async () => { started.resolve(); await release.promise; return Response.json({ authenticated: true }); });
  const { app } = await import('../stores/appFacade');
  const states: import('../application/loadBoard').BoardLoadState[] = [];
  const loading = app.loadBoard(state => states.push(state), new AbortController().signal);
  try {
    expect(await Promise.race([started.promise.then(() => 'checking-session'), loading.then(() => 'finished')])).toBe('checking-session');
    expect(http.http.fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/cloud/'))).toEqual([]);
  } finally { release.resolve(); await loading; }
  expect(states.at(-1)?.cards.map(card => card.filename)).toEqual([documentSlug]);
  http.http.assertHandled();
});

it.each(['save', 'manual retry'] as const)('stops %s preflight on logout without losing the local Save', async mode => {
  const transport = http.http;
  const cloud = await import('../stores/cloudStore'); cloud.setAuthenticationStatus(true);
  const { saves } = await db.getSyncRepositories();
  const document = { version: 1 as const, source: v1, card: v1Card };
  if (mode === 'manual retry') await saves.save({ id: 'seed', path: 'a.md', document, createOnly: false,
    base: { kind: 'present', revision: null }, baseSource: v1, createdAt: 0 });
  const started = Promise.withResolvers<void>(); const response = Promise.withResolvers<Response>();
  transport.on('GET', '/api/cloud/files', () => { started.resolve(); return response.promise; });
  transport.on('GET', '/api/cloud/download?path=a.md', () => new Response(v1));
  transport.on('POST', '/api/cloud/upload', () => Response.json({ success: true }));
  transport.on('POST', '/api/auth/logout', () => Response.json({ success: true }));
  const runtime = await import('../services/cardSyncRuntime');
  const pending = mode === 'save' ? (await runtime.getCardSync()).save('a.md', document,
    { base: { kind: 'present', revision: null }, baseSource: v1 }) : runtime.retryCardSync(true);
  await started.promise; await cloud.logout();
  response.resolve(Response.json(fileList([{ name: 'a.md', path: 'a.md' }]))); await pending;
  expect(transport.fetch.mock.calls.filter(([url]) => String(url).includes('download') || String(url).includes('upload'))).toEqual([]);
  expect((await saves.readCurrent('a.md')).draft?.source).toBe(v1);
  expect((await saves.readCurrent('a.md')).operation?.state.status).toBe('pending');
  transport.assertHandled();
});

it.each(['listing', 'download'] as const)('cancels a board %s request without publishing or caching its late response', async phase => {
  const transport = http.http;
  (await import('../stores/cloudStore')).setAuthenticationStatus(true);
  await db.saveCard(v1Card);
  const started = Promise.withResolvers<void>(); const response = Promise.withResolvers<Response>();
  let requestSignal: AbortSignal | null | undefined;
  const list = fileList([{ name: documentFilename, path: documentFilename }]);
  transport.on('GET', '/api/cloud/files', () => Response.json(list));
  const url = phase === 'listing' ? '/api/cloud/files' : `/api/cloud/download?path=${documentFilename}`;
  transport.on('GET', url, init => { requestSignal = init?.signal; started.resolve(); return response.promise; });
  const controller = new AbortController();
  const states: import('../application/loadBoard').BoardLoadState[] = [];
  const { app } = await import('../stores/appFacade');
  const loading = app.loadBoard(state => states.push(state), controller.signal);
  try {
    await started.promise; const published = structuredClone(states); controller.abort();
    expect(requestSignal?.aborted).toBe(true);
    response.resolve(phase === 'listing' ? Response.json(list) : new Response(v1)); await loading;
    expect(states).toEqual(published);
    expect(await db.getMarkdownDocument(documentSlug)).toBeNull();
  } finally { response.resolve(new Response(v1)); await loading; }
  transport.assertHandled();
});
