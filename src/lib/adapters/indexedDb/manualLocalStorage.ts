import type { ManualLocalStorage, ManualSyncArchive } from '../../ports/manualLocalStorage';
import type { StoredMarkdownDraft } from '../../ports/cardSaveRepository';
import type { StoredMarkdownSource } from '../../ports/markdownSourceRepository';
import type { OutboxOperation } from '../../domain/outbox';
import type { NoteStorage } from '../../ports/noteStorage';
import type { CloudWriteResult } from '../../ports/cloudStorage';
import { checkIsMarkdownFilename } from '../../domain/markdownFilename';
import { runIndexedDbTransaction } from './transaction';

type Snapshot = Pick<ManualSyncArchive, 'draft' | 'remote' | 'operations'>;

function checkHasUnresolvedDelivery(snapshot: Snapshot): boolean {
  return snapshot.operations.some(
    row => row.state.status === 'processing' || row.state.status === 'uncertain'
  );
}

export class IndexedDbManualLocalStorage implements ManualLocalStorage {
  constructor(private readonly database: IDBDatabase) {}
  private async change(
    path: string,
    run: (tx: IDBTransaction, snapshot: Snapshot) => void
  ): Promise<void> {
    let failure: { reason: unknown } | undefined;
    try {
      await runIndexedDbTransaction(
        this.database,
        ['markdownDocuments', 'localMarkdownSnapshots', 'outbox', 'manualSyncArchives'],
        'readwrite',
        tx => {
          const filename = path.slice(0, -3);
          const draft = tx.objectStore('localMarkdownSnapshots').get(filename) as IDBRequest<
            StoredMarkdownDraft | undefined
          >;
          const remote = tx.objectStore('markdownDocuments').get(filename) as IDBRequest<
            StoredMarkdownSource | undefined
          >;
          const operations = tx.objectStore('outbox').getAll() as IDBRequest<OutboxOperation[]>;
          let remaining = 3;
          const complete = () => {
            if (--remaining) return;
            try {
              run(tx, {
                draft: draft.result ?? null,
                remote: remote.result ?? null,
                operations: operations.result.filter(row => row.path === path)
              });
            } catch (error) {
              failure = { reason: error };
              tx.abort();
            }
          };
          draft.onsuccess = remote.onsuccess = operations.onsuccess = complete;
        }
      );
    } catch (error) {
      throw failure ? failure.reason : error;
    }
  }
  private archive(tx: IDBTransaction, path: string, snapshot: Snapshot): void {
    if (snapshot.draft || snapshot.remote || snapshot.operations.length)
      tx.objectStore('manualSyncArchives').add({
        ...snapshot,
        id: crypto.randomUUID(),
        path,
        createdAt: Date.now()
      });
  }
  async copy(input: Parameters<NoteStorage['copy']>[0]): Promise<CloudWriteResult> {
    const { path, source, expectedTarget } = structuredClone(input);
    if (!checkIsMarkdownFilename(path)) return { status: 'invalid', reason: 'invalid-path' };
    if (
      typeof source !== 'string' ||
      !source.isWellFormed() ||
      new TextEncoder().encode(source).byteLength > 1024 * 1024
    )
      return { status: 'invalid', reason: 'invalid-source' };
    let result: CloudWriteResult = { status: 'conflict' };
    await this.change(path, (tx, snapshot) => {
      if (checkHasUnresolvedDelivery(snapshot)) return;
      const current = snapshot.draft ?? snapshot.remote;
      if (
        expectedTarget.status === 'missing'
          ? current !== null
          : current?.source !== expectedTarget.source
      )
        return;
      this.archive(tx, path, snapshot);
      for (const row of snapshot.operations)
        if (row.state.status !== 'completed') tx.objectStore('outbox').delete(row.id);
      tx.objectStore('localMarkdownSnapshots').put({
        filename: path.slice(0, -3),
        source,
        saveMode: 'update'
      });
      result = { status: 'written', revision: null };
    });
    return result;
  }
  async prepareCloud(path: string): Promise<'ready' | 'uncertain'> {
    let result: 'ready' | 'uncertain' = 'ready';
    await this.change(path, (tx, snapshot) => {
      if (checkHasUnresolvedDelivery(snapshot)) {
        result = 'uncertain';
        return;
      }
      const pending = snapshot.operations.filter(
        row => row.state.status !== 'completed' && row.state.status !== 'conflict'
      );
      if (!pending.length) return;
      this.archive(tx, path, snapshot);
      for (const row of pending)
        tx.objectStore('outbox').put({ ...row, state: { status: 'conflict' } });
    });
    return result;
  }
  private async retire(path: string, source?: string): Promise<void> {
    await this.change(path, (tx, snapshot) => {
      if (checkHasUnresolvedDelivery(snapshot)) throw new Error('Unresolved ordinary delivery');
      if (
        snapshot.draft ||
        snapshot.operations.some(row => row.state.status !== 'completed') ||
        (source !== undefined && snapshot.remote?.source !== source)
      )
        this.archive(tx, path, snapshot);
      for (const row of snapshot.operations)
        if (row.state.status !== 'completed') tx.objectStore('outbox').delete(row.id);
      const drafts = tx.objectStore('localMarkdownSnapshots');
      const filename = path.slice(0, -3);
      if (source !== undefined && snapshot.draft?.source === source) drafts.delete(filename);
      else if (snapshot.draft)
        drafts.put({ filename, source: snapshot.draft.source, saveMode: 'update' });
      if (source !== undefined) tx.objectStore('markdownDocuments').put({ filename, source });
    });
  }
  finishCloud(path: string, source: string): Promise<void> {
    return this.retire(path, source);
  }
  protect(path: string): Promise<void> {
    return this.retire(path);
  }
  async archives(): Promise<ManualSyncArchive[]> {
    let rows: ManualSyncArchive[] = [];
    await runIndexedDbTransaction(this.database, 'manualSyncArchives', 'readonly', tx => {
      const request = tx.objectStore('manualSyncArchives').getAll();
      request.onsuccess = () => {
        rows = request.result;
      };
    });
    return rows;
  }
}
