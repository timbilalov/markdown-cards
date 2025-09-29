# Offline Mode Support with Queued Syncs Upon Reconnection

## Overview
This document details the implementation approach for adding comprehensive offline mode support with queued synchronization operations that automatically process when connectivity is restored. The implementation will ensure full application functionality during offline periods while maintaining data consistency when reconnected.

## Current Implementation Analysis
The current application has limited offline support:
1. Basic IndexedDB caching for offline access
2. Simple online/offline detection
3. No queued synchronization operations
4. No offline state management
5. No user feedback about offline mode

However, there are several areas for improvement:
- No persistent offline operation queue
- No automatic sync when reconnected
- No offline state tracking
- No conflict handling for offline changes
- No user notifications about offline status

## Enhanced Implementation Plan

### 1. Offline State Management
Implement comprehensive offline state tracking:
1. Network connectivity detection
2. Cloud service availability monitoring
3. Offline state persistence
4. State change notifications

### 2. Offline Operation Queue
Implement persistent operation queuing:
1. Operation serialization and storage
2. Queue persistence in IndexedDB
3. Operation prioritization
4. Duplicate operation prevention

### 3. Automatic Sync on Reconnection
Implement automatic synchronization when connectivity is restored:
1. Network change detection
2. Queue processing automation
3. Conflict resolution for offline changes
4. Progress tracking and user feedback

### 4. Offline User Experience
Implement comprehensive offline user experience:
1. Visual offline indicators
2. Offline capability notifications
3. Operation status feedback
4. Conflict resolution UI

## Implementation Steps

### Step 1: Create Offline Management Utilities
Create utility functions for offline management:

