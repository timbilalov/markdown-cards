import type { OutboxOperation } from '../../domain/outbox';
import { createOutboxOperation, finishOutboxDelivery } from '../../domain/outbox';
import type {
  CardSaveDelivery, CardSaveDeliveryResult, CardSaveDraft, CardSaveRepository, CardSaveSnapshot,
  SavedMarkdownDraft, StoredMarkdownDraft
} from '../../ports/cardSaveRepository';
import type { StoredMarkdownSource } from '../../ports/markdownSourceRepository';
import { runIndexedDbTransaction } from './transaction';

// Borrow an open connection. Opening/upgrading/closing remain the owner's responsibility.
export class IndexedDbCardSaveRepository implements CardSaveRepository {
  constructor(private readonly database: IDBDatabase) {}

  async readCurrent(path: string): Promise<CardSaveSnapshot> {
    const filename = path.slice(0, -3);
    const result: CardSaveSnapshot = { draft: null, operation: null, remote: null };
    const callbackFailure: { error?: { reason: unknown } } = {};

    try {
      await runIndexedDbTransaction(this.database,
        ['localMarkdownSnapshots', 'outbox', 'markdownDocuments'], 'readonly', transaction => {
          const draftRequest: IDBRequest<StoredMarkdownDraft | undefined> =
            transaction.objectStore('localMarkdownSnapshots').get(filename);
          const remoteRequest: IDBRequest<StoredMarkdownSource | undefined> =
            transaction.objectStore('markdownDocuments').get(filename);
          remoteRequest.addEventListener('success', () => {
            result.remote = remoteRequest.result ?? null;
          }, { once: true });
          draftRequest.addEventListener('success', () => {
            try {
              result.draft = draftRequest.result ?? null;
              const saveId = result.draft?.saveId;
              if (saveId === undefined) return;

              // Resolve only the stored link in this same snapshot. Missing or
              // inconsistent data stays visible to the application as-is.
              const operationRequest: IDBRequest<OutboxOperation | undefined> =
                transaction.objectStore('outbox').get(saveId);
              operationRequest.addEventListener('success', () => {
                result.operation = operationRequest.result ?? null;
              }, { once: true });
            } catch (error) {
              // The dependent request is enqueued after the helper callback.
              // Preserve its original failure, including a thrown undefined.
              callbackFailure.error ??= { reason: error };
              try {
                transaction.abort();
              } catch {
                // Another handler may already have aborted this transaction.
              }
            }
          }, { once: true });
        });
    } catch (error) {
      throw callbackFailure.error ? callbackFailure.error.reason : error;
    }
    return result;
  }

  async save(draft: Readonly<CardSaveDraft>): Promise<OutboxOperation> {
    // Keep one submitted version while the caller continues editing. The
    // returned operation and native stored records also stay detached from it.
    const snapshot = structuredClone(draft);
    const { card, source } = snapshot.document;
    const operation = createOutboxOperation({
      id: snapshot.id,
      cardId: card.meta.id,
      path: snapshot.path,
      source,
      createOnly: snapshot.createOnly,
      base: snapshot.base,
      ...(snapshot.baseSource === undefined ? {} : { baseSource: snapshot.baseSource }),
      ...(snapshot.previousSaveId === undefined ? {} : { previousSaveId: snapshot.previousSaveId }),
      createdAt: snapshot.createdAt
    });
    const localDraft: SavedMarkdownDraft = {
      filename: snapshot.path.slice(0, -3),
      source,
      saveMode: snapshot.createOnly ? 'create' : 'update',
      saveId: snapshot.id
    };

    await runIndexedDbTransaction(this.database,
      ['cards', 'localMarkdownSnapshots', 'outbox'], 'readwrite', transaction => {
        transaction.objectStore('cards').put({
          ...card, meta: { ...card.meta, title: card.title },
          ...(localDraft.filename !== card.meta.id ? { filename: localDraft.filename } : {})
        });
        transaction.objectStore('localMarkdownSnapshots').put(localDraft);
        // Insert-only: a reused Save ID aborts this entire transaction, including
        // both puts above. Older operations remain available to the sync worker.
        transaction.objectStore('outbox').add(operation);
      });
    return operation;
  }

  async finishDelivery(id: string, delivery: Readonly<CardSaveDelivery>): Promise<CardSaveDeliveryResult> {
    const snapshot = structuredClone(delivery);
    let result: CardSaveDeliveryResult = { status: 'missing' };
    const callbackFailure: { error?: { reason: unknown } } = {};

    try {
      await runIndexedDbTransaction(this.database,
        ['outbox', 'localMarkdownSnapshots', 'markdownDocuments'], 'readwrite', transaction => {
          const abortFromCallback = (error: unknown): void => {
            // Read handlers run after the helper's enqueue callback returns.
            // Retain their original failure, then let the helper await rollback.
            callbackFailure.error ??= { reason: error };
            try {
              transaction.abort();
            } catch {
              // Another handler may already have aborted this transaction.
            }
          };
          const outbox = transaction.objectStore('outbox');
          const request: IDBRequest<OutboxOperation | undefined> = outbox.get(id);
          request.addEventListener('success', () => {
            try {
              const operation = request.result;
              if (!operation) return;

              const transition = finishOutboxDelivery(operation, snapshot, snapshot.policy);
              if (transition.status === 'ignored') {
                result = transition;
                return;
              }

              const updated = transition.operation;
              outbox.put(updated);
              if (updated.state.status !== 'completed') {
                result = { ...transition, draft: 'retained' };
                return;
              }

              const filename = updated.path.slice(0, -3);
              const drafts = transaction.objectStore('localMarkdownSnapshots');
              const currentRequest: IDBRequest<StoredMarkdownDraft | undefined> = drafts.get(filename);
              currentRequest.addEventListener('success', () => {
                try {
                  const current = currentRequest.result;
                  if (!current) {
                    result = { ...transition, draft: 'missing' };
                    return;
                  }
                  if (current.saveId !== updated.id || current.source !== updated.source
                    || current.saveMode !== (updated.createOnly ? 'create' : 'update')) {
                    result = { ...transition, draft: 'superseded' };
                    return;
                  }

                  // Completion, cache update and acknowledgement commit together.
                  // A late result never clears a newer or legacy draft.
                  transaction.objectStore('markdownDocuments').put({ filename, source: updated.source });
                  drafts.delete(filename);
                  result = { ...transition, draft: 'confirmed' };
                } catch (error) {
                  abortFromCallback(error);
                }
              }, { once: true });
            } catch (error) {
              abortFromCallback(error);
            }
          }, { once: true });
        });
    } catch (error) {
      throw callbackFailure.error ? callbackFailure.error.reason : error;
    }
    return result;
  }
}
