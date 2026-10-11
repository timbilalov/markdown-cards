import type { OutboxOperation } from '../../domain/outbox';
import { finishOutboxDelivery, recoverOutboxDelivery, startOutboxDelivery } from '../../domain/outbox';
import type { OutboxApplyResult, OutboxEvent, OutboxRepository } from '../../ports/outboxRepository';
import { runIndexedDbTransaction } from './transaction';
import type { StoredMarkdownDraft } from '../../ports/cardSaveRepository';

// Borrow an owner's connection with an outbox store keyed by id. This adapter
// does not open, upgrade, close or repair storage, or migrate the legacy queue.
export class IndexedDbOutboxRepository implements OutboxRepository {
  constructor(private readonly database: IDBDatabase) {}

  async read(id: string): Promise<OutboxOperation | null> {
    let operation: OutboxOperation | null = null;
    await runIndexedDbTransaction(this.database, 'outbox', 'readonly', transaction => {
      const request: IDBRequest<OutboxOperation | undefined> = transaction.objectStore('outbox').get(id);
      request.addEventListener('success', () => {
        operation = request.result ?? null;
      }, { once: true });
    });
    return operation;
  }

  async list(): Promise<OutboxOperation[]> {
    let operations: OutboxOperation[] = [];
    await runIndexedDbTransaction(this.database, 'outbox', 'readonly', transaction => {
      const request: IDBRequest<OutboxOperation[]> = transaction.objectStore('outbox').getAll();
      request.addEventListener('success', () => {
        operations = request.result;
      }, { once: true });
    });
    return operations;
  }

  async add(operation: Readonly<OutboxOperation>): Promise<void> {
    await runIndexedDbTransaction(this.database, 'outbox', 'readwrite', transaction => {
      // Native add captures nested input synchronously and rejects duplicate IDs.
      transaction.objectStore('outbox').add(operation);
    });
  }

  async apply(id: string, event: Readonly<OutboxEvent>): Promise<OutboxApplyResult> {
    // The read callback runs later; retain the submitted outcome/policy as well.
    const snapshot = structuredClone(event);
    let result: OutboxApplyResult = { status: 'missing' };
    const callbackFailure: { error?: { reason: unknown } } = {};

    try {
      await runIndexedDbTransaction(this.database, 'outbox', 'readwrite', transaction => {
        const store = transaction.objectStore('outbox');
        const request: IDBRequest<OutboxOperation | undefined> = store.get(id);
        request.addEventListener('success', () => {
          try {
            const operation = request.result;
            if (!operation) return;

            switch (snapshot.type) {
              case 'start':
                result = startOutboxDelivery(operation, snapshot);
                break;
              case 'finish':
                result = finishOutboxDelivery(operation, snapshot, snapshot.policy);
                break;
              case 'recover':
                result = recoverOutboxDelivery(operation);
                break;
              case 'retry':
                result = operation.state.status === 'failed'
                  ? { status: 'changed', operation: { ...operation,
                    state: { ...operation.state, nextAttemptAt: snapshot.now } } }
                  : { status: 'ignored', reason: 'invalid-state' };
                break;
            }
            if (result.status === 'changed') store.put(result.operation);
          } catch (error) {
            // The helper's enqueue callback has already returned. Capture a
            // synchronous handler failure here, then wait for rollback below.
            callbackFailure.error = { reason: error };
            try {
              transaction.abort();
            } catch {
              // An earlier handler may already have aborted this transaction.
            }
          }
        }, { once: true });
      });
    } catch (error) {
      throw callbackFailure.error ? callbackFailure.error.reason : error;
    }
    return result;
  }

  async pruneCompleted(limit: number): Promise<void> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid history limit');
    let callbackError: unknown;
    try {
      await runIndexedDbTransaction(this.database, ['outbox', 'localMarkdownSnapshots'], 'readwrite', tx => {
        const store = tx.objectStore('outbox');
        const rows: IDBRequest<OutboxOperation[]> = store.getAll();
        const drafts: IDBRequest<StoredMarkdownDraft[]> = tx.objectStore('localMarkdownSnapshots').getAll();
        let remaining = 2;
        const prune = () => {
          if (--remaining) return;
          try {
            const protectedPaths = new Set(drafts.result.map(draft => `${draft.filename}.md`));
            for (const row of rows.result) {
              if (['processing', 'uncertain', 'conflict'].includes(row.state.status)) protectedPaths.add(row.path);
            }
            const completed = rows.result.filter(row => row.state.status === 'completed' && !protectedPaths.has(row.path));
            const acknowledgedPaths = new Set(completed.map(row => row.path));
            completed.sort((a, b) => {
              const time = (row: OutboxOperation) => row.state.status === 'completed' ? row.state.completedAt : 0;
              return time(b) - time(a) || b.id.localeCompare(a.id);
            });
            for (const row of completed.slice(limit)) store.delete(row.id);
            for (const row of rows.result) {
              if (acknowledgedPaths.has(row.path) && (row.state.status === 'pending' || row.state.status === 'failed')) {
                store.delete(row.id);
              }
            }
          } catch (error) { callbackError = error; tx.abort(); }
        };
        rows.addEventListener('success', prune, { once: true });
        drafts.addEventListener('success', prune, { once: true });
      });
    } catch (error) { throw callbackError ?? error; }
  }
}
