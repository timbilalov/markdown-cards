import type { BoardLocalCard, BoardLocalEntry, Card, MarkdownParseResult } from '../domain/types';
import { parseMarkdownDocument } from '../domain/markdown';
import { IndexedDbMarkdownSourceRepository } from '../adapters/indexedDb/markdownSourceRepository';
import { IndexedDbLocalCardRepository } from '../adapters/indexedDb/localCardRepository';
import { IndexedDbRemoteMarkdownCacheRepository } from '../adapters/indexedDb/remoteMarkdownCacheRepository';
import { IndexedDbCardSaveRepository } from '../adapters/indexedDb/cardSaveRepository';
import { IndexedDbOutboxRepository } from '../adapters/indexedDb/outboxRepository';
import type { RemoteMarkdownCacheRefresh, RemoteMarkdownCacheResult } from '../ports/remoteMarkdownCacheRepository';
import type { StoredMarkdownSource } from '../ports/markdownSourceRepository';
import type { StoredMarkdownDraft } from '../ports/cardSaveRepository';
import { runIndexedDbTransaction } from '../adapters/indexedDb/transaction';

// The filename is the editor's basename (without .md), independent of Card ID.
// Compatibility/version is derived from the exact stored source on every read.
export interface CachedMarkdownDocument {
  filename: string;
  result: MarkdownParseResult;
}

// A validated Save awaiting local acknowledgement of a successful upload.
// Separate from downloaded source; not yet an automatic-delivery outbox.
export interface LocalMarkdownSnapshot {
  filename: string;
  source: string;
  saveMode: 'create' | 'update';
}


// Error types for better error handling
export class DBError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'DBError';
  }
}

export class DBUnavailableError extends DBError {
  constructor(message: string = 'Database unavailable') {
    super(message, 'DB_UNAVAILABLE');
    this.name = 'DBUnavailableError';
  }
}

export class DBQuotaExceededError extends DBError {
  constructor(message: string = 'Database quota exceeded') {
    super(message, 'QUOTA_EXCEEDED');
    this.name = 'DBQuotaExceededError';
  }
}

export class DBTransactionError extends DBError {
  constructor(message: string = 'Database transaction failed') {
    super(message, 'TRANSACTION_FAILED');
    this.name = 'DBTransactionError';
  }
}

export class DBService {
  private db: IDBDatabase | null = null;
  private initialization: Promise<void> | null = null;
  private readonly DB_NAME = 'MarkdownCardsDB';
  private readonly VERSION = 5;
  private readonly CARDS_STORE = 'cards';
  private readonly FILES_STORE = 'files';
  private readonly SYNC_QUEUE_STORE = 'syncQueue'; // Retained historical records; never replayed
  private readonly MARKDOWN_DOCUMENTS_STORE = 'markdownDocuments';
  private readonly LOCAL_MARKDOWN_SNAPSHOTS_STORE = 'localMarkdownSnapshots';
  private readonly OUTBOX_STORE = 'outbox';

  // Performance monitoring
  private performanceMetrics: {
    operations: number;
    totalDuration: number;
    errors: number;
  } = {
    operations: 0,
    totalDuration: 0,
    errors: 0
  };

  // Check if we're in a browser environment
  private checkIsBrowser(): boolean {
    return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
  }

  async init(): Promise<void> {
    if (this.db) return;
    this.initialization ??= this.openDatabase().catch(error => { this.initialization = null; throw error; });
    return this.initialization;
  }

