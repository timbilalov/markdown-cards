import { parseMarkdownDocument } from '../../domain/markdown';
import type { OutboxOperation } from '../../domain/outbox';
import type { Card } from '../../domain/types';
import type { StoredMarkdownDraft } from '../../ports/cardSaveRepository';
import type { StoredMarkdownSource } from '../../ports/markdownSourceRepository';
import type {
  RemoteMarkdownCacheRefresh, RemoteMarkdownCacheRepository, RemoteMarkdownCacheResult
} from '../../ports/remoteMarkdownCacheRepository';
import { runIndexedDbTransaction } from './transaction';

// Historical queue rows may identify a file, an embedded Card or a delete's ID.
// Read just the fields needed for protection without importing the old service.
interface LegacyOperation {
  status?: string;
  path?: string;
  cardId?: string;
  card?: { meta?: { id?: string } };
}

function checkHasLocalWork(
  input: RemoteMarkdownCacheRefresh,
  drafts: StoredMarkdownDraft[],
  operations: OutboxOperation[],
  legacyOperations: LegacyOperation[]
): boolean {
  const cardId = input.card?.meta.id;
  const path = `${input.filename}.md`;
  if (drafts.some(draft => {
    if (draft.filename === input.filename) return true;
    if (cardId === undefined) return false;
    if (typeof draft.source !== 'string') return true;
    const parsed = parseMarkdownDocument(draft.source);
    // Unknown ownership cannot authorize replacing this Card's local version.
    return parsed.status !== 'success' || parsed.document.card.meta.id === cardId;
  })) return true;

  if (operations.some(operation => operation.state?.status !== 'completed'
    && (operation.path === path || (cardId !== undefined && operation.cardId === cardId)))) return true;

  return legacyOperations.some(operation => operation.status !== 'completed'
    && (operation.path === path || (cardId !== undefined
      && (operation.cardId === cardId || operation.card?.meta?.id === cardId))));
}

// Cached Cards are plain records and arrays. Compare every stored field,
// including the title index alias, without depending on object key order.
function checkAreFieldsEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right) && left.length !== right.length) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key)
    && checkAreFieldsEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

export class IndexedDbRemoteMarkdownCacheRepository implements RemoteMarkdownCacheRepository {
  constructor(private readonly database: IDBDatabase) {}

  async refresh(input: Readonly<RemoteMarkdownCacheRefresh>): Promise<RemoteMarkdownCacheResult> {
    const snapshot = structuredClone(input);
    let result: RemoteMarkdownCacheResult = { status: 'retained', reason: 'changed' };
    const callbackFailure: { error?: { reason: unknown } } = {};

    try {
      await runIndexedDbTransaction(this.database,
        ['cards', 'markdownDocuments', 'localMarkdownSnapshots', 'outbox', 'syncQueue'], 'readwrite', transaction => {
          const cards = transaction.objectStore('cards');
          const documents = transaction.objectStore('markdownDocuments');
          const sourceRequest: IDBRequest<StoredMarkdownSource | undefined> = documents.get(snapshot.filename);
          const cardRequest: IDBRequest<Card | undefined> | null = snapshot.card
            ? cards.get(snapshot.card.meta.id) : null;
          const draftsRequest: IDBRequest<StoredMarkdownDraft[]> = transaction.objectStore('localMarkdownSnapshots').getAll();
          const outboxRequest: IDBRequest<OutboxOperation[]> = transaction.objectStore('outbox').getAll();
          const legacyRequest: IDBRequest<LegacyOperation[]> = transaction.objectStore('syncQueue').getAll();
          const requests: IDBRequest[] = [sourceRequest, draftsRequest, outboxRequest, legacyRequest];
          if (cardRequest) requests.push(cardRequest);

          // Enqueue dependent writes from the final read's success event while
          // the same transaction is active. No await separates guards and puts.
          let remaining = requests.length;
          for (const request of requests) request.addEventListener('success', () => {
            if (--remaining !== 0) return;
            try {
              if (checkHasLocalWork(snapshot, draftsRequest.result, outboxRequest.result, legacyRequest.result)) {
                // An internal-ID collision protects the existing Card, but must
                // not hide a newly discovered independent filename. Cache only
                // its source, without replacing any prior source or local work.
                if (!sourceRequest.result && snapshot.expected.source === null
                  && !checkHasLocalWork({ ...snapshot, card: null }, draftsRequest.result,
                    outboxRequest.result, legacyRequest.result)) {
                  documents.put({ filename: snapshot.filename, source: snapshot.source });
                  result = { status: 'updated' };
                  return;
                }
                result = { status: 'retained', reason: 'local-work' };
                return;
              }
              if ((sourceRequest.result?.source ?? null) !== snapshot.expected.source
                || (cardRequest && !checkAreFieldsEqual(cardRequest.result ?? null, snapshot.expected.card))) return;

              documents.put({ filename: snapshot.filename, source: snapshot.source });
              if (snapshot.card) cards.put({
                ...snapshot.card, meta: { ...snapshot.card.meta, title: snapshot.card.title },
                ...(snapshot.filename !== snapshot.card.meta.id ? { filename: snapshot.filename } : {})
              });
              result = { status: 'updated' };
            } catch (error) {
              // This handler runs after the helper's enqueue callback. Preserve
              // its original failure and let the helper wait for rollback.
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
}
