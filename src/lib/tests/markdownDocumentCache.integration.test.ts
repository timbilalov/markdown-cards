import { historicalStorage } from './helpers/historicalStorage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBObjectStore } from 'fake-indexeddb';
import { DBService, DBError, DBTransactionError, DBUnavailableError } from '../services/dbService';
import type { CachedMarkdownDocument } from '../services/dbService';
import type { Card, MarkdownParseResult } from '../domain/types';
import { makeCard, makeFile, NOW, storedCard } from './helpers/fixtures';
import { v1, v1Card, futureV1Shape, unknownMetadata } from './helpers/markdownReadFixtures';
import { legacyRecords, readLegacyDatabase, seedLegacyDatabase } from './helpers/legacyDatabase';
import { readStoredOperations } from './helpers/indexedDb';
import legacy from './fixtures/migration-legacy.md?raw';

const filename = 'existing-note'; // Deliberately different from the document's test-card ID.
let db: DBService;

beforeEach(() => { db = new DBService(); });

function expectedV1(name = filename, source = v1, card: Card = v1Card): CachedMarkdownDocument {
  return { filename: name, result: { status: 'success', document: { version: 1, source, card } } };
}

const rejectedSources: ReadonlyArray<{
  label: string;
  source: string;
  status: Exclude<MarkdownParseResult['status'], 'success'>;
  reason: Exclude<MarkdownParseResult, { status: 'success' }>['reason'];
}> = [
  { label: 'legacy with CRLF', source: legacy.replaceAll('\n', '\r\n'), status: 'unsupported', reason: 'missing-version' },
  { label: 'future version', source: futureV1Shape, status: 'unsupported', reason: 'unknown-version' },
  { label: 'unknown metadata', source: unknownMetadata, status: 'unsupported', reason: 'unsupported-content' },
  { label: 'malformed marker', source: v1.replace('markdown-cards: 1', 'markdown-cards: broken'), status: 'invalid', reason: 'invalid-version' },
  { label: 'invalid timestamp', source: v1.replace('2026-09-25T12:34:56.789Z', 'not-a-date'), status: 'invalid', reason: 'invalid-timestamp' },
  { label: 'unsafe card ID', source: v1.replace('\ntest-card\n', '\n../outside\n'), status: 'invalid', reason: 'invalid-id' },
  { label: 'empty source', source: '', status: 'unsupported', reason: 'missing-version' }
];

describe('source-document cache: exact source and compatibility after another service opens the DB', () => {
  it('retains the original filename, complete v1 fields and millisecond timestamps', async () => {
    await db.saveMarkdownDocument(filename, v1);

    const reopened = new DBService();
    expect(await reopened.getMarkdownDocument(filename)).toEqual(expectedV1());
    expect(await reopened.getMarkdownDocument(v1Card.meta.id)).toBeNull();
  });

  it('preserves CRLF, trailing blank lines and explicit timezone spelling without reserialization', async () => {
    const source = (v1.replace('2026-09-25T12:34:56.789Z', '2026-09-25T15:34:56.789+03:00') + '\n\n')
      .replaceAll('\n', '\r\n');
    await db.saveMarkdownDocument(filename, source);

    expect(await new DBService().getMarkdownDocument(filename)).toEqual(expectedV1(filename, source));
  });

  it.each(rejectedSources)('retains $label in full with its compatibility result and no partial Card', async ({ source, status, reason }) => {
    await db.saveMarkdownDocument(filename, source);

    expect(await new DBService().getMarkdownDocument(filename)).toEqual({
      filename, result: { status, source, reason }
    });
    expect(await db.getAllCards()).toEqual([]);
    expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
  });

  it('keeps different filenames independent even when their document IDs match', async () => {
    const names = ['Existing-Note', 'existing-note', 'Заметка 🗂'];
    for (const [index, name] of names.entries()) {
      await db.saveMarkdownDocument(name, v1.replace('# Карточка 🗂', `# Copy ${index}`));
    }

    const reopened = new DBService();
    for (const [index, name] of names.entries()) {
      expect(await reopened.getMarkdownDocument(name)).toEqual(expectedV1(
        name, v1.replace('# Карточка 🗂', `# Copy ${index}`), { ...v1Card, title: `Copy ${index}` }
      ));
    }
    expect(await reopened.getMarkdownDocument(v1Card.meta.id)).toBeNull();
  });

  it('changes compatibility from legacy to v1 only when the caller explicitly stores a new source', async () => {
    await db.saveMarkdownDocument(filename, legacy);
    expect(await db.getMarkdownDocument(filename)).toEqual({
      filename, result: { status: 'unsupported', source: legacy, reason: 'missing-version' }
    });
    await db.saveMarkdownDocument(filename, v1);

    expect(await new DBService().getMarkdownDocument(filename)).toEqual(expectedV1());
    expect(await db.getAllCards()).toEqual([]);
  });

  it('replaces a v1 source with the new unsupported source without retaining stale editable fields', async () => {
    await db.saveMarkdownDocument(filename, v1);
    await db.saveMarkdownDocument(filename, futureV1Shape);

    expect(await new DBService().getMarkdownDocument(filename)).toEqual({
      filename, result: { status: 'unsupported', source: futureV1Shape, reason: 'unknown-version' }
    });
  });

  it('returns null for a missing source document', async () => {
    expect(await db.getMarkdownDocument('missing-note')).toBeNull();
  });

  it('does not invent a Markdown source or filename mapping from an old Card-only cache', async () => {
    const card = makeCard();
    await db.saveCard(card);

    expect(await db.getMarkdownDocument(card.meta.id)).toBeNull();
    expect(await db.getMarkdownDocument(filename)).toBeNull();
    expect(await db.getCard(card.meta.id)).toEqual(storedCard(card));
  });

  it('does not let mutation of a returned document change later reads', async () => {
    await db.saveMarkdownDocument(filename, v1);
    const record = await db.getMarkdownDocument(filename);
    expect(record).toEqual(expectedV1());
    if (!record || record.result.status !== 'success') throw new Error('Expected cached v1');
    record.filename = 'changed-name';
    record.result.document.source = 'changed source';
    record.result.document.card.title = 'changed title';
    record.result.document.card.sections[0].items[0].text = 'changed item';

    expect(await db.getMarkdownDocument(filename)).toEqual(expectedV1());
    expect(await db.getMarkdownDocument('changed-name')).toBeNull();
  });

  it('stores raw source independently of existing Card, listing metadata and pending operations', async () => {
    const card = makeCard({ title: 'Local unsent edit' });
    const file = makeFile();
    const operation = { id: 'pending-edit', type: 'update' as const, card, timestamp: NOW, attempts: 2 };
    await db.saveCard(card);
    await historicalStorage.saveCloudFile(file);
    await historicalStorage.queueSyncOperation(operation);

    await db.saveMarkdownDocument(filename, unknownMetadata);

    expect(await db.getMarkdownDocument(filename)).toEqual({
      filename, result: { status: 'unsupported', source: unknownMetadata, reason: 'unsupported-content' }
    });
    expect(await db.getAllCards()).toEqual([storedCard(card)]);
    expect(await historicalStorage.getAllCloudFiles()).toEqual([file]);
    expect(await readStoredOperations()).toEqual([{ ...operation, status: 'pending' }]);
  });
});