  private async openDatabase(): Promise<void> {
    // Skip initialization on server-side
    if (!this.checkIsBrowser()) {
      return Promise.resolve();
    }

    const startTime = performance.now();

    try {
      const request = indexedDB.open(this.DB_NAME, this.VERSION);

      return new Promise((resolve, reject) => {
        let isRejected = false;
        const rejectOpen = (error: DBError): void => {
          if (isRejected) return;
          isRejected = true;
          this.recordError();
          reject(error);
        };

        request.onupgradeneeded = () => {
          // A blocked open cannot be cancelled until its upgrade starts.
          // Abort before changing the schema if init() already rejected it.
          if (isRejected) {
            request.transaction?.abort();
            return;
          }
          const db = request.result;

          try {
            // Create cards store
            if (!db.objectStoreNames.contains(this.CARDS_STORE)) {
              const cardStore = db.createObjectStore(this.CARDS_STORE, { keyPath: 'meta.id' });
              cardStore.createIndex('title', 'meta.title', { unique: false });
              cardStore.createIndex('modified', 'meta.modified', { unique: false });
            }

            // Create files store for cloud file metadata
            if (!db.objectStoreNames.contains(this.FILES_STORE)) {
              const fileStore = db.createObjectStore(this.FILES_STORE, { keyPath: 'path' });
              fileStore.createIndex('name', 'name', { unique: false });
              fileStore.createIndex('modified', 'modified', { unique: false });
            }

            // Keep legacy queue records untouched; do not replay or convert them.
            if (!db.objectStoreNames.contains(this.SYNC_QUEUE_STORE)) {
              const queueStore = db.createObjectStore(this.SYNC_QUEUE_STORE, { keyPath: 'id' });
              queueStore.createIndex('timestamp', 'timestamp', { unique: false });
              queueStore.createIndex('status', 'status', { unique: false });
            }

            // Add source storage without reconstructing documents from old Cards
            // or changing their records, indexes or pending operations.
            if (!db.objectStoreNames.contains(this.MARKDOWN_DOCUMENTS_STORE)) {
              db.createObjectStore(this.MARKDOWN_DOCUMENTS_STORE, { keyPath: 'filename' });
            }

            // Local saves must survive later downloads of the remote source.
            if (!db.objectStoreNames.contains(this.LOCAL_MARKDOWN_SNAPSHOTS_STORE)) {
              db.createObjectStore(this.LOCAL_MARKDOWN_SNAPSHOTS_STORE, { keyPath: 'filename' });
            }

            if (!db.objectStoreNames.contains(this.OUTBOX_STORE)) {
              db.createObjectStore(this.OUTBOX_STORE, { keyPath: 'id' });
            }
          } catch {
            // Wait for the open error after rollback instead of throwing from
            // an event handler or exposing a partially upgraded database.
            request.transaction?.abort();
          }
        };

        request.onsuccess = () => {
          if (isRejected) {
            request.result.close();
            return;
          }
          this.db = request.result;
          const connection = this.db;
          const release = () => {
            if (this.db === connection) { this.db = null; this.initialization = null; }
          };
          connection.onversionchange = () => { connection.close(); release(); };
          connection.onclose = release;
          this.recordOperation(performance.now() - startTime);
          resolve();
        };

        request.onerror = () => {
          rejectOpen(new DBError('Failed to open IndexedDB', 'OPEN_FAILED'));
        };

        request.onblocked = () => {
          rejectOpen(new DBError('IndexedDB upgrade blocked by another connection', 'OPEN_BLOCKED'));
        };
      });
    } catch (error) {
      this.recordError();
      if (error instanceof DBError) {
        throw error;
      }
      throw new DBError('Failed to initialize database', 'INIT_FAILED');
    }
  }

  private async getDb(): Promise<IDBDatabase> {
    if (!this.checkIsBrowser()) {
      throw new DBError('Database operations not available on server-side', 'SERVER_SIDE');
    }

    // Initialize database if not already initialized
    if (!this.db) {
      await this.init();
    }

    if (!this.db) {
      throw new DBUnavailableError('Database not initialized');
    }
    return this.db;
  }

  // Connection ownership stays here; use cases only receive repository ports.
  async getSyncRepositories() {
    const db = await this.getDb();
    return { saves: new IndexedDbCardSaveRepository(db), outbox: new IndexedDbOutboxRepository(db) };
  }

  // Utility function to handle database operations with retry logic
  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    delay: number = 1000
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        // Don't retry for certain errors
        if (error instanceof DBQuotaExceededError || error instanceof DBUnavailableError) {
          throw error;
        }

        // If this is the last attempt, throw the error
        if (attempt === maxRetries) {
          throw error;
        }

