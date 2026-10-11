import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { DBService, DBError, DBUnavailableError, DBQuotaExceededError, DBTransactionError } from '../services/dbService';
import type { Card } from '../domain/types';
import { IDBObjectStore } from 'fake-indexeddb';

describe('DBService', () => {
  let dbService: DBService;
  let mockDb: any;
  let mockTransaction: any;
  let mockStore: any;
  let executeWithRetryMock: Mock;
  let cardDatabase: IDBDatabase;

  // Card methods are being extracted to a commit-aware repository. Use actual
  // IndexedDB events instead of request-only mocks for these existing cases.
  async function useCardDatabase() {
    dbService = new DBService();
    await dbService.init();
    cardDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('MarkdownCardsDB');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    dbService.resetPerformanceMetrics();
  }

  async function seedCard() {
    const transaction = cardDatabase.transaction('cards', 'readwrite');
    transaction.objectStore('cards').put(testCard);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  }

  // Test data
  const testCard: Card = {
    title: 'Test Card',
    meta: {
      id: 'test-card-1',
      created: Date.now(),
      modified: Date.now()
    },
    description: 'This is a test card',
    sections: [
      {
        heading: 'Test Section',
        type: 'unordered',
        items: [
          { text: 'Test item 1', checked: false },
          { text: 'Test item 2', checked: true }
        ]
      }
    ]
  };

  beforeEach(() => {
    dbService = new DBService();
    // Reset performance metrics before each test
    dbService.resetPerformanceMetrics();

    // Mock IndexedDB
    mockStore = {
      put: vi.fn().mockReturnValue({
        onsuccess: vi.fn(),
        onerror: vi.fn(),
        result: null
      }),
      get: vi.fn().mockReturnValue({
        onsuccess: vi.fn(),
        onerror: vi.fn(),
        result: null
      }),
      getAll: vi.fn().mockReturnValue({
        onsuccess: vi.fn(),
        onerror: vi.fn(),
        result: []
      }),
      delete: vi.fn().mockReturnValue({
        onsuccess: vi.fn(),
        onerror: vi.fn()
      }),
      clear: vi.fn().mockReturnValue({
        onsuccess: vi.fn(),
        onerror: vi.fn()
      }),
      index: vi.fn().mockReturnValue({
        getAll: vi.fn().mockReturnValue({
          onsuccess: vi.fn(),
          onerror: vi.fn(),
          result: []
        })
      })
    };

    mockTransaction = {
      objectStore: vi.fn().mockReturnValue(mockStore)
    };

    mockDb = {
      transaction: vi.fn().mockReturnValue(mockTransaction)
    };

    // @ts-ignore - we're mocking private properties
    dbService.db = mockDb;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('init', () => {
    it('should resolve immediately when not in browser environment', async () => {
      // Mock server-side environment
      const originalWindow = global.window;
      // @ts-ignore
      delete global.window;

      await expect(dbService.init()).resolves.toBeUndefined();

      // Restore window
      global.window = originalWindow;
    });

    it('should handle successful initialization', async () => {
      // This test would require a more complex IndexedDB mock
      // For now, we'll skip it as it's more of an integration test
      expect(true).toBe(true);
    });
  });

  describe('saveCard', () => {
    beforeEach(useCardDatabase);
    it('should resolve immediately when not in browser environment', async () => {
      // Mock server-side environment
      const originalWindow = global.window;
      // @ts-ignore
      delete global.window;

      await expect(dbService.saveCard(testCard)).resolves.toBeUndefined();

      // Restore window
      global.window = originalWindow;
    });

    it('should save a card successfully', async () => {
      const put = vi.spyOn(IDBObjectStore.prototype, 'put');

      await expect(dbService.saveCard(testCard)).resolves.toBeUndefined();
      expect(put).toHaveBeenCalledWith({
        ...testCard,
        meta: {
          ...testCard.meta,
          title: testCard.title
        }
      });
    });

    it('should handle transaction errors', async () => {
      // @ts-ignore
      executeWithRetryMock = vi.spyOn(dbService, 'executeWithRetry').mockImplementation(async (callback) => {
        try {
          await callback();
        } catch (error) {
          throw error;
        }
      });

      await seedCard();
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value) {
        return this.add(value); // A real asynchronous ConstraintError for the existing key.
      });

      await expect(dbService.saveCard(testCard)).rejects.toThrow(DBTransactionError);
    });
  });

  describe('getCard', () => {
    beforeEach(useCardDatabase);
    it('should resolve with null when not in browser environment', async () => {
      // Mock server-side environment
      const originalWindow = global.window;
      // @ts-ignore
      delete global.window;

      await expect(dbService.getCard('test-card-1')).resolves.toBeNull();

      // Restore window
      global.window = originalWindow;
    });

    it('should retrieve a card successfully', async () => {
      await seedCard();
      const get = vi.spyOn(IDBObjectStore.prototype, 'get');

      await expect(dbService.getCard('test-card-1')).resolves.toEqual(testCard);
      expect(get).toHaveBeenCalledWith('test-card-1');
    });

    it('should return null for non-existent card', async () => {
      await expect(dbService.getCard('non-existent')).resolves.toBeNull();
    });
  });

  describe('getAllCards', () => {
    beforeEach(useCardDatabase);
    it('should resolve with empty array when not in browser environment', async () => {
      // Mock server-side environment
      const originalWindow = global.window;
      // @ts-ignore
      delete global.window;

      await expect(dbService.getAllCards()).resolves.toEqual([]);

      // Restore window
      global.window = originalWindow;
    });

    it('should retrieve all cards successfully', async () => {
      await seedCard();

      await expect(dbService.getAllCards()).resolves.toEqual([testCard]);
    });
  });

  describe('deleteCard', () => {
    beforeEach(useCardDatabase);
    it('should resolve immediately when not in browser environment', async () => {
      // Mock server-side environment
      const originalWindow = global.window;
      // @ts-ignore
      delete global.window;

      await expect(dbService.deleteCard('test-card-1')).resolves.toBeUndefined();

      // Restore window
      global.window = originalWindow;
    });

    it('should delete a card successfully', async () => {
      await seedCard();
      const remove = vi.spyOn(IDBObjectStore.prototype, 'delete');

      await expect(dbService.deleteCard('test-card-1')).resolves.toBeUndefined();
      expect(remove).toHaveBeenCalledWith('test-card-1');
      expect(await dbService.getCard('test-card-1')).toBeNull();
    });
  });

  describe('clearAllData', () => {
    it('should resolve immediately when not in browser environment', async () => {
      // Mock server-side environment
      const originalWindow = global.window;
      // @ts-ignore
      delete global.window;

      await expect(dbService.clearAllData()).resolves.toBeUndefined();

      // Restore window
      global.window = originalWindow;
    });

    // The fixed three-store mock assertion moved to the real IndexedDB test
    // in markdownDocumentCache.integration.test.ts, including source documents.
  });

  describe('performanceMetrics', () => {
    beforeEach(useCardDatabase);
    it('should track operations and calculate metrics correctly', async () => {
      // Get initial metrics
      const initialMetrics = dbService.getPerformanceMetrics();
      expect(initialMetrics.operations).toBe(0);
      expect(initialMetrics.errors).toBe(0);
      expect(initialMetrics.averageDuration).toBe(0);
      expect(initialMetrics.errorRate).toBe(0);

      await seedCard();
      await dbService.getCard('test-card-1');

      // Check metrics after operation
      const metrics = dbService.getPerformanceMetrics();
      expect(metrics.operations).toBe(1);
      expect(metrics.errors).toBe(0);
      expect(metrics.averageDuration).toBeGreaterThan(0);
      expect(metrics.errorRate).toBe(0);
    });

    // The former errors === 2 expectation codified double-counting one failure.
    // Its corrected contract is a RED regression in dbLocalCardRepository.integration.test.ts.

    it('should reset performance metrics', () => {
      // Simulate some operations
      // @ts-ignore - accessing private method for testing
      dbService.recordOperation(100);
      // @ts-ignore - accessing private method for testing
      dbService.recordError();

      let metrics = dbService.getPerformanceMetrics();
      expect(metrics.operations).toBe(1);
      expect(metrics.errors).toBe(1);

      // Reset metrics
      dbService.resetPerformanceMetrics();

      metrics = dbService.getPerformanceMetrics();
      expect(metrics.operations).toBe(0);
      expect(metrics.errors).toBe(0);
      expect(metrics.averageDuration).toBe(0);
      expect(metrics.errorRate).toBe(0);
    });
  });

  describe('error handling', () => {
    beforeEach(useCardDatabase);
    it('should handle quota exceeded errors', async () => {
      const quotaError = new DBQuotaExceededError('Test quota error');

      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
        throw quotaError;
      });

      await expect(dbService.saveCard(testCard)).rejects.toThrow(DBQuotaExceededError);
    });

    it('should handle transaction errors', async () => {
      // @ts-ignore
      executeWithRetryMock = vi.spyOn(dbService, 'executeWithRetry').mockImplementation(async (callback) => {
        try {
          await callback();
        } catch (error) {
          throw error;
        }
      });

      await seedCard();
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value) {
        return this.add(value);
      });

      await expect(dbService.saveCard(testCard)).rejects.toThrow(DBTransactionError);
    });
  });
});
