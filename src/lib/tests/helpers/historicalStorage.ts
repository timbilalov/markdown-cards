import type { Card } from '../../domain/types';
import type { CloudFile } from '../../types/cloud';
import { parseMarkdownDocument } from '../../domain/markdown';
import type { LocalMarkdownSnapshot } from '../../services/dbService';

// Historical fixtures only. The application has no producer/replayer for these rows.
export interface OfflineOperation {
  id: string;
  type: 'create' | 'update' | 'delete';
  card?: Card;
  cardId?: string;
  path?: string;
  timestamp: number;
  attempts: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
}

async function transaction<T>(stores: string[], mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => () => T): Promise<T> {
  // Init the current schema only; seed content independently of production saves.
  await (await import('../../services/dbService')).dbService.init();
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('MarkdownCardsDB');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const result = run(tx);
      tx.oncomplete = () => resolve(result());
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export const historicalStorage = {
  async saveCloudFile(file: CloudFile): Promise<void> {
    await transaction(['files'], 'readwrite', tx => {
      tx.objectStore('files').put(file); return () => undefined;
    });
  },
  async getCloudFile(path: string): Promise<CloudFile | null> {
    return transaction(['files'], 'readonly', tx => {
      const request = tx.objectStore('files').get(path); return () => request.result ?? null;
    });
  },
  async getAllCloudFiles(): Promise<CloudFile[]> {
    return transaction(['files'], 'readonly', tx => {
      const request = tx.objectStore('files').getAll(); return () => request.result;
    });
  },
  async queueSyncOperation(operation: Omit<OfflineOperation, 'status'> & { status?: OfflineOperation['status'] }) {
    await transaction(['syncQueue'], 'readwrite', tx => {
      tx.objectStore('syncQueue').put({ status: 'pending', ...operation });
      return () => undefined;
    });
  },
  async getPendingSyncOperations(): Promise<OfflineOperation[]> {
    return transaction(['syncQueue'], 'readonly', tx => {
      const request = tx.objectStore('syncQueue').index('status').getAll('pending');
      return () => request.result;
    });
  },
  async saveLocalMarkdownSnapshot(snapshot: LocalMarkdownSnapshot) {
    const parsed = parseMarkdownDocument(snapshot.source);
    if (parsed.status !== 'success') throw new Error('Fixture must be valid v1 Markdown');
    const card = parsed.document.card;
    await transaction(['cards', 'localMarkdownSnapshots'], 'readwrite', tx => {
      tx.objectStore('cards').put({ ...card, meta: { ...card.meta, title: card.title } });
      tx.objectStore('localMarkdownSnapshots').put(snapshot);
      return () => undefined;
    });
  }
};
