import type { OfflineOperation } from './historicalStorage';
import { makeCard, makeFile, NOW, storedCard } from './fixtures';

// Physical schema used before the source-document cache. Keep this independent
// of DBService.init so the upgrade tests exercise an actual existing database.
export const legacyRecords = {
  cards: [storedCard(makeCard())],
  files: [makeFile()],
  syncQueue: (['pending', 'processing', 'completed', 'failed'] as const).map((status, index): OfflineOperation => ({
    id: `operation-${status}`, type: 'update', card: makeCard({ title: `Unsent version ${index}` }),
    timestamp: NOW - index, attempts: index + 1, status
  }))
};

export async function seedLegacyDatabase(): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('MarkdownCardsDB', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      const cards = db.createObjectStore('cards', { keyPath: 'meta.id' });
      cards.createIndex('title', 'meta.title');
      cards.createIndex('modified', 'meta.modified');
      const files = db.createObjectStore('files', { keyPath: 'path' });
      files.createIndex('name', 'name');
      files.createIndex('modified', 'modified');
      const queue = db.createObjectStore('syncQueue', { keyPath: 'id' });
      queue.createIndex('timestamp', 'timestamp');
      queue.createIndex('status', 'status');
      for (const card of legacyRecords.cards) cards.put(card);
      for (const file of legacyRecords.files) files.put(file);
      for (const operation of legacyRecords.syncQueue) queue.put(operation);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
}

export async function readLegacyDatabase() {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('MarkdownCardsDB');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<{
      version: number;
      records: { cards: unknown[]; files: unknown[]; syncQueue: unknown[] };
    }>((resolve, reject) => {
      const tx = db.transaction(['cards', 'files', 'syncQueue'], 'readonly');
      const cards = tx.objectStore('cards').getAll();
      const files = tx.objectStore('files').getAll();
      const queue = tx.objectStore('syncQueue').getAll();
      tx.oncomplete = () => resolve({
        version: db.version,
        records: { cards: cards.result, files: files.result, syncQueue: queue.result }
      });
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
