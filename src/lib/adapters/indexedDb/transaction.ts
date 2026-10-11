// Borrow an open connection; its owner manages schema upgrades and close().
// Enqueue requests synchronously (or from their IndexedDB event handlers).
// Returning undefined excludes async callbacks from the public contract.
// Fulfil only on complete; abort rolls back the whole scope and rejects.
export async function runIndexedDbTransaction(
  database: IDBDatabase,
  stores: string | readonly string[],
  mode: 'readonly' | 'readwrite',
  enqueue: (transaction: IDBTransaction) => undefined
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(typeof stores === 'string' ? stores : [...stores], mode);
    // Keep a thrown undefined distinguishable from no callback failure.
    let enqueueError: { reason: unknown } | undefined;
    let requestFailure: { event: Event; reason: DOMException } | undefined;

    transaction.addEventListener('complete', () => {
      if (enqueueError) reject(enqueueError.reason);
      else resolve();
    }, { once: true });
    transaction.addEventListener('abort', () => {
      const requestError = requestFailure && !requestFailure.event.defaultPrevented
        ? requestFailure.reason : null;
      reject(enqueueError ? enqueueError.reason : requestError
        ?? transaction.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError'));
    }, { once: true });

    // A request error can be handled with preventDefault; only abort establishes
    // transaction failure. Do not reject on the bubbling request error event.
    transaction.addEventListener('error', event => {
      const request = event.target as IDBRequest<unknown> | null;
      if (request?.error && (!requestFailure || requestFailure.event.defaultPrevented)) {
        // Retain the event too: a later transaction/database handler may cancel
        // it. A recovered error must not replace a subsequent failure's cause.
        requestFailure = { event, reason: request.error };
      }
    });
    try {
      enqueue(transaction);
    } catch (error) {
      enqueueError = { reason: error };
      try {
        transaction.abort();
      } catch {
        // The callback may already have aborted the transaction. Wait for its
        // terminal event instead of rejecting before the queued writes roll back.
      }
    }
  });
}