```typescript
// src/lib/utils/offlineManager.ts
import { dbService } from '../services/dbService';
import { performanceMonitor } from './performanceMonitor';

export interface OfflineOperation {
  id: string;
  type: 'saveCard' | 'deleteCard' | 'saveFile' | 'deleteFile';
  payload: any;
  timestamp: number;
  attempts: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error?: string;
  priority: 'high' | 'normal' | 'low';
}

export interface OfflineStatus {
  isOffline: boolean;
  offlineSince?: number;
  queuedOperations: number;
  lastSyncAttempt?: number;
  syncError?: string;
}

export class OfflineManager {
  private isOffline = false;
  private offlineSince: number | null = null;
  private syncInterval: number | null = null;
  private readonly QUEUE_STORE = 'offlineQueue';
  private readonly STATUS_STORE = 'offlineStatus';
  private isProcessingQueue = false;
  private networkListeners: Array<() => void> = [];

  constructor() {
    // Initialize when browser is available
    if (typeof window !== 'undefined') {
      this.initializeNetworkListeners();
    }
  }

  // Initialize network listeners
  private initializeNetworkListeners() {
    // Listen for online/offline events
    window.addEventListener('online', () => {
      this.handleOnline();
    });

    window.addEventListener('offline', () => {
      this.handleOffline();
    });

    // Check initial network status
    this.checkNetworkStatus();
  }

  // Check current network status
  private checkNetworkStatus() {
    if (typeof navigator !== 'undefined') {
      this.setOfflineStatus(!navigator.onLine);
    }
  }

  // Handle going online
  private async handleOnline() {
    console.log('Network status: Online');
    this.setOfflineStatus(false);

    // Process queue when coming online
    await this.processQueue();

    // Notify listeners
    this.notifyNetworkListeners();
  }

  // Handle going offline
  private handleOffline() {
    console.log('Network status: Offline');
    this.setOfflineStatus(true);

    // Notify listeners
    this.notifyNetworkListeners();
  }

  // Set offline status
  private setOfflineStatus(isOffline: boolean) {
    const wasOffline = this.isOffline;
    this.isOffline = isOffline;

    if (isOffline && !wasOffline) {
      this.offlineSince = Date.now();
    } else if (!isOffline && wasOffline) {
      this.offlineSince = null;
    }

    // Save status to IndexedDB
    this.saveOfflineStatus();
  }

  // Save offline status to IndexedDB
  private async saveOfflineStatus() {
    try {
      const status = this.getOfflineStatus();
      // We would save this to IndexedDB for persistence
      // Implementation would depend on how we want to store app state
    } catch (error) {
      console.error('Error saving offline status:', error);
    }
  }

  // Get current offline status
  getOfflineStatus(): OfflineStatus {
    return {
      isOffline: this.isOffline,
      offlineSince: this.offlineSince || undefined,
      queuedOperations: 0, // We'll implement queue counting later
      lastSyncAttempt: undefined,
      syncError: undefined
    };
  }

  // Add network listener
  addNetworkListener(callback: () => void) {
    this.networkListeners.push(callback);
  }

  // Remove network listener
  removeNetworkListener(callback: () => void) {
    this.networkListeners = this.networkListeners.filter(listener => listener !== callback);
  }

  // Notify network listeners
  private notifyNetworkListeners() {
    this.networkListeners.forEach(callback => {
      try {
        callback();
      } catch (error) {
        console.error('Error in network listener:', error);
      }
    });
  }

  // Add operation to offline queue
  async queueOperation(operation: Omit<OfflineOperation, 'id' | 'timestamp' | 'attempts' | 'status'>): Promise<string> {
    const perfId = performanceMonitor.start('queue-offline-operation', 'sync', {
      type: operation.type
    });

    try {
      const offlineOp: OfflineOperation = {
        id: this.generateOperationId(),
        type: operation.type,
        payload: operation.payload,
        timestamp: Date.now(),
        attempts: 0,
        status: 'pending',
        priority: operation.priority || 'normal'
      };

      // Save to IndexedDB
      await this.saveOperationToQueue(offlineOp);

      performanceMonitor.stop(perfId, true);
      return offlineOp.id;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      performanceMonitor.stop(perfId, false, errorMessage);
      throw error;
    }
  }

  // Generate unique operation ID
  private generateOperationId(): string {
    return `op-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  // Save operation to queue in IndexedDB
  private async saveOperationToQueue(operation: OfflineOperation): Promise<void> {
    // This would require extending the DBService to support offline queue operations
    // For now, we'll implement a simple in-memory queue that gets persisted periodically
    console.log('Queueing operation:', operation);
  }

  // Process offline queue
  async processQueue(): Promise<void> {
    if (this.isProcessingQueue) {
      console.log('Queue processing already in progress');
      return;
    }

    if (this.isOffline) {
      console.log('Cannot process queue while offline');
      return;
    }

    this.isProcessingQueue = true;
    const perfId = performanceMonitor.start('process-offline-queue', 'sync');

    try {
      // Get pending operations from queue
      const operations = await this.getPendingOperations();

      if (operations.length === 0) {
        performanceMonitor.stop(perfId, true);
        this.isProcessingQueue = false;
        return;
      }

      console.log(`Processing ${operations.length} queued operations`);

      // Process operations in order of priority and timestamp
      const sortedOperations = operations.sort((a, b) => {
        // Higher priority first
        const priorityOrder = { high: 0, normal: 1, low: 2 };
        if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
          return priorityOrder[a.priority] - priorityOrder[b.priority];
        }
        // Older operations first
        return a.timestamp - b.timestamp;
      });

      let processed = 0;
      let failed = 0;

      for (const operation of sortedOperations) {
        try {
          await this.processOperation(operation);
          processed++;
        } catch (error) {
          console.error(`Error processing operation ${operation.id}:`, error);
          failed++;

          // Update operation status
          await this.updateOperationStatus(operation.id, 'failed', error instanceof Error ? error.message : 'Unknown error');
        }
      }

      console.log(`Queue processing complete: ${processed} processed, ${failed} failed`);
      performanceMonitor.stop(perfId, true, undefined, {
        processed,
        failed,
        total: operations.length
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      performanceMonitor.stop(perfId, false, errorMessage);
      console.error('Error processing offline queue:', error);
    } finally {
      this.isProcessingQueue = false;
    }
  }

  // Get pending operations from queue
  private async getPendingOperations(): Promise<OfflineOperation[]> {
    // This would retrieve operations from IndexedDB
    // For now, returning empty array as we need to implement the storage first
    return [];
  }

  // Process a single operation
  private async processOperation(operation: OfflineOperation): Promise<void> {
    const perfId = performanceMonitor.start(`process-${operation.type}`, 'sync', {
      operationId: operation.id
    });

    try {
      // Update operation status to processing
      await this.updateOperationStatus(operation.id, 'processing');

      // Process based on operation type
      switch (operation.type) {
        case 'saveCard':
          await this.processSaveCard(operation);
          break;
        case 'deleteCard':
          await this.processDeleteCard(operation);
          break;
        case 'saveFile':
          await this.processSaveFile(operation);
          break;
        case 'deleteFile':
          await this.processDeleteFile(operation);
          break;
        default:
          throw new Error(`Unknown operation type: ${operation.type}`);
      }

      // Mark operation as completed
      await this.updateOperationStatus(operation.id, 'completed');
      performanceMonitor.stop(perfId, true);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.updateOperationStatus(operation.id, 'failed', errorMessage);
      performanceMonitor.stop(perfId, false, errorMessage);
      throw error;
    }
  }

  // Process save card operation
  private async processSaveCard(operation: OfflineOperation): Promise<void> {
    // This would integrate with the existing card saving logic
    // For now, just logging the operation
    console.log('Processing save card operation:', operation.payload);

    // In a real implementation, this would:
    // 1. Retrieve the card data from the payload
    // 2. Save to cloud service
    // 3. Update local cache if needed
    // 4. Handle any conflicts
  }

  // Process delete card operation
  private async processDeleteCard(operation: OfflineOperation): Promise<void> {
    console.log('Processing delete card operation:', operation.payload);

    // In a real implementation, this would:
    // 1. Delete from cloud service
    // 2. Remove from local cache
  }

  // Process save file operation
  private async processSaveFile(operation: OfflineOperation): Promise<void> {
    console.log('Processing save file operation:', operation.payload);

    // In a real implementation, this would:
    // 1. Save file to cloud service
    // 2. Update file metadata in local cache
  }

  // Process delete file operation
  private async processDeleteFile(operation: OfflineOperation): Promise<void> {
    console.log('Processing delete file operation:', operation.payload);

    // In a real implementation, this would:
    // 1. Delete file from cloud service
    // 2. Remove file metadata from local cache
  }

  // Update operation status
  private async updateOperationStatus(id: string, status: OfflineOperation['status'], error?: string): Promise<void> {
    // This would update the operation status in IndexedDB
    console.log(`Updating operation ${id} status to ${status}`, error);
  }

  // Clear completed operations from queue
  async clearCompletedOperations(): Promise<number> {
    // This would remove completed operations from IndexedDB
    console.log('Clearing completed operations from queue');
    return 0;
  }

  // Retry failed operations
  async retryFailedOperations(): Promise<void> {
    // This would reset failed operations to pending status
    console.log('Retrying failed operations');
  }

  // Get queue statistics
  async getQueueStats(): Promise<{
    total: number;
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    oldestPending?: number;
  }> {
    const operations = await this.getPendingOperations();

    const stats = {
      total: operations.length,
      pending: operations.filter(op => op.status === 'pending').length,
      processing: operations.filter(op => op.status === 'processing').length,
      completed: operations.filter(op => op.status === 'completed').length,
      failed: operations.filter(op => op.status === 'failed').length
    };

    // Find oldest pending operation
    const pendingOps = operations.filter(op => op.status === 'pending');
    if (pendingOps.length > 0) {
      const oldest = pendingOps.reduce((oldest, op) =>
        op.timestamp < oldest.timestamp ? op : oldest, pendingOps[0]);
      stats.oldestPending = oldest.timestamp;
    }

    return stats;
  }
}

