import { expect, it, vi } from 'vitest';
import { installWebLocks } from './helpers/webLocks';
import { mockHttp } from './helpers/http';
import { initializeTestStorage, browserStorageDescriptor } from './helpers/browserStorageContext';
import { v1, v1Card } from './helpers/markdownReadFixtures';

it.each(['processing', 'unknown', 'unavailable'] as const)(
  'blocks a new ordinary Save behind a %s manual journal even when outbox was initially empty',
  async mode => {
    vi.resetModules();
    installWebLocks();
    const http = mockHttp();
    http.on('GET', '/api/cloud/files', () => Response.json({ _embedded: { items: [] } }));
    http.on('POST', '/api/cloud/upload', () => new Response('OK'));
    await initializeTestStorage(http);
    const database = (await import('../services/dbService')).dbService;
    const repositories = await database.getSyncRepositories();
    expect(await repositories.outbox.list()).toEqual([]);
    await (await database.getManualSyncRepository()).prepareCloud('note.md');
    const { IndexedDbManualSyncJournal } = await import('../adapters/indexedDb/manualSyncJournal');
    const journal = new IndexedDbManualSyncJournal();
    const operation = {
      id: 'manual',
      targetKey: `cloud:${browserStorageDescriptor.contextId}`,
      pathKey: 'note.md',
      path: 'note.md',
      sourceStorageId: 'reserve',
      targetStorageId: 'yandex',
      source: 'reference',
      startedAt: 1
    };
    await journal.begin(operation);
    await repositories.saves.save({
      id: 'during-network',
      path: 'note.md',
      document: { version: 1, source: v1, card: v1Card },
      base: { kind: 'missing' },
      createOnly: true,
      createdAt: 1
    });
    if (mode === 'unknown') await journal.settle(operation, 'unknown');
    // Same persistent context after module reload: no delivery even with an otherwise valid base.
    vi.resetModules();
    await initializeTestStorage(http);
    if (mode === 'unavailable') {
      const current = await import('../adapters/indexedDb/manualSyncJournal');
      vi.spyOn(current.IndexedDbManualSyncJournal.prototype, 'list').mockRejectedValue(
        new Error('journal unavailable')
      );
    }
    expect(await (await (await import('../services/cardSyncRuntime')).getCardSync()).retry()).toBe(
      mode === 'unavailable' ? 'storage-error' : 'uncertain'
    );
    expect(http.fetch.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/storages',
      '/api/storages'
    ]);
    expect((await repositories.outbox.list())[0].state.status).toBe('pending');
    http.assertHandled();
  }
);