describe('source-document cache: schema upgrade and transaction boundaries', () => {
  it('adds document storage to a populated v2 DB without rewriting cards, files or any queue status', async () => {
    await seedLegacyDatabase();
    const before = await readLegacyDatabase();

    await db.init();
    expect(await db.getMarkdownDocument(filename)).toBeNull();
    await db.saveMarkdownDocument(filename, v1);
    expect(await new DBService().getMarkdownDocument(filename)).toEqual(expectedV1());
    const after = await readLegacyDatabase();
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.records).toEqual(before.records);
    // The pre-existing status index must remain usable, with attempts intact.
    expect(await historicalStorage.getPendingSyncOperations()).toEqual(legacyRecords.syncQueue.filter(op => op.status === 'pending'));
  });

  it('rejects an aborted schema upgrade and leaves the existing v2 database intact', async () => {
    await seedLegacyDatabase();
    const before = await readLegacyDatabase();
    const open = indexedDB.open.bind(indexedDB);
    const spy = vi.spyOn(indexedDB, 'open').mockImplementation((...args) => {
      const request = open(...args);
      request.addEventListener('upgradeneeded', () => {
        queueMicrotask(() => request.transaction?.abort());
      });
      return request;
    });

    await expect(db.init()).rejects.toThrow(DBError);
    spy.mockRestore();
    expect(await readLegacyDatabase()).toEqual(before);
  });

  it('rejects an aborted write even after the put request succeeded, retaining the previous source', async () => {
    await db.saveMarkdownDocument(filename, v1);
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = put.apply(this, args);
      if (this.name === 'markdownDocuments') {
        request.addEventListener('success', () => this.transaction.abort());
      }
      return request;
    });

    await expect(db.saveMarkdownDocument(filename, futureV1Shape)).rejects.toThrow(DBTransactionError);
    spy.mockRestore();
    expect(await new DBService().getMarkdownDocument(filename)).toEqual(expectedV1());
  });

  it('reports an aborted read as a DB error, not a missing or successfully loaded document', async () => {
    await db.saveMarkdownDocument(filename, v1);
    const read = IDBObjectStore.prototype.get;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = read.apply(this, args);
      if (this.name === 'markdownDocuments') {
        request.addEventListener('success', () => this.transaction.abort());
      }
      return request;
    });

    await expect(db.getMarkdownDocument(filename)).rejects.toThrow(DBTransactionError);
    spy.mockRestore();
    expect(await db.getMarkdownDocument(filename)).toEqual(expectedV1());
  });

  it('does not claim a successful local save when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);

    await expect(db.saveMarkdownDocument(filename, v1)).rejects.toThrow(DBUnavailableError);
  });

  it('distinguishes an unavailable database from a missing document', async () => {
    vi.stubGlobal('indexedDB', undefined);

    await expect(db.getMarkdownDocument(filename)).rejects.toThrow(DBUnavailableError);
  });

  it('includes source documents in the existing explicit clear-all operation', async () => {
    await db.saveMarkdownDocument(filename, v1);
    await db.saveMarkdownDocument('incompatible-note', futureV1Shape);
    await db.saveCard(makeCard());
    await historicalStorage.saveCloudFile(makeFile());
    await historicalStorage.queueSyncOperation({ id: 'pending-edit', type: 'update', card: makeCard(), timestamp: NOW, attempts: 2 });
    await db.clearAllData();

    expect(await new DBService().getMarkdownDocument(filename)).toBeNull();
    expect(await db.getMarkdownDocument('incompatible-note')).toBeNull();
    expect(await db.getAllCards()).toEqual([]);
    expect(await historicalStorage.getAllCloudFiles()).toEqual([]);
    expect(await readStoredOperations()).toEqual([]);
  });
});