// Export singleton instance
export const offlineManager = new OfflineManager();
```

### Step 2: Enhance DBService with Offline Queue Support
Modify the DBService to support offline queue operations:

```typescript
// Enhanced DBService in src/lib/services/dbService.ts
import { retryOperation, withTimeout, categorizeIndexedDBError } from '../utils/indexeddbErrorHandler';
import { performanceMonitor } from '../utils/performanceMonitor';
import type { Card } from '../types';
import type { CloudFile } from '../types/cloud';
import type { OfflineOperation } from '../utils/offlineManager';

export class DBService {
  private db: IDBDatabase | null = null;
  private readonly DB_NAME = 'MarkdownCardsDB';
  private readonly VERSION = 1;
  private readonly CARDS_STORE = 'cards';
  private readonly FILES_STORE = 'files';
  private readonly METADATA_STORE = 'metadata';
  private readonly OFFLINE_QUEUE_STORE = 'offlineQueue'; // New store for offline operations

  // ... existing code ...

  // Enhanced initialization with offline queue store
  async init(): Promise<{ success: boolean; error?: string }> {
    // ... existing code ...

    const result = await retryOperation(
      async () => {
        return new Promise((resolve, reject) => {
          const request = indexedDB.open(this.DB_NAME, this.VERSION);

          request.onerror = () => {
            reject(new Error('Failed to open IndexedDB'));
          };

          request.onsuccess = () => {
            this.db = request.result;
            this.isInitialized = true;
            resolve(true);
          };

          request.onupgradeneeded = (event) => {
            try {
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

              // Create metadata store for cache management
              if (!db.objectStoreNames.contains(this.METADATA_STORE)) {
                const metadataStore = db.createObjectStore(this.METADATA_STORE, { keyPath: 'key' });
                metadataStore.createIndex('timestamp', 'timestamp', { unique: false });
              }

              // Create offline queue store
              if (!db.objectStoreNames.contains(this.OFFLINE_QUEUE_STORE)) {
                const queueStore = db.createObjectStore(this.OFFLINE_QUEUE_STORE, { keyPath: 'id' });
                queueStore.createIndex('timestamp', 'timestamp', { unique: false });
                queueStore.createIndex('status', 'status', { unique: false });
                queueStore.createIndex('type', 'type', { unique: false });
              }
            } catch (error) {
              reject(error);
            }
          };
        });
      },
      3, // Max 3 retries
      200, // 200ms base delay
      5000 // 5 second max delay
    );

    // ... existing code ...
  }

  // Offline queue operations
  async saveOfflineOperation(operation: OfflineOperation): Promise<{ success: boolean; error?: string }> {
    if (!this.isBrowser()) {
      return { success: true };
    }

    if (!this.isInitialized) {
      const initResult = await this.init();
      if (!initResult.success) {
        return { success: false, error: initResult.error };
      }
    }

    const result = await retryOperation(
      async () => {
        return new Promise((resolve, reject) => {
          try {
            const db = this.getDb();
            const transaction = db.transaction([this.OFFLINE_QUEUE_STORE], 'readwrite');
            const store = transaction.objectStore(this.OFFLINE_QUEUE_STORE);

            const request = store.put(operation);
            request.onsuccess = () => resolve(true);
            request.onerror = () => {
              const errorMessage = request.error ? request.error.message : 'Unknown error';
              reject(new Error(errorMessage));
            };
          } catch (error) {
            reject(error);
          }
        });
      },
      3,
      100,
      3000
    );

    return {
      success: result.success,
      error: result.error ? categorizeIndexedDBError(result.error).message : undefined
    };
  }

  async getOfflineOperation(id: string): Promise<{ operation: OfflineOperation | null; error?: string }> {
    if (!this.isBrowser()) {
      return { operation: null };
    }

    if (!this.isInitialized) {
      const initResult = await this.init();
      if (!initResult.success) {
        return { operation: null, error: initResult.error };
      }
    }

    const result = await retryOperation(
      async () => {
        return new Promise((resolve, reject) => {
          try {
            const db = this.getDb();
            const transaction = db.transaction([this.OFFLINE_QUEUE_STORE], 'readonly');
            const store = transaction.objectStore(this.OFFLINE_QUEUE_STORE);

            const request = store.get(id);
            request.onsuccess = () => {
              resolve(request.result || null);
            };
            request.onerror = () => {
              const errorMessage = request.error ? request.error.message : 'Unknown error';
              reject(new Error(errorMessage));
            };
          } catch (error) {
            reject(error);
          }
        });
      },
      2,
      50,
      2000
    );

    return {
      operation: result.success ? result.result as OfflineOperation | null : null,
      error: result.error ? categorizeIndexedDBError(result.error).message : undefined
    };
  }