        // Wait before retrying with exponential backoff
        await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, attempt)));
      }
    }

    throw lastError;
  }

  // Performance monitoring utilities
  private recordOperation(duration: number): void {
    this.performanceMetrics.operations++;
    this.performanceMetrics.totalDuration += duration;
  }

  private recordError(): void {
    this.performanceMetrics.errors++;
  }

  getPerformanceMetrics(): {
    operations: number;
    totalDuration: number;
    errors: number;
    averageDuration: number;
    errorRate: number;
  } {
    return {
      operations: this.performanceMetrics.operations,
      totalDuration: this.performanceMetrics.totalDuration,
      errors: this.performanceMetrics.errors,
      averageDuration: this.performanceMetrics.operations > 0
        ? this.performanceMetrics.totalDuration / this.performanceMetrics.operations
        : 0,
      errorRate: this.performanceMetrics.operations > 0
        ? this.performanceMetrics.errors / this.performanceMetrics.operations
        : 0
    };
  }

  resetPerformanceMetrics(): void {
    this.performanceMetrics = {
      operations: 0,
      totalDuration: 0,
      errors: 0
    };
  }

  async saveMarkdownDocument(filename: string, source: string): Promise<void> {
    if (!this.checkIsBrowser()) throw new DBUnavailableError();
    const startTime = performance.now();

    try {
      const db = await this.getDb();
      const repository = new IndexedDbMarkdownSourceRepository(db);
      // Translate storage failures at the facade; opening errors stay intact.
      await repository.write({ filename, source }).catch((error: unknown) => {
        throw new DBTransactionError(
          `Failed to save Markdown document: ${error instanceof Error || error instanceof DOMException
            ? error.message : 'transaction failed'}`
        );
      });
      this.recordOperation(performance.now() - startTime);
    } catch (error) {
      this.recordError();
      throw error;
    }
  }

  async getMarkdownDocument(filename: string): Promise<CachedMarkdownDocument | null> {
    if (!this.checkIsBrowser()) throw new DBUnavailableError();
    const startTime = performance.now();

    try {
      const db = await this.getDb();
      const repository = new IndexedDbMarkdownSourceRepository(db);
      const record = await repository.read(filename).catch((error: unknown) => {
        throw new DBTransactionError(
          `Failed to read Markdown document: ${error instanceof Error || error instanceof DOMException
            ? error.message : 'transaction failed'}`
        );
      });
      // Derive compatibility from the stored source, never from a migration flag
      // or a reserialized Card. Empty/unsupported source is still a record.
      const document = record === null ? null : {
        filename: record.filename,
        result: parseMarkdownDocument(record.source)
      };
      this.recordOperation(performance.now() - startTime);
      return document;
    } catch (error) {
      this.recordError();
      throw error;
    }
  }

  async refreshMarkdownCache(input: Readonly<RemoteMarkdownCacheRefresh>): Promise<RemoteMarkdownCacheResult> {
    if (!this.checkIsBrowser()) throw new DBUnavailableError();
    const startTime = performance.now();

    try {
      // Preserve the submitted document and pre-download expectations while
      // getDb yields, then let the repository guard and commit them together.
      const snapshot = structuredClone(input);
      const db = await this.getDb();
      const result = await new IndexedDbRemoteMarkdownCacheRepository(db).refresh(snapshot);
      this.recordOperation(performance.now() - startTime);
      return result;
    } catch (error) {
      this.recordError();
      if (error instanceof DBError) throw error;
      throw new DBTransactionError(
        `Failed to refresh Markdown cache: ${error instanceof Error || error instanceof DOMException
          ? error.message : 'transaction failed'}`
      );
    }
  }

  async getLocalMarkdownSnapshot(filename: string): Promise<LocalMarkdownSnapshot | null> {
    if (!this.checkIsBrowser()) throw new DBUnavailableError();
    const startTime = performance.now();

    try {
      const db = await this.getDb();
      const snapshot = await new Promise<LocalMarkdownSnapshot | null>((resolve, reject) => {
        const transaction = db.transaction(this.LOCAL_MARKDOWN_SNAPSHOTS_STORE, 'readonly');
        const request: IDBRequest<LocalMarkdownSnapshot | undefined> =
          transaction.objectStore(this.LOCAL_MARKDOWN_SNAPSHOTS_STORE).get(filename);
        transaction.oncomplete = () => resolve(request.result ?? null);
        transaction.onabort = () => reject(new DBTransactionError(
          `Failed to read local Markdown snapshot: ${transaction.error?.message ?? 'transaction aborted'}`
        ));
      });
      this.recordOperation(performance.now() - startTime);
      return snapshot;
    } catch (error) {
      this.recordError();
      throw error;
    }
  }

  // Card operations
  async saveCard(card: Card): Promise<void> {
    // Skip database operations on server-side
    if (!this.checkIsBrowser()) {
      return Promise.resolve();
    }

    const startTime = performance.now();

    try {
      // Capture nested edits before even an already-open getDb yields control.
      const snapshot = structuredClone(card);
      const db = await this.getDb();
      await new IndexedDbLocalCardRepository(db).write(snapshot);
      this.recordOperation(performance.now() - startTime);
    } catch (error) {
      this.recordError();
      // Preserve typed facade/opening errors; translate native storage failures.
      if (error instanceof DBError) throw error;
      throw new DBTransactionError(
        `Failed to save card: ${error instanceof Error || error instanceof DOMException
          ? error.message : 'transaction failed'}`
      );
    }
  }

  async getCard(id: string): Promise<Card | null> {
    // Skip database operations on server-side
    if (!this.checkIsBrowser()) {
      return Promise.resolve(null);
    }

    const startTime = performance.now();

    try {
      const db = await this.getDb();
      const card = await new IndexedDbLocalCardRepository(db).read(id);
      this.recordOperation(performance.now() - startTime);
      return card;
    } catch (error) {
      this.recordError();
      if (error instanceof DBError) throw error;
      throw new DBTransactionError(
        `Failed to get card: ${error instanceof Error || error instanceof DOMException
          ? error.message : 'transaction failed'}`
      );
    }
  }

  // Board identity is the filename. The historical Card index remains keyed by
  // internal ID; exact sources let multiple files share that ID without hiding
  // one another. Pending snapshots take precedence over downloaded sources.
  async getBoardCards(): Promise<BoardLocalEntry[]> {
    if (!this.checkIsBrowser()) return [];
    const db = await this.getDb();
    let cards: BoardLocalCard[] = [];
    let sources: StoredMarkdownSource[] = [];
    let drafts: StoredMarkdownDraft[] = [];
    await runIndexedDbTransaction(db, ['cards', 'markdownDocuments', 'localMarkdownSnapshots'], 'readonly', tx => {
      const cardRequest: IDBRequest<BoardLocalCard[]> = tx.objectStore('cards').getAll();
      const sourceRequest: IDBRequest<StoredMarkdownSource[]> = tx.objectStore('markdownDocuments').getAll();
      const draftRequest: IDBRequest<StoredMarkdownDraft[]> = tx.objectStore('localMarkdownSnapshots').getAll();
      cardRequest.onsuccess = () => { cards = cardRequest.result; };
      sourceRequest.onsuccess = () => { sources = sourceRequest.result; };
      draftRequest.onsuccess = () => { drafts = draftRequest.result; };
    });
    const byFilename = new Map<string, BoardLocalEntry>(cards.map(card => [card.filename ?? card.meta.id, card]));
    const documents = new Map([...sources, ...drafts].map(record => [record.filename, record.source]));
    for (const [filename, source] of documents) {
      const parsed = parseMarkdownDocument(source);
      if (parsed.status !== 'success') {
        const existing = byFilename.get(filename);
        byFilename.set(filename, existing && !('sourceOnly' in existing)
          ? { ...existing, readOnly: true } : { filename, sourceOnly: true });
        continue;
      }
      const card = parsed.document.card;
      // Associate old ID-only projections with their discovered filename, while
      // preserving any actual file whose name equals that ID.
      if (filename !== card.meta.id && !documents.has(card.meta.id) && !byFilename.get(card.meta.id)?.filename) {
        byFilename.delete(card.meta.id);
      }
      byFilename.set(filename, { ...card, ...(filename !== card.meta.id ? { filename } : {}) });
    }
    return [...byFilename.values()];
  }

  async getAllCards(): Promise<BoardLocalCard[]> {
    // Skip database operations on server-side
    if (!this.checkIsBrowser()) {
      return Promise.resolve([]);
    }

    const startTime = performance.now();

    try {
      const db = await this.getDb();
      const cards = await new IndexedDbLocalCardRepository(db).list();
      this.recordOperation(performance.now() - startTime);
      return cards;
    } catch (error) {
      this.recordError();
      if (error instanceof DBError) throw error;
      throw new DBTransactionError(
        `Failed to get all cards: ${error instanceof Error || error instanceof DOMException
          ? error.message : 'transaction failed'}`
      );
    }
  }

  async deleteCard(id: string): Promise<void> {
    // Skip database operations on server-side
    if (!this.checkIsBrowser()) {
      return Promise.resolve();
    }

    const startTime = performance.now();

    try {
      const db = await this.getDb();
      await new IndexedDbLocalCardRepository(db).delete(id);
      this.recordOperation(performance.now() - startTime);
    } catch (error) {
      this.recordError();
      if (error instanceof DBError) throw error;
      throw new DBTransactionError(
        `Failed to delete card: ${error instanceof Error || error instanceof DOMException
          ? error.message : 'transaction failed'}`
      );
    }
  }

  async clearAllData(): Promise<void> {
    // Skip database operations on server-side
    if (!this.checkIsBrowser()) {
      return Promise.resolve();
    }

    const startTime = performance.now();

    try {
      return await this.executeWithRetry(async () => {
        const db = await this.getDb();
        const stores = [this.CARDS_STORE, this.FILES_STORE, this.SYNC_QUEUE_STORE,
          this.MARKDOWN_DOCUMENTS_STORE, this.LOCAL_MARKDOWN_SNAPSHOTS_STORE, this.OUTBOX_STORE];
        const transaction = db.transaction(stores, 'readwrite');

        return new Promise((resolve, reject) => {
          transaction.oncomplete = () => {
            this.recordOperation(performance.now() - startTime);
            resolve();
          };
          transaction.onabort = () => reject(new DBTransactionError(
            `Failed to clear database: ${transaction.error?.message ?? 'transaction aborted'}`
          ));
          for (const store of stores) transaction.objectStore(store).clear();
        });
      });
    } catch (error) {
      this.recordError();
      throw error;
    }
  }
}

// Export singleton instance
export const dbService = new DBService();
