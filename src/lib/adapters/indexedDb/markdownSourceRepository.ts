import type { MarkdownSourceRepository, StoredMarkdownSource } from '../../ports/markdownSourceRepository';
import { runIndexedDbTransaction } from './transaction';

// Borrow the owner's open v4+ connection; do not open, upgrade or close it.
// Only the existing markdownDocuments store belongs to this adapter.
export class IndexedDbMarkdownSourceRepository implements MarkdownSourceRepository {
  constructor(private readonly database: IDBDatabase) {}

  async read(filename: string): Promise<StoredMarkdownSource | null> {
    let document: StoredMarkdownSource | null = null;
    await runIndexedDbTransaction(this.database, 'markdownDocuments', 'readonly', transaction => {
      const request: IDBRequest<StoredMarkdownSource | undefined> =
        transaction.objectStore('markdownDocuments').get(filename);
      request.addEventListener('success', () => {
        document = request.result ?? null;
      }, { once: true });
    });
    return document;
  }

  async write(document: Readonly<StoredMarkdownSource>): Promise<void> {
    const { filename, source } = document;
    await runIndexedDbTransaction(this.database, 'markdownDocuments', 'readwrite', transaction => {
      transaction.objectStore('markdownDocuments').put({ filename, source });
    });
  }
}