  async getPendingOfflineOperations(): Promise<{ operations: OfflineOperation[]; error?: string }> {
    if (!this.isBrowser()) {
      return { operations: [] };
    }

    if (!this.isInitialized) {
      const initResult = await this.init();
      if (!initResult.success) {
        return { operations: [], error: initResult.error };
      }
    }

    const result = await retryOperation(
      async () => {
        return new Promise((resolve, reject) => {
          try {
            const db = this.getDb();
            const transaction = db.transaction([this.OFFLINE_QUEUE_STORE], 'readonly');
            const store = transaction.objectStore(this.OFFLINE_QUEUE_STORE);
            const index = store.index('status');

            // Get all pending operations
            const request = index.getAll('pending');
            request.onsuccess = () => {
              resolve(request.result || []);
            };
            request.onerror = () => {
              const errorMessage = request.error ? request.error.message : 'Unknown error';
              reject(new Error(errorMessage));
            };
          } catch (error) {
            reject(error);
          }
        });
      },
      2,
      100,
      5000
    );

    return {
      operations: result.success ? result.result as OfflineOperation[] : [],
      error: result.error ? categorizeIndexedDBError(result.error).message : undefined
    };
  }

  async updateOfflineOperationStatus(id: string, status: string, error?: string): Promise<{ success: boolean; error?: string }> {
    if (!this.isBrowser()) {
      return { success: true };
    }

    if (!this.isInitialized) {
      const initResult = await this.init();
      if (!initResult.success) {
        return { success: false, error: initResult.error };
      }
    }

    const result = await retryOperation(
      async () => {
        return new Promise((resolve, reject) => {
          try {
            const db = this.getDb();
            const transaction = db.transaction([this.OFFLINE_QUEUE_STORE], 'readwrite');
            const store = transaction.objectStore(this.OFFLINE_QUEUE_STORE);

            // First get the operation
            const getRequest = store.get(id);
            getRequest.onsuccess = () => {
              const operation = getRequest.result;
              if (operation) {
                // Update status and error
                operation.status = status;
                if (error) {
                  operation.error = error;
                }
                if (status === 'processing') {
                  operation.attempts = (operation.attempts || 0) + 1;
                }

                // Save updated operation
                const putRequest = store.put(operation);
                putRequest.onsuccess = () => resolve(true);
                putRequest.onerror = () => {
                  const errorMessage = putRequest.error ? putRequest.error.message : 'Unknown error';
                  reject(new Error(errorMessage));
                };
              } else {
                resolve(false); // Operation not found
              }
            };
            getRequest.onerror = () => {
              const errorMessage = getRequest.error ? getRequest.error.message : 'Unknown error';
              reject(new Error(errorMessage));
            };
          } catch (error) {
            reject(error);
          }
        });
      },
      3,
      100,
      3000
    );

    return {
      success: result.success,
      error: result.error ? categorizeIndexedDBError(result.error).message : undefined
    };
  }

  async deleteCompletedOfflineOperations(): Promise<{ deleted: number; error?: string }> {
    if (!this.isBrowser()) {
      return { deleted: 0 };
    }

    if (!this.isInitialized) {
      const initResult = await this.init();
      if (!initResult.success) {
        return { deleted: 0, error: initResult.error };
      }
    }

    const result = await retryOperation(
      async () => {
        return new Promise((resolve, reject) => {
          try {
            const db = this.getDb();
            const transaction = db.transaction([this.OFFLINE_QUEUE_STORE], 'readwrite');
            const store = transaction.objectStore(this.OFFLINE_QUEUE_STORE);
            const index = store.index('status');

            // Get all completed operations
            const getRequest = index.getAll('completed');
            getRequest.onsuccess = () => {
              const completedOps = getRequest.result || [];
              let deleted = 0;

              if (completedOps.length === 0) {
                resolve(0);
                return;
              }

              // Delete each completed operation
              const deleteNext = () => {
                if (deleted >= completedOps.length) {
                  resolve(deleted);
                  return;
                }

                const op = completedOps[deleted];
                const deleteRequest = store.delete(op.id);
                deleteRequest.onsuccess = () => {
                  deleted++;
                  deleteNext();
                };
                deleteRequest.onerror = () => {
                  const errorMessage = deleteRequest.error ? deleteRequest.error.message : 'Unknown error';
                  reject(new Error(errorMessage));
                };
              };

              deleteNext();
            };
            getRequest.onerror = () => {
              const errorMessage = getRequest.error ? getRequest.error.message : 'Unknown error';
              reject(new Error(errorMessage));
            };
          } catch (error) {
            reject(error);
          }
        });
      },
      2,
      200,
      5000
    );

    return {
      deleted: result.success ? result.result as number : 0,
      error: result.error ? categorizeIndexedDBError(result.error).message : undefined
    };
  }
}
```

### Step 3: Enhance CloudStore with Offline Support
Modify the cloudStore to integrate with offline management:

```typescript
// Enhanced cloudStore.ts with offline support
import { writable, derived, get } from 'svelte/store';
import type { CloudFile, SyncStatus } from '../types/cloud';
import { cloudService } from '../services/cloudService';
import { dbService } from '../services/dbService';
import { parseMarkdown } from '../utils/markdownParser';
import type { Card } from '../types';
import { performanceMonitor } from '../utils/performanceMonitor';
import { cacheManager } from '../utils/cacheManager';
import { offlineManager, type OfflineOperation } from '../utils/offlineManager';

// Enhanced offline status store
export const offlineStatus = writable<{
  isOffline: boolean;
  offlineSince?: number;
  queuedOperations: number;
  isProcessingQueue: boolean;
  lastSyncAttempt?: number;
  syncError?: string;
}>({
  isOffline: false,
  queuedOperations: 0,
  isProcessingQueue: false
});

