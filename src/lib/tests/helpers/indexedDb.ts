import type { OfflineOperation } from './historicalStorage';

// Inspect persisted states that the current public API hides (it only lists pending).
export async function readStoredOperations(): Promise<OfflineOperation[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('MarkdownCardsDB');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<OfflineOperation[]>((resolve, reject) => {
      const tx = db.transaction('syncQueue', 'readonly');
      const request = tx.objectStore('syncQueue').getAll();
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
