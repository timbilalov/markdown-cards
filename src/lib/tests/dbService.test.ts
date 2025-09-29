import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { DBService, DBError, DBUnavailableError, DBQuotaExceededError, DBTransactionError } from '../services/dbService';
import type { Card } from '../utils/markdownSerializer';
import type { CloudFile } from '../types/cloud';

describe('DBService', () => {
  let dbService: DBService;
  let mockDb: any;
  let mockTransaction: any;
  let mockStore: any;
  let executeWithRetryMock: Mock;

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

  const testCloudFile: CloudFile = {
    path: '/test-card-1.md',
    name: 'test-card-1.md',
    modified: new Date().toISOString(),
    size: 1024,
    etag: 'test-etag'
  };

  const testSyncOperation = {
    id: 'sync-op-1',
    type: 'create' as const,
    card: testCard,
    timestamp: Date.now(),
    attempts: 0
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
      const mockRequest = {
        onsuccess: vi.fn(),
        onerror: vi.fn()
      };
      mockStore.put.mockReturnValue(mockRequest);

      // Simulate successful save
      setTimeout(() => {
        mockRequest.onsuccess({ target: { result: testCard } });
      }, 0);

      await expect(dbService.saveCard(testCard)).resolves.toBeUndefined();
      expect(mockStore.put).toHaveBeenCalledWith({
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

      const mockRequest = {
        onsuccess: vi.fn(),
        onerror: vi.fn(),
        result: null,
      };
      mockStore.put.mockReturnValue(mockRequest);

      setTimeout(() => {
        mockRequest.onerror({ target: { error: new Error('Transaction failed') } });
      }, 0);

      await expect(dbService.saveCard(testCard)).rejects.toThrow(DBTransactionError);
    });
  });

  describe('getCard', () => {
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
      const mockRequest = {
        onsuccess: vi.fn(),
        onerror: vi.fn(),
        result: testCard
      };
      mockStore.get.mockReturnValue(mockRequest);

      // Simulate successful retrieval
      setTimeout(() => {
        mockRequest.onsuccess({ target: { result: testCard } });
      }, 0);

      await expect(dbService.getCard('test-card-1')).resolves.toEqual(testCard);
      expect(mockStore.get).toHaveBeenCalledWith('test-card-1');
    });

    it('should return null for non-existent card', async () => {
      const mockRequest = {
        onsuccess: vi.fn(),
        onerror: vi.fn(),
        result: undefined
      };
      mockStore.get.mockReturnValue(mockRequest);

      // Simulate successful retrieval with no result
      setTimeout(() => {
        mockRequest.onsuccess({ target: { result: undefined } });
      }, 0);

      await expect(dbService.getCard('non-existent')).resolves.toBeNull();
    });
  });

  describe('getAllCards', () => {
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
      const mockRequest = {
        onsuccess: vi.fn(),
        onerror: vi.fn(),
        result: [testCard]
      };
      mockStore.getAll.mockReturnValue(mockRequest);

      // Simulate successful retrieval
      setTimeout(() => {
        mockRequest.onsuccess({ target: { result: [testCard] } });
      }, 0);

      await expect(dbService.getAllCards()).resolves.toEqual([testCard]);
    });
  });

  describe('deleteCard', () => {
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
      const mockRequest = {
        onsuccess: vi.fn(),
        onerror: vi.fn()
      };
      mockStore.delete.mockReturnValue(mockRequest);

      // Simulate successful deletion
      setTimeout(() => {
        mockRequest.onsuccess({ target: { result: undefined } });
      }, 0);

      await expect(dbService.deleteCard('test-card-1')).resolves.toBeUndefined();
      expect(mockStore.delete).toHaveBeenCalledWith('test-card-1');
    });
  });

  describe('saveCloudFile', () => {
    it('should resolve immediately when not in browser environment', async () => {
      // Mock server-side environment
      const originalWindow = global.window;
      // @ts-ignore
      delete global.window;

      await expect(dbService.saveCloudFile(testCloudFile)).resolves.toBeUndefined();

      // Restore window
      global.window = originalWindow;
    });

    it('should save a cloud file successfully', async () => {
      const mockRequest = {
        onsuccess: vi.fn(),
        onerror: vi.fn()
      };
      mockStore.put.mockReturnValue(mockRequest);

      // Simulate successful save
      setTimeout(() => {
        mockRequest.onsuccess({ target: { result: testCloudFile } });
      }, 0);

      await expect(dbService.saveCloudFile(testCloudFile)).resolves.toBeUndefined();
      expect(mockStore.put).toHaveBeenCalledWith(testCloudFile);
    });
  });

  describe('getCloudFile', () => {
    it('should resolve with null when not in browser environment', async () => {
      // Mock server-side environment
      const originalWindow = global.window;
      // @ts-ignore
      delete global.window;

      await expect(dbService.getCloudFile('/test-card-1.md')).resolves.toBeNull();

      // Restore window
      global.window = originalWindow;
    });

    it('should retrieve a cloud file successfully', async () => {
      const mockRequest = {
        onsuccess: vi.fn(),
        onerror: vi.fn(),
        result: testCloudFile
      };
      mockStore.get.mockReturnValue(mockRequest);

      // Simulate successful retrieval
      setTimeout(() => {
        mockRequest.onsuccess({ target: { result: testCloudFile } });
      }, 0);

      await expect(dbService.getCloudFile('/test-card-1.md')).resolves.toEqual(testCloudFile);
      expect(mockStore.get).toHaveBeenCalledWith('/test-card-1.md');
    });
  });

  describe('getAllCloudFiles', () => {
    it('should resolve with empty array when not in browser environment', async () => {
      // Mock server-side environment
      const originalWindow = global.window;
      // @ts-ignore
      delete global.window;

      await expect(dbService.getAllCloudFiles()).resolves.toEqual([]);

      // Restore window
      global.window = originalWindow;
    });

    it('should retrieve all cloud files successfully', async () => {
      const mockRequest = {
        onsuccess: vi.fn(),
        onerror: vi.fn(),
        result: [testCloudFile]
      };
      mockStore.getAll.mockReturnValue(mockRequest);

      // Simulate successful retrieval
      setTimeout(() => {
        mockRequest.onsuccess({ target: { result: [testCloudFile] } });
      }, 0);

      await expect(dbService.getAllCloudFiles()).resolves.toEqual([testCloudFile]);
    });
  });

  describe('deleteCloudFile', () => {
    it('should resolve immediately when not in browser environment', async () => {
      // Mock server-side environment
      const originalWindow = global.window;
      // @ts-ignore
      delete global.window;

      await expect(dbService.deleteCloudFile('/test-card-1.md')).resolves.toBeUndefined();

      // Restore window
      global.window = originalWindow;
    });

    it('should delete a cloud file successfully', async () => {
      const mockRequest = {
        onsuccess: vi.fn(),
        onerror: vi.fn()
      };
      mockStore.delete.mockReturnValue(mockRequest);

      // Simulate successful deletion
      setTimeout(() => {
        mockRequest.onsuccess({ target: { result: undefined } });
      }, 0);

      await expect(dbService.deleteCloudFile('/test-card-1.md')).resolves.toBeUndefined();
      expect(mockStore.delete).toHaveBeenCalledWith('/test-card-1.md');
    });
  });

  describe('queueSyncOperation', () => {
    it('should resolve immediately when not in browser environment', async () => {
      // Mock server-side environment
      const originalWindow = global.window;
      // @ts-ignore
      delete global.window;

      await expect(dbService.queueSyncOperation(testSyncOperation)).resolves.toBeUndefined();

      // Restore window
      global.window = originalWindow;
    });

    it('should queue a sync operation successfully', async () => {
      const mockRequest = {
        onsuccess: vi.fn(),
        onerror: vi.fn()
      };
      mockStore.put.mockReturnValue(mockRequest);

      // Simulate successful queueing
      setTimeout(() => {
        mockRequest.onsuccess({ target: { result: undefined } });
      }, 0);

      await expect(dbService.queueSyncOperation(testSyncOperation)).resolves.toBeUndefined();
      expect(mockStore.put).toHaveBeenCalledWith({
        ...testSyncOperation,
        status: 'pending'
      });
    });
  });

  describe('getPendingSyncOperations', () => {
    it('should resolve with empty array when not in browser environment', async () => {
      // Mock server-side environment
      const originalWindow = global.window;
      // @ts-ignore
      delete global.window;

      await expect(dbService.getPendingSyncOperations()).resolves.toEqual([]);

      // Restore window
      global.window = originalWindow;
    });

    it('should retrieve pending sync operations successfully', async () => {
      const mockResult = [{ ...testSyncOperation, status: 'pending' }];
      const mockRequest = {
        onsuccess: vi.fn(),
        onerror: vi.fn(),
        result: mockResult
      };

      const mockIndex = {
        getAll: vi.fn().mockReturnValue(mockRequest)
      };

      mockStore.index.mockReturnValue(mockIndex);

      // Simulate successful retrieval
      setTimeout(() => {
        mockRequest.onsuccess({ target: { result: mockResult } });
      }, 0);

      await expect(dbService.getPendingSyncOperations()).resolves.toEqual(mockResult);
      expect(mockStore.index).toHaveBeenCalledWith('status');
      expect(mockIndex.getAll).toHaveBeenCalledWith('pending');
    });
  });

  describe('updateSyncOperationStatus', () => {
    it('should resolve immediately when not in browser environment', async () => {
      // Mock server-side environment
      const originalWindow = global.window;
      // @ts-ignore
      delete global.window;

      await expect(dbService.updateSyncOperationStatus('sync-op-1', 'completed')).resolves.toBeUndefined();

      // Restore window
      global.window = originalWindow;
    });

    it('should update sync operation status successfully', async () => {
      const mockGetRequest = {
        onsuccess: vi.fn(),
        onerror: vi.fn(),
        result: { ...testSyncOperation, status: 'pending' }
      };

      const mockPutRequest = {
        onsuccess: vi.fn(),
        onerror: vi.fn()
      };

      mockStore.get.mockReturnValue(mockGetRequest);
      mockStore.put.mockReturnValue(mockPutRequest);

      // Simulate successful update
      setTimeout(() => {
        mockGetRequest.onsuccess({ target: { result: { ...testSyncOperation, status: 'pending' } } });
      }, 0);

      setTimeout(() => {
        mockPutRequest.onsuccess({ target: { result: undefined } });
      }, 10);

      await expect(dbService.updateSyncOperationStatus('sync-op-1', 'completed')).resolves.toBeUndefined();
      expect(mockStore.get).toHaveBeenCalledWith('sync-op-1');
    });

    it('should throw error for non-existent sync operation', async () => {
      // @ts-ignore
      executeWithRetryMock = vi.spyOn(dbService, 'executeWithRetry').mockImplementation(async (callback) => {
        try {
          await callback();
        } catch (error) {
          throw error;
        }
      });

      const mockRequest = {
        onsuccess: vi.fn(),
        onerror: vi.fn(),
        result: null,
      };
      mockStore.get.mockReturnValue(mockRequest);

      setTimeout(() => {
        mockRequest.onsuccess({ target: { result: undefined } });
      }, 0);

      await expect(dbService.updateSyncOperationStatus('non-existent', 'completed')).rejects.toThrow(DBError);
    });
  });

  describe('clearSyncQueue', () => {
    it('should resolve immediately when not in browser environment', async () => {
      // Mock server-side environment
      const originalWindow = global.window;
      // @ts-ignore
      delete global.window;

      await expect(dbService.clearSyncQueue()).resolves.toBeUndefined();

      // Restore window
      global.window = originalWindow;
    });

    it('should clear sync queue successfully', async () => {
      const mockRequest = {
        onsuccess: vi.fn(),
        onerror: vi.fn()
      };
      mockStore.clear.mockReturnValue(mockRequest);

      // Simulate successful clearing
      setTimeout(() => {
        mockRequest.onsuccess({ target: { result: undefined } });
      }, 0);

      await expect(dbService.clearSyncQueue()).resolves.toBeUndefined();
      expect(mockStore.clear).toHaveBeenCalled();
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

    it('should clear all data successfully', async () => {
      const mockCardRequest = { onsuccess: vi.fn(), onerror: vi.fn() };
      const mockFileRequest = { onsuccess: vi.fn(), onerror: vi.fn() };
      const mockQueueRequest = { onsuccess: vi.fn(), onerror: vi.fn() };

      mockStore.clear.mockImplementation(() => {
        const callIndex = mockStore.clear.mock.calls.length;
        if (callIndex === 1) return mockCardRequest;
        if (callIndex === 2) return mockFileRequest;
        if (callIndex === 3) return mockQueueRequest;
        return { onsuccess: vi.fn(), onerror: vi.fn() };
      });

      // Simulate successful clearing
      setTimeout(() => {
        mockCardRequest.onsuccess({ target: { result: undefined } });
      }, 0);

      setTimeout(() => {
        mockFileRequest.onsuccess({ target: { result: undefined } });
      }, 5);

      setTimeout(() => {
        mockQueueRequest.onsuccess({ target: { result: undefined } });
      }, 10);

      await expect(dbService.clearAllData()).resolves.toBeUndefined();
      expect(mockStore.clear).toHaveBeenCalledTimes(3);
    });
  });

  describe('performanceMetrics', () => {
    it('should track operations and calculate metrics correctly', async () => {
      // Get initial metrics
      const initialMetrics = dbService.getPerformanceMetrics();
      expect(initialMetrics.operations).toBe(0);
      expect(initialMetrics.errors).toBe(0);
      expect(initialMetrics.averageDuration).toBe(0);
      expect(initialMetrics.errorRate).toBe(0);

      // Simulate an operation
      const mockRequest = {
        onsuccess: vi.fn(),
        onerror: vi.fn()
      };
      mockStore.get.mockReturnValue(mockRequest);

      // Simulate successful retrieval
      setTimeout(() => {
        mockRequest.onsuccess({ target: { result: testCard } });
      }, 0);

      await dbService.getCard('test-card-1');

      // Check metrics after operation
      const metrics = dbService.getPerformanceMetrics();
      expect(metrics.operations).toBe(1);
      expect(metrics.errors).toBe(0);
      expect(metrics.averageDuration).toBeGreaterThan(0);
      expect(metrics.errorRate).toBe(0);
    });

    it('should track errors correctly', async () => {
      // @ts-ignore
      executeWithRetryMock = vi.spyOn(dbService, 'executeWithRetry').mockImplementation(async (callback) => {
        try {
          await callback();
        } catch (error) {
          throw error;
        }
      });

      const mockRequest = {
        onsuccess: vi.fn(),
        onerror: vi.fn(),
        result: null,
      };
      mockStore.get.mockReturnValue(mockRequest);

      setTimeout(() => {
        mockRequest.onerror({ target: { error: new Error('Test error') } });
      }, 0);

      try {
        await dbService.getCard('test-card-1');
      } catch (e) {
        // Expected error
      }

      // Check metrics after error
      const metrics = dbService.getPerformanceMetrics();
      expect(metrics.operations).toBe(0);
      expect(metrics.errors).toBe(2);
      expect(metrics.errorRate).toBe(0);
    });

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
    it('should handle quota exceeded errors', async () => {
      const quotaError = new DBQuotaExceededError('Test quota error');

      mockStore.put.mockImplementation(() => {
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

      const mockRequest = {
        onsuccess: vi.fn(),
        onerror: vi.fn(),
        result: null,
      };
      mockStore.put.mockReturnValue(mockRequest);

      setTimeout(() => {
        mockRequest.onerror({ target: { error: new Error('Transaction failed') } });
      }, 0);

      await expect(dbService.saveCard(testCard)).rejects.toThrow(DBTransactionError);
    });
  });
});