// Enhanced sync status store with offline integration
export const syncStatus = writable<SyncStatus & {
  lastValidation?: number;
  validationResult?: any;
  offlineSyncStatus?: string;
}>({
  isSyncing: false,
  lastSync: null,
  error: null,
  offlineSyncStatus: 'idle'
});

// Initialize offline manager
if (typeof window !== 'undefined') {
  // Add listener for network changes
  offlineManager.addNetworkListener(() => {
    const status = offlineManager.getOfflineStatus();
    offlineStatus.set({
      ...status,
      isProcessingQueue: false // Will be updated when processing starts
    });

    // Update authentication status based on offline status
    isAuthenticated.set(cloudService.isAuthenticated() && !status.isOffline);
  });
}

// Enhanced save card to cloud with offline queuing
export async function saveCardToCloud(card: Card, filename: string): Promise<boolean> {
  const perfId = performanceMonitor.start('save-card-to-cloud', 'sync', {
    fileName: filename
  });

  try {
    // Check if we're offline
    const offlineStatusValue = get(offlineStatus);
    if (offlineStatusValue.isOffline) {
      // Queue the operation for later
      const operation: Omit<OfflineOperation, 'id' | 'timestamp' | 'attempts' | 'status'> = {
        type: 'saveCard',
        payload: { card, filename },
        priority: 'normal'
      };

      await offlineManager.queueOperation(operation);

      // Update offline status
      const updatedStatus = offlineManager.getOfflineStatus();
      offlineStatus.set({
        ...updatedStatus,
        queuedOperations: updatedStatus.queuedOperations + 1,
        isProcessingQueue: false
      });

      performanceMonitor.stop(perfId, true, undefined, { offline: true });
      return true; // Return true to indicate the operation is queued
    }

    // Online - proceed with normal save
    // Save to local cache first
    const localSaveStartTime = performance.now();
    await dbService.saveCard(card);
    const localSaveTime = performance.now() - localSaveStartTime;
    performanceMonitor.record('local-save', 'indexeddb', localSaveTime, true);

    // Then save to cloud
    const { serializeCard } = await import('../utils/markdownSerializer');
    const markdown = serializeCard(card);

    const formData = new FormData();
    formData.append('path', filename);
    formData.append('content', markdown);
    formData.append('overwrite', 'true');

    const cloudSaveStartTime = performance.now();
    const response = await fetch('/api/cloud/upload', {
      method: 'POST',
      body: formData
    });
    const cloudSaveTime = performance.now() - cloudSaveStartTime;
    performanceMonitor.record('cloud-save', 'cloud', cloudSaveTime, response.ok);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // Update the file list to reflect the change
    await syncFilesFromCloud();

    performanceMonitor.stop(perfId, true);
    return true;
  } catch (error) {
    console.error('Error saving card to cloud:', error);
    performanceMonitor.stop(perfId, false, error instanceof Error ? error.message : 'Unknown error');

    // If it's a network error and we're going offline, queue the operation
    if (error instanceof Error &&
        (error.name === 'TypeError' || error.message.includes('network')) &&
        !get(offlineStatus).isOffline) {
      try {
        // Queue the operation for when we come back online
        const operation: Omit<OfflineOperation, 'id' | 'timestamp' | 'attempts' | 'status'> = {
          type: 'saveCard',
          payload: { card, filename },
          priority: 'high' // High priority since it was attempted online
        };

        await offlineManager.queueOperation(operation);

        // Update offline status
        const updatedStatus = offlineManager.getOfflineStatus();
        offlineStatus.set({
          ...updatedStatus,
          queuedOperations: updatedStatus.queuedOperations + 1,
          isProcessingQueue: false
        });

        return true; // Return true to indicate the operation is queued
      } catch (queueError) {
        console.error('Error queuing offline operation:', queueError);
      }
    }

    return false;
  }
}

