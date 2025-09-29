import type { Card } from '../utils/markdownSerializer';
import type { CloudFile } from '../types/cloud';

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
  private readonly DB_NAME = 'MarkdownCardsDB';
  private readonly VERSION = 2; // Updated version for schema changes
  private readonly CARDS_STORE = 'cards';
  private readonly FILES_STORE = 'files';
  private readonly SYNC_QUEUE_STORE = 'syncQueue'; // New store for offline operations

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
  private isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
  }

  async init(): Promise<void> {
    // Skip initialization on server-side
    if (!this.isBrowser()) {
      return Promise.resolve();
    }

    const startTime = performance.now();

    try {
      const request = indexedDB.open(this.DB_NAME, this.VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

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

        // Create sync queue store for offline operations
        if (!db.objectStoreNames.contains(this.SYNC_QUEUE_STORE)) {
          const queueStore = db.createObjectStore(this.SYNC_QUEUE_STORE, { keyPath: 'id' });
          queueStore.createIndex('timestamp', 'timestamp', { unique: false });
          queueStore.createIndex('status', 'status', { unique: false });
        }
      };

      return new Promise((resolve, reject) => {
        request.onsuccess = () => {
          this.db = request.result;
          this.recordOperation(performance.now() - startTime);
          resolve();
        };

        request.onerror = () => {
          this.recordError();
          reject(new DBError('Failed to open IndexedDB', 'OPEN_FAILED'));
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
    if (!this.isBrowser()) {
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

  // Card operations
  async saveCard(card: Card): Promise<void> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return Promise.resolve();
    }

    const startTime = performance.now();

    try {
      return await this.executeWithRetry(async () => {
        const db = await this.getDb();
        const transaction = db.transaction([this.CARDS_STORE], 'readwrite');
        const store = transaction.objectStore(this.CARDS_STORE);

        return new Promise((resolve, reject) => {
          const request = store.put({
            ...card,
            meta: {
              ...card.meta,
              title: card.title // Store title in meta for indexing
            }
          });

          request.onsuccess = () => {
            this.recordOperation(performance.now() - startTime);
            resolve();
          };

          request.onerror = () => {
            this.recordError();
            reject(new DBTransactionError(`Failed to save card: ${request.error?.message}`));
          };
        });
      });
    } catch (error) {
      this.recordError();
      throw error;
    }
  }

  async getCard(id: string): Promise<Card | null> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return Promise.resolve(null);
    }

    const startTime = performance.now();

    try {
      return await this.executeWithRetry(async () => {
        const db = await this.getDb();
        const transaction = db.transaction([this.CARDS_STORE], 'readonly');
        const store = transaction.objectStore(this.CARDS_STORE);

        return new Promise((resolve, reject) => {
          const request = store.get(id);
          request.onsuccess = () => {
            this.recordOperation(performance.now() - startTime);
            resolve(request.result || null);
          };
          request.onerror = () => {
            this.recordError();
            reject(new DBTransactionError(`Failed to get card: ${request.error?.message}`));
          };
        });
      });
    } catch (error) {
      this.recordError();
      throw error;
    }
  }

  async getAllCards(): Promise<Card[]> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return Promise.resolve([]);
    }

    const startTime = performance.now();

    try {
      return await this.executeWithRetry(async () => {
        const db = await this.getDb();
        const transaction = db.transaction([this.CARDS_STORE], 'readonly');
        const store = transaction.objectStore(this.CARDS_STORE);

        return new Promise((resolve, reject) => {
          const request = store.getAll();
          request.onsuccess = () => {
            this.recordOperation(performance.now() - startTime);
            resolve(request.result);
          };
          request.onerror = () => {
            this.recordError();
            reject(new DBTransactionError(`Failed to get all cards: ${request.error?.message}`));
          };
        });
      });
    } catch (error) {
      this.recordError();
      throw error;
    }
  }

  async deleteCard(id: string): Promise<void> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return Promise.resolve();
    }

    const startTime = performance.now();

    try {
      return await this.executeWithRetry(async () => {
        const db = await this.getDb();
        const transaction = db.transaction([this.CARDS_STORE], 'readwrite');
        const store = transaction.objectStore(this.CARDS_STORE);

        return new Promise((resolve, reject) => {
          const request = store.delete(id);
          request.onsuccess = () => {
            this.recordOperation(performance.now() - startTime);
            resolve();
          };
          request.onerror = () => {
            this.recordError();
            reject(new DBTransactionError(`Failed to delete card: ${request.error?.message}`));
          };
        });
      });
    } catch (error) {
      this.recordError();
      throw error;
    }
  }

  // Cloud file operations
  async saveCloudFile(file: CloudFile): Promise<void> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return Promise.resolve();
    }

    const startTime = performance.now();

    try {
      return await this.executeWithRetry(async () => {
        const db = await this.getDb();
        const transaction = db.transaction([this.FILES_STORE], 'readwrite');
        const store = transaction.objectStore(this.FILES_STORE);

        return new Promise((resolve, reject) => {
          const request = store.put(file);
          request.onsuccess = () => {
            this.recordOperation(performance.now() - startTime);
            resolve();
          };
          request.onerror = () => {
            this.recordError();
            reject(new DBTransactionError(`Failed to save cloud file: ${request.error?.message}`));
          };
        });
      });
    } catch (error) {
      this.recordError();
      throw error;
    }
  }

  async getCloudFile(path: string): Promise<CloudFile | null> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return Promise.resolve(null);
    }

    const startTime = performance.now();

    try {
      return await this.executeWithRetry(async () => {
        const db = await this.getDb();
        const transaction = db.transaction([this.FILES_STORE], 'readonly');
        const store = transaction.objectStore(this.FILES_STORE);

        return new Promise((resolve, reject) => {
          const request = store.get(path);
          request.onsuccess = () => {
            this.recordOperation(performance.now() - startTime);
            resolve(request.result || null);
          };
          request.onerror = () => {
            this.recordError();
            reject(new DBTransactionError(`Failed to get cloud file: ${request.error?.message}`));
          };
        });
      });
    } catch (error) {
      this.recordError();
      throw error;
    }
  }

  async getAllCloudFiles(): Promise<CloudFile[]> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return Promise.resolve([]);
    }

    const startTime = performance.now();

    try {
      return await this.executeWithRetry(async () => {
        const db = await this.getDb();
        const transaction = db.transaction([this.FILES_STORE], 'readonly');
        const store = transaction.objectStore(this.FILES_STORE);

        return new Promise((resolve, reject) => {
          const request = store.getAll();
          request.onsuccess = () => {
            this.recordOperation(performance.now() - startTime);
            resolve(request.result);
          };
          request.onerror = () => {
            this.recordError();
            reject(new DBTransactionError(`Failed to get all cloud files: ${request.error?.message}`));
          };
        });
      });
    } catch (error) {
      this.recordError();
      throw error;
    }
  }

  async deleteCloudFile(path: string): Promise<void> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return Promise.resolve();
    }

    const startTime = performance.now();

    try {
      return await this.executeWithRetry(async () => {
        const db = await this.getDb();
        const transaction = db.transaction([this.FILES_STORE], 'readwrite');
        const store = transaction.objectStore(this.FILES_STORE);

        return new Promise((resolve, reject) => {
          const request = store.delete(path);
          request.onsuccess = () => {
            this.recordOperation(performance.now() - startTime);
            resolve();
          };
          request.onerror = () => {
            this.recordError();
            reject(new DBTransactionError(`Failed to delete cloud file: ${request.error?.message}`));
          };
        });
      });
    } catch (error) {
      this.recordError();
      throw error;
    }
  }

  // Sync queue operations for offline support
  async queueSyncOperation(operation: {
    id: string;
    type: 'create' | 'update' | 'delete';
    card?: Card;
    path?: string;
    timestamp: number;
    attempts: number;
  }): Promise<void> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return Promise.resolve();
    }

    const startTime = performance.now();

    try {
      return await this.executeWithRetry(async () => {
        const db = await this.getDb();
        const transaction = db.transaction([this.SYNC_QUEUE_STORE], 'readwrite');
        const store = transaction.objectStore(this.SYNC_QUEUE_STORE);

        return new Promise((resolve, reject) => {
          const request = store.put({
            ...operation,
            status: 'pending'
          });
          request.onsuccess = () => {
            this.recordOperation(performance.now() - startTime);
            resolve();
          };
          request.onerror = () => {
            this.recordError();
            reject(new DBTransactionError(`Failed to queue sync operation: ${request.error?.message}`));
          };
        });
      });
    } catch (error) {
      this.recordError();
      throw error;
    }
  }

  async getPendingSyncOperations(): Promise<Array<{
    id: string;
    type: 'create' | 'update' | 'delete';
    card?: Card;
    path?: string;
    timestamp: number;
    attempts: number;
    status: string;
  }>> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return Promise.resolve([]);
    }

    const startTime = performance.now();

    try {
      return await this.executeWithRetry(async () => {
        const db = await this.getDb();
        const transaction = db.transaction([this.SYNC_QUEUE_STORE], 'readonly');
        const store = transaction.objectStore(this.SYNC_QUEUE_STORE);
        const index = store.index('status');

        return new Promise((resolve, reject) => {
          const request = index.getAll('pending');
          request.onsuccess = () => {
            this.recordOperation(performance.now() - startTime);
            resolve(request.result);
          };
          request.onerror = () => {
            this.recordError();
            reject(new DBTransactionError(`Failed to get pending sync operations: ${request.error?.message}`));
          };
        });
      });
    } catch (error) {
      this.recordError();
      throw error;
    }
  }

  async updateSyncOperationStatus(id: string, status: string): Promise<void> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return Promise.resolve();
    }

    const startTime = performance.now();

    try {
      return await this.executeWithRetry(async () => {
        const db = await this.getDb();
        const transaction = db.transaction([this.SYNC_QUEUE_STORE], 'readwrite');
        const store = transaction.objectStore(this.SYNC_QUEUE_STORE);

        return new Promise((resolve, reject) => {
          const getRequest = store.get(id);
          getRequest.onsuccess = () => {
            const operation = getRequest.result;
            if (operation) {
              operation.status = status;
              operation.attempts = (operation.attempts || 0) + 1;

              const putRequest = store.put(operation);
              putRequest.onsuccess = () => {
                this.recordOperation(performance.now() - startTime);
                resolve();
              };
              putRequest.onerror = () => {
                this.recordError();
                reject(new DBTransactionError(`Failed to update sync operation status: ${putRequest.error?.message}`));
              };
            } else {
              this.recordError();
              reject(new DBError('Sync operation not found', 'NOT_FOUND'));
            }
          };
          getRequest.onerror = () => {
            this.recordError();
            reject(new DBTransactionError(`Failed to get sync operation: ${getRequest.error?.message}`));
          };
        });
      });
    } catch (error) {
      this.recordError();
      throw error;
    }
  }

  async clearSyncQueue(): Promise<void> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return Promise.resolve();
    }

    const startTime = performance.now();

    try {
      return await this.executeWithRetry(async () => {
        const db = await this.getDb();
        const transaction = db.transaction([this.SYNC_QUEUE_STORE], 'readwrite');
        const store = transaction.objectStore(this.SYNC_QUEUE_STORE);

        return new Promise((resolve, reject) => {
          const request = store.clear();
          request.onsuccess = () => {
            this.recordOperation(performance.now() - startTime);
            resolve();
          };
          request.onerror = () => {
            this.recordError();
            reject(new DBTransactionError(`Failed to clear sync queue: ${request.error?.message}`));
          };
        });
      });
    } catch (error) {
      this.recordError();
      throw error;
    }
  }

  async clearAllData(): Promise<void> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return Promise.resolve();
    }

    const startTime = performance.now();

    try {
      return await this.executeWithRetry(async () => {
        const db = await this.getDb();
        const transaction = db.transaction([this.CARDS_STORE, this.FILES_STORE, this.SYNC_QUEUE_STORE], 'readwrite');
        const cardStore = transaction.objectStore(this.CARDS_STORE);
        const fileStore = transaction.objectStore(this.FILES_STORE);
        const queueStore = transaction.objectStore(this.SYNC_QUEUE_STORE);

        return new Promise((resolve, reject) => {
          const cardRequest = cardStore.clear();
          const fileRequest = fileStore.clear();
          const queueRequest = queueStore.clear();

          let completed = 0;
          const checkCompletion = () => {
            completed++;
            if (completed === 3) {
              this.recordOperation(performance.now() - startTime);
              resolve();
            }
          };

          cardRequest.onsuccess = checkCompletion;
          fileRequest.onsuccess = checkCompletion;
          queueRequest.onsuccess = checkCompletion;

          cardRequest.onerror = () => {
            this.recordError();
            reject(new DBTransactionError(`Failed to clear cards: ${cardRequest.error?.message}`));
          };

          fileRequest.onerror = () => {
            this.recordError();
            reject(new DBTransactionError(`Failed to clear files: ${fileRequest.error?.message}`));
          };

          queueRequest.onerror = () => {
            this.recordError();
            reject(new DBTransactionError(`Failed to clear queue: ${queueRequest.error?.message}`));
          };
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
