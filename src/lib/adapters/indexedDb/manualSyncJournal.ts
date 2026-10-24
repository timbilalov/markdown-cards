import type {
  ManualSyncJournal,
  ManualSyncOperation,
  PendingManualSync
} from '../../ports/manualSyncJournal';
import { runIndexedDbTransaction } from './transaction';

type Observe = <T>(request: IDBRequest<T>, receive: (value: T) => void) => void;

export class IndexedDbManualSyncJournal implements ManualSyncJournal {
  private async transaction(
    stores: string[],
    mode: 'readonly' | 'readwrite',
    run: (tx: IDBTransaction, observe: Observe) => void
  ): Promise<void> {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('MarkdownCardsManualSync', 2);
      let rejected = false;
      request.onupgradeneeded = () => {
        if (rejected) {
          request.transaction?.abort();
          return;
        }
        if (!request.result.objectStoreNames.contains('operations'))
          request.result.createObjectStore('operations', { keyPath: ['targetKey', 'pathKey'] });
        if (!request.result.objectStoreNames.contains('history'))
          request.result.createObjectStore('history', { keyPath: 'id' });
      };
      request.onsuccess = () => {
        if (rejected) request.result.close();
        else resolve(request.result);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        rejected = true;
        reject(new Error('Manual sync journal blocked'));
      };
    });
    let failure: { reason: unknown } | undefined;
    try {
      await runIndexedDbTransaction(database, stores, mode, tx => {
        run(tx, (request, receive) => {
          request.onsuccess = () => {
            try {
              receive(request.result);
            } catch (error) {
              failure = { reason: error };
              tx.abort();
            }
          };
        });
      });
    } catch (error) {
      throw failure ? failure.reason : error;
    } finally {
      database.close();
    }
  }
  async begin(operation: ManualSyncOperation): Promise<boolean> {
    const captured = structuredClone(operation);
    let created = false;
    await this.transaction(['operations'], 'readwrite', (tx, observe) => {
      const store = tx.objectStore('operations');
      observe(store.get([captured.targetKey, captured.pathKey]), current => {
        if (!current) {
          store.put({ ...captured, state: 'processing' });
          created = true;
        }
      });
    });
    return created;
  }
  private async finish(
    operation: ManualSyncOperation,
    outcome: 'known' | 'unknown' | 'dismiss'
  ): Promise<void> {
    const captured = structuredClone(operation);
    let stale = false;
    await this.transaction(
      outcome === 'dismiss' ? ['operations', 'history'] : ['operations'],
      'readwrite',
      (tx, observe) => {
        const store = tx.objectStore('operations');
        const key = [captured.targetKey, captured.pathKey];
        observe(store.get(key), current => {
          if (current?.id !== captured.id) {
            stale = true;
            return;
          }
          if (outcome === 'unknown') store.put({ ...current, state: 'unknown' });
          else {
            if (outcome === 'dismiss') tx.objectStore('history').add(current);
            store.delete(key);
          }
        });
      }
    );
    if (stale) throw new Error('Stale manual sync acknowledgement');
  }
  settle(operation: ManualSyncOperation, outcome: 'known' | 'unknown'): Promise<void> {
    return this.finish(operation, outcome);
  }
  dismiss(operation: ManualSyncOperation): Promise<void> {
    return this.finish(operation, 'dismiss');
  }
  private async records<T>(name: string): Promise<T[]> {
    let rows: T[] = [];
    await this.transaction([name], 'readonly', (tx, observe) => {
      observe(tx.objectStore(name).getAll(), values => {
        rows = values;
      });
    });
    return rows;
  }
  list(): Promise<PendingManualSync[]> {
    return this.records('operations');
  }
  history(): Promise<ManualSyncOperation[]> {
    return this.records('history');
  }
}