// Enhanced sync files from cloud with offline handling
export async function syncFilesFromCloud(): Promise<void> {
  // Check if we're authenticated and online
  const authStatus = get(isAuthenticated);
  const offlineStatusValue = get(offlineStatus);

  if (!authStatus || offlineStatusValue.isOffline) {
    return;
  }

  syncStatus.update(status => ({ ...status, isSyncing: true, error: null }));

  const perfId = performanceMonitor.start('sync-files-from-cloud', 'sync');

  try {
    const response = await fetch('/api/cloud/files');

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    cloudFiles.set(data._embedded.items);

    // After syncing files, validate cache
    cacheValidationStatus.set({ isRunning: true, lastRun: Date.now() });

    try {
      const validationResult = await cacheManager.validateCache({
        removeStale: true,
        resolveConflicts: true
      });

      cacheValidationStatus.set({
        isRunning: false,
        lastRun: Date.now(),
        result: validationResult
      });

      syncStatus.update(status => ({
        ...status,
        isSyncing: false,
        lastSync: Date.now(),
        error: null,
        lastValidation: Date.now(),
        validationResult
      }));
    } catch (validationError) {
      console.error('Error validating cache after sync:', validationError);
      cacheValidationStatus.set({
        isRunning: false,
        lastRun: Date.now(),
        error: validationError instanceof Error ? validationError.message : 'Unknown error'
      });

      syncStatus.update(status => ({
        ...status,
        isSyncing: false,
        lastSync: Date.now(),
        error: null
      }));
    }

    performanceMonitor.stop(perfId, true);
  } catch (error) {
    console.error('Error syncing files from cloud:', error);
    syncStatus.update(status => ({
      ...status,
      isSyncing: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }));

    cacheValidationStatus.set({
      isRunning: false,
      lastRun: Date.now(),
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    performanceMonitor.stop(perfId, false, error instanceof Error ? error.message : 'Unknown error');
  }
}

// Process offline queue
export async function processOfflineQueue(): Promise<void> {
  // Update status to show processing
  offlineStatus.update(status => ({
    ...status,
    isProcessingQueue: true
  }));

  syncStatus.update(status => ({
    ...status,
    offlineSyncStatus: 'processing'
  }));

  try {
    await offlineManager.processQueue();

    // Update queue stats
    const queueStats = await offlineManager.getQueueStats();

    offlineStatus.update(status => ({
      ...status,
      isProcessingQueue: false,
      queuedOperations: queueStats.pending
    }));

    syncStatus.update(status => ({
      ...status,
      offlineSyncStatus: 'completed'
    }));
  } catch (error) {
    console.error('Error processing offline queue:', error);

    offlineStatus.update(status => ({
      ...status,
      isProcessingQueue: false,
      syncError: error instanceof Error ? error.message : 'Unknown error'
    }));

    syncStatus.update(status => ({
      ...status,
      offlineSyncStatus: 'error',
      error: error instanceof Error ? error.message : 'Unknown error'
    }));
  }
}

// Clear completed operations
export async function clearCompletedOfflineOperations(): Promise<number> {
  try {
    const result = await dbService.deleteCompletedOfflineOperations();
    return result.deleted;
  } catch (error) {
    console.error('Error clearing completed offline operations:', error);
    return 0;
  }
}

// Get offline queue statistics
export async function getOfflineQueueStats() {
  return await offlineManager.getQueueStats();
}
```

### Step 4: Add Offline Mode UI
Create components to display offline mode status and controls:

```svelte
<!-- src/lib/components/OfflineIndicator.svelte -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { offlineStatus, processOfflineQueue } from '$lib/stores/cloudStore';

  let status = {
    isOffline: false,
    offlineSince: null,
    queuedOperations: 0,
    isProcessingQueue: false,
    lastSyncAttempt: null,
    syncError: null
  };

  let unsubscribe: () => void;

  // Handle manual queue processing
  async function handleProcessQueue() {
    try {
      await processOfflineQueue();
    } catch (error) {
      console.error('Error processing offline queue:', error);
    }
  }

  onMount(() => {
    // Subscribe to offline status updates
    unsubscribe = offlineStatus.subscribe(newStatus => {
      status = newStatus;
    });
  });

  onDestroy(() => {
    if (unsubscribe) {
      unsubscribe();
    }
  });
</script>

{#if status.isOffline || status.queuedOperations > 0}
  <div class="offline-indicator {status.isOffline ? 'offline' : 'online'}">
    <div class="indicator-content">
      {#if status.isOffline}
        <div class="status offline">
          <span class="icon">📶</span>
          <span class="text">Offline Mode</span>
          {#if status.offlineSince}
            <span class="since">(since {new Date(status.offlineSince).toLocaleTimeString()})</span>
          {/if}
        </div>
      {:else}
        <div class="status online">
          <span class="icon">🌐</span>
          <span class="text">Online</span>
        </div>
      {/if}

      {#if status.queuedOperations > 0}
        <div class="queue-info">
          <span class="queue-count">{status.queuedOperations} pending sync</span>
          {#if status.isProcessingQueue}
            <span class="processing">Processing...</span>
          {:else if !status.isOffline}
            <button class="process-button" on:click={handleProcessQueue}>
              Sync Now
            </button>
          {/if}
        </div>
      {/if}

      {#if status.syncError}
        <div class="error">
          Sync error: {status.syncError}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .offline-indicator {
    position: fixed;
    top: 1rem;
    right: 1rem;
    z-index: 1000;
    background-color: white;
    border: 1px solid #dee2e6;
    border-radius: 8px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    padding: 0.75rem 1rem;
    max-width: 300px;
  }

  .offline-indicator.offline {
    border-color: #f5c6cb;
    background-color: #f8d7da;
  }

  .indicator-content {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 500;
  }

  .status.offline .text {
    color: #721c24;
  }

  .status.offline .since {
    font-size: 0.8rem;
    color: #721c24;
    opacity: 0.8;
  }

  .status.online .text {
    color: #155724;
  }

  .icon {
    font-size: 1.2rem;
  }

  .queue-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
  }

  .queue-count {
    color: #6c757d;
  }

  .processing {
    color: #004085;
    font-style: italic;
  }

  .process-button {
    background-color: #007bff;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.25rem 0.5rem;
    cursor: pointer;
    font-size: 0.8rem;
  }

  .process-button:hover:not(:disabled) {
    background-color: #0056b3;
  }

  .process-button:disabled {
    background-color: #6c757d;
    cursor: not-allowed;
  }

  .error {
    color: #721c24;
    font-size: 0.8rem;
    padding: 0.25rem;
    background-color: rgba(220, 53, 69, 0.1);
    border-radius: 4px;
  }
</style>
```

```svelte
<!-- src/lib/components/OfflineManager.svelte -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    offlineStatus,
    processOfflineQueue,
    clearCompletedOfflineOperations,
    getOfflineQueueStats
  } from '$lib/stores/cloudStore';

  let status = {
    isOffline: false,
    offlineSince: null,
    queuedOperations: 0,
    isProcessingQueue: false,
    lastSyncAttempt: null,
    syncError: null
  };

  let queueStats = {
    total: 0,
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    oldestPending: null
  };

  let refreshInterval: number;
  let unsubscribe: () => void;

  // Update queue statistics periodically
  async function updateQueueStats() {
    try {
      queueStats = await getOfflineQueueStats();
    } catch (error) {
      console.error('Error updating queue stats:', error);
    }
  }

  // Handle manual queue processing
  async function handleProcessQueue() {
    try {
      await processOfflineQueue();
    } catch (error) {
      console.error('Error processing offline queue:', error);
    }
  }

  // Handle clearing completed operations
  async function handleClearCompleted() {
    try {
      const deleted = await clearCompletedOfflineOperations();
      console.log(`Cleared ${deleted} completed operations`);
      await updateQueueStats();
    } catch (error) {
      console.error('Error clearing completed operations:', error);
    }
  }

  // Handle retrying failed operations
  async function handleRetryFailed() {
    // Implementation would go here
    console.log('Retrying failed operations');
  }

  onMount(() => {
    // Subscribe to offline status updates
    unsubscribe = offlineStatus.subscribe(newStatus => {
      status = newStatus;
    });

    // Update queue stats initially and periodically
    updateQueueStats();
    refreshInterval = setInterval(updateQueueStats, 30000); // Every 30 seconds
  });

  onDestroy(() => {
    if (unsubscribe) {
      unsubscribe();
    }
    if (refreshInterval) {
      clearInterval(refreshInterval);
    }
  });
</script>

<div class="offline-manager">
  <div class="header">
    <h3>Offline Manager</h3>
    <div class="actions">
      {#if !status.isOffline}
        <button
          class="action-button"
          on:click={handleProcessQueue}
          disabled={status.isProcessingQueue || queueStats.pending === 0}
        >
          {status.isProcessingQueue ? 'Processing...' : 'Process Queue'}
        </button>
      {/if}
      <button
        class="action-button secondary"
        on:click={handleClearCompleted}
        disabled={queueStats.completed === 0}
      >
        Clear Completed
      </button>
      <button
        class="action-button secondary"
        on:click={handleRetryFailed}
        disabled={queueStats.failed === 0}
      >
        Retry Failed
      </button>
    </div>
  </div>

  <!-- Offline Status -->
  <div class="offline-status">
    <h4>Connection Status</h4>
    <div class="status-content">
      <div class="status-item">
        <span class="label">Status:</span>
        <span class="value {status.isOffline ? 'offline' : 'online'}">
          {status.isOffline ? 'Offline' : 'Online'}
        </span>
      </div>
      {#if status.offlineSince}
        <div class="status-item">
          <span class="label">Offline Since:</span>
          <span class="value">{new Date(status.offlineSince).toLocaleString()}</span>
        </div>
      {/if}
      {#if status.syncError}
        <div class="status-item error">
          <span class="label">Last Error:</span>
          <span class="value">{status.syncError}</span>
        </div>
      {/if}
    </div>
  </div>

  <!-- Queue Statistics -->
  <div class="queue-stats">
    <h4>Queue Statistics</h4>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">{queueStats.total}</div>
        <div class="stat-label">Total Operations</div>
      </div>
      <div class="stat-card pending">
        <div class="stat-value">{queueStats.pending}</div>
        <div class="stat-label">Pending</div>
      </div>
      <div class="stat-card processing">
        <div class="stat-value">{queueStats.processing}</div>
        <div class="stat-label">Processing</div>
      </div>
      <div class="stat-card completed">
        <div class="stat-value">{queueStats.completed}</div>
        <div class="stat-label">Completed</div>
      </div>
      <div class="stat-card failed">
        <div class="stat-value">{queueStats.failed}</div>
        <div class="stat-label">Failed</div>
      </div>
    </div>

    {#if queueStats.oldestPending}
      <div class="oldest-pending">
        <span class="label">Oldest Pending:</span>
        <span class="value">{new Date(queueStats.oldestPending).toLocaleString()}</span>
      </div>
    {/if}
  </div>

  <!-- Queue Actions -->
  <div class="queue-actions">
    <h4>Queue Actions</h4>
    <div class="actions-grid">
      <button
        class="queue-action"
        on:click={handleProcessQueue}
        disabled={status.isOffline || status.isProcessingQueue || queueStats.pending === 0}
      >
        <div class="action-icon">🔄</div>
        <div class="action-label">Process Queue</div>
        <div class="action-description">Sync pending operations</div>
      </button>

      <button
        class="queue-action"
        on:click={handleClearCompleted}
        disabled={queueStats.completed === 0}
      >
        <div class="action-icon">🧹</div>
        <div class="action-label">Clear Completed</div>
        <div class="action-description">Remove completed operations</div>
      </button>

      <button
        class="queue-action"
        on:click={handleRetryFailed}
        disabled={queueStats.failed === 0}
      >
        <div class="action-icon">↻</div>
        <div class="action-label">Retry Failed</div>
        <div class="action-description">Retry failed operations</div>
      </button>
    </div>
  </div>
</div>

<style>
  .offline-manager {
    background-color: #f8f9fa;
    border: 1px solid #dee2e6;
    border-radius: 8px;
    padding: 1.5rem;
    margin: 1rem 0;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
  }

  .header h3 {
    margin: 0;
    color: #495057;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
  }

  .action-button {
    background-color: #007bff;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.5rem 1rem;
    cursor: pointer;
    font-size: 0.9rem;
  }

  .action-button:hover:not(:disabled) {
    background-color: #0056b3;
  }

  .action-button:disabled {
    background-color: #6c757d;
    cursor: not-allowed;
  }

  .action-button.secondary {
    background-color: #6c757d;
  }

  .action-button.secondary:hover:not(:disabled) {
    background-color: #5a6268;
  }

  .offline-status {
    margin-bottom: 1.5rem;
  }

  .offline-status h4 {
    margin-top: 0;
    margin-bottom: 0.5rem;
    color: #495057;
  }

  .status-content {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
  }

  .status-item {
    display: flex;
    justify-content: space-between;
    padding: 0.5rem;
    background-color: white;
    border: 1px solid #dee2e6;
    border-radius: 4px;
  }

  .status-item.error {
    background-color: #f8d7da;
    border-color: #f5c6cb;
  }

  .status-item.error .label {
    color: #721c24;
  }

  .status-item.error .value {
    color: #721c24;
  }

  .label {
    color: #6c757d;
  }

  .value {
    font-weight: 500;
    color: #495057;
  }

  .value.offline {
    color: #dc3545;
  }

  .value.online {
    color: #28a745;
  }

  .queue-stats {
    margin-bottom: 1.5rem;
  }

  .queue-stats h4 {
    margin-top: 0;
    margin-bottom: 0.5rem;
    color: #495057;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .stat-card {
    background-color: white;
    border: 1px solid #dee2e6;
    border-radius: 6px;
    padding: 1rem;
    text-align: center;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  }

  .stat-card.pending {
    border-color: #ffc107;
    background-color: #fff3cd;
  }

  .stat-card.processing {
    border-color: #17a2b8;
    background-color: #d1ecf1;
  }

  .stat-card.completed {
    border-color: #28a745;
    background-color: #d4edda;
  }

  .stat-card.failed {
    border-color: #dc3545;
    background-color: #f8d7da;
  }

  .stat-value {
    font-size: 1.5rem;
    font-weight: bold;
    margin-bottom: 0.25rem;
    color: #495057;
  }

  .stat-label {
    font-size: 0.85rem;
    color: #6c757d;
  }

  .oldest-pending {
    display: flex;
    justify-content: space-between;
    padding: 0.5rem;
    background-color: white;
    border: 1px solid #dee2e6;
    border-radius: 4px;
  }

  .queue-actions {
    margin-bottom: 1rem;
  }

  .queue-actions h4 {
    margin-top: 0;
    margin-bottom: 0.5rem;
    color: #495057;
  }

  .actions-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 1rem;
  }

  .queue-action {
    background-color: white;
    border: 1px solid #dee2e6;
    border-radius: 6px;
    padding: 1rem;
    text-align: center;
    cursor: pointer;
    transition: all 0.2s;
  }

  .queue-action:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    border-color: #007bff;
  }

  .queue-action:disabled {
    opacity: 0.6;
    cursor: not-allowed;
    transform: none;
    box-shadow: none;
  }

  .action-icon {
    font-size: 2rem;
    margin-bottom: 0.5rem;
  }

  .action-label {
    font-weight: 500;
    margin-bottom: 0.25rem;
    color: #495057;
  }

  .action-description {
    font-size: 0.85rem;
    color: #6c757d;
  }
</style>
```

### Step 5: Integrate Offline Support with Application Lifecycle
Add offline support to the application's main lifecycle:

```typescript
// src/lib/stores/appStore.ts
import { offlineManager } from '../utils/offlineManager';
import { processOfflineQueue } from './cloudStore';
import { onMount } from 'svelte';

// Initialize offline support when app starts
export function initializeOfflineSupport() {
  // Add listener for network changes to automatically process queue when online
  offlineManager.addNetworkListener(() => {
    const status = offlineManager.getOfflineStatus();
    if (!status.isOffline) {
      // We're back online, process the queue
      processOfflineQueue();
    }
  });

  // Check initial offline status
  const status = offlineManager.getOfflineStatus();
  if (!status.isOffline) {
    // We're online, process any queued operations
    processOfflineQueue();
  }
}

// Clean up offline support when app is destroyed
export function cleanupOfflineSupport() {
  // Remove network listeners
  // Note: In a real implementation, we would need to keep references to added listeners
}

// Usage in main app component
// onMount(() => {
//   initializeOfflineSupport();
//
//   return () => {
//     cleanupOfflineSupport();
//   };
// });
```

## Performance Considerations
1. **Efficient Queue Processing**: Process operations in batches to avoid blocking UI
2. **Smart Prioritization**: Prioritize critical operations over less important ones
3. **Background Sync**: Run sync operations in background with minimal impact
4. **Memory Management**: Limit queue size and clean up completed operations

## Error Handling
1. **Graceful Degradation**: Continue functioning even if offline sync fails
2. **Retry Logic**: Retry failed operations with exponential backoff
3. **Conflict Resolution**: Handle conflicts between offline and online changes
4. **User Feedback**: Inform users of sync issues without disrupting workflow

## Testing Plan
1. **Unit Tests**: Test offline queue management and operation processing
2. **Integration Tests**: Test full offline workflow with network changes
3. **Conflict Tests**: Test conflict resolution scenarios
4. **Performance Tests**: Measure impact of offline operations on application performance
5. **Edge Case Tests**: Test behavior with large queues and limited storage

## Success Metrics
1. **Offline Functionality**: 100% application functionality during offline periods
2. **Sync Reliability**: > 99% successful sync operations when reconnected
3. **Queue Management**: < 1% queue processing errors
4. **User Experience**: Clear offline indicators and feedback
5. **Conflict Resolution**: > 95% conflicts automatically resolved
