import type { Card } from '../types';
import type { CloudFile } from '../types/cloud';

export class DBService {
  private db: IDBDatabase | null = null;
  private readonly DB_NAME = 'MarkdownCardsDB';
  private readonly VERSION = 1;
  private readonly CARDS_STORE = 'cards';
  private readonly FILES_STORE = 'files';

  // Check if we're in a browser environment
  private isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
  }

  async init(): Promise<void> {
    // Skip initialization on server-side
    if (!this.isBrowser()) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.VERSION);

      request.onerror = () => {
        reject(new Error('Failed to open IndexedDB'));
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create cards store
        if (!db.objectStoreNames.contains(this.CARDS_STORE)) {
          const cardStore = db.createObjectStore(this.CARDS_STORE, { keyPath: 'meta.id' });
          cardStore.createIndex('title', 'title', { unique: false });
          cardStore.createIndex('modified', 'meta.modified', { unique: false });
        }

        // Create files store for cloud file metadata
        if (!db.objectStoreNames.contains(this.FILES_STORE)) {
          const fileStore = db.createObjectStore(this.FILES_STORE, { keyPath: 'path' });
          fileStore.createIndex('name', 'name', { unique: false });
          fileStore.createIndex('modified', 'modified', { unique: false });
        }
      };
    });
  }

  private getDb(): IDBDatabase {
    if (!this.isBrowser()) {
      throw new Error('Database operations not available on server-side');
    }
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    return this.db;
  }

  // Card operations
  async saveCard(card: Card): Promise<void> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return Promise.resolve();
    }

    const db = this.getDb();
    const transaction = db.transaction([this.CARDS_STORE], 'readwrite');
    const store = transaction.objectStore(this.CARDS_STORE);

    return new Promise((resolve, reject) => {
      const request = store.put(card);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getCard(id: string): Promise<Card | null> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return Promise.resolve(null);
    }

    const db = this.getDb();
    const transaction = db.transaction([this.CARDS_STORE], 'readonly');
    const store = transaction.objectStore(this.CARDS_STORE);

    return new Promise((resolve, reject) => {
      const request = store.get(id);
      request.onsuccess = () => {
        resolve(request.result || null);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getAllCards(): Promise<Card[]> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return Promise.resolve([]);
    }

    const db = this.getDb();
    const transaction = db.transaction([this.CARDS_STORE], 'readonly');
    const store = transaction.objectStore(this.CARDS_STORE);

    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async deleteCard(id: string): Promise<void> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return Promise.resolve();
    }

    const db = this.getDb();
    const transaction = db.transaction([this.CARDS_STORE], 'readwrite');
    const store = transaction.objectStore(this.CARDS_STORE);

    return new Promise((resolve, reject) => {
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // Cloud file operations
  async saveCloudFile(file: CloudFile): Promise<void> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return Promise.resolve();
    }

    const db = this.getDb();
    const transaction = db.transaction([this.FILES_STORE], 'readwrite');
    const store = transaction.objectStore(this.FILES_STORE);

    return new Promise((resolve, reject) => {
      const request = store.put(file);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getCloudFile(path: string): Promise<CloudFile | null> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return Promise.resolve(null);
    }

    const db = this.getDb();
    const transaction = db.transaction([this.FILES_STORE], 'readonly');
    const store = transaction.objectStore(this.FILES_STORE);

    return new Promise((resolve, reject) => {
      const request = store.get(path);
      request.onsuccess = () => {
        resolve(request.result || null);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getAllCloudFiles(): Promise<CloudFile[]> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return Promise.resolve([]);
    }

    const db = this.getDb();
    const transaction = db.transaction([this.FILES_STORE], 'readonly');
    const store = transaction.objectStore(this.FILES_STORE);

    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async deleteCloudFile(path: string): Promise<void> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return Promise.resolve();
    }

    const db = this.getDb();
    const transaction = db.transaction([this.FILES_STORE], 'readwrite');
    const store = transaction.objectStore(this.FILES_STORE);

    return new Promise((resolve, reject) => {
      const request = store.delete(path);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async clearAllData(): Promise<void> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return Promise.resolve();
    }

    const db = this.getDb();
    const transaction = db.transaction([this.CARDS_STORE, this.FILES_STORE], 'readwrite');
    const cardStore = transaction.objectStore(this.CARDS_STORE);
    const fileStore = transaction.objectStore(this.FILES_STORE);

    return new Promise((resolve, reject) => {
      const cardRequest = cardStore.clear();
      const fileRequest = fileStore.clear();

      cardRequest.onsuccess = () => {
        fileRequest.onsuccess = () => resolve();
        fileRequest.onerror = () => reject(fileRequest.error);
      };

      cardRequest.onerror = () => reject(cardRequest.error);
    });
  }
}

// Export singleton instance
export const dbService = new DBService();
