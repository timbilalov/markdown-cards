# Cache Management: Periodic Validation Against Cloud

## Overview
This document details the implementation approach for adding cache management with periodic validation against the cloud. The implementation will ensure data consistency by regularly checking and resolving conflicts between local IndexedDB cache and cloud data, as well as removing stale entries.

## Current Implementation Analysis
The current application has minimal cache management:
1. Basic caching of cloud files and cards in IndexedDB
2. Simple timestamp-based validation during load operations
3. No periodic validation processes
4. No automated conflict resolution
5. No stale entry removal

However, there are several areas for improvement:
- No scheduled cache validation
- No comprehensive conflict detection
- No automated stale entry cleanup
- No cache size management
- No validation reporting or metrics

## Enhanced Implementation Plan

### 1. Periodic Validation Scheduling
Implement scheduled validation processes:
1. Background validation tasks
2. Configurable validation intervals
3. Manual validation triggers
4. Validation during key events (app start, network changes)

### 2. Conflict Detection and Resolution
Implement comprehensive conflict detection:
1. Timestamp-based conflict detection
2. Content hash comparison
3. User preference for conflict resolution
4. Automated resolution strategies

### 3. Stale Entry Management
Implement stale entry detection and removal:
1. Age-based stale entry detection
2. Cloud existence verification
3. Automated cleanup processes
4. User notification for manual cleanup

### 4. Cache Size Management
Implement cache size monitoring and management:
1. Storage quota monitoring
2. Automatic cache trimming
3. User-configurable cache limits
4. Cache prioritization strategies

## Implementation Steps

### Step 1: Create Cache Management Utilities
Create utility functions for cache management:

```typescript
// src/lib/utils/cacheManager.ts
import { dbService } from '../services/dbService';
import { cloudService } from '../services/cloudService';
import { parseMarkdown } from './markdownParser';
import { performanceMonitor } from './performanceMonitor';

export interface CacheValidationResult {
  validated: number;
  conflicts: number;
  resolved: number;
  staleRemoved: number;
  errors: number;
  timestamp: number;
}

export interface CacheEntryInfo {
  id: string;
  type: 'card' | 'file';
  lastModified: number;
  lastValidated: number;
  size: number;
  status: 'valid' | 'stale' | 'conflict' | 'error';
  cloudExists?: boolean;
  cloudModified?: number;
  conflictDetails?: string;
}

export interface CacheValidationOptions {
  validateAll?: boolean;
  removeStale?: boolean;
  resolveConflicts?: boolean;
  maxAge?: number; // in milliseconds
  batchSize?: number; // for large caches
}

export class CacheManager {
  private validationInterval: number | null = null;
  private isValidationRunning = false;
  private defaultValidationInterval = 30 * 60 * 1000; // 30 minutes
  private maxCacheAge = 7 * 24 * 60 * 60 * 1000; // 7 days

  // Start periodic validation
  startPeriodicValidation(intervalMs?: number): void {
    if (this.validationInterval) {
      this.stopPeriodicValidation();
    }

    const interval = intervalMs || this.defaultValidationInterval;
    this.validationInterval = window.setInterval(() => {
      this.validateCache({ removeStale: true, resolveConflicts: true });
    }, interval);
  }

  // Stop periodic validation
  stopPeriodicValidation(): void {
    if (this.validationInterval) {
      clearInterval(this.validationInterval);
      this.validationInterval = null;
    }
  }

  // Validate cache entries against cloud
  async validateCache(options: CacheValidationOptions = {}): Promise<CacheValidationResult> {
    if (this.isValidationRunning) {
      throw new Error('Cache validation is already running');
    }

    this.isValidationRunning = true;
    const perfId = performanceMonitor.start('validate-cache', 'cache', { options });

    try {
      const result: CacheValidationResult = {
        validated: 0,
        conflicts: 0,
        resolved: 0,
        staleRemoved: 0,
        errors: 0,
        timestamp: Date.now()
      };

      // Get all cached cards
      const cards = await dbService.getAllCards();
      const files = await dbService.getAllCloudFiles();

      // Validate cards
      for (const card of cards.cards) {
        try {
          const validationResult = await this.validateCard(card, options);
          result.validated += validationResult.validated;
          result.conflicts += validationResult.conflicts;
          result.resolved += validationResult.resolved;
          result.staleRemoved += validationResult.staleRemoved;
          result.errors += validationResult.errors;
        } catch (error) {
          console.error(`Error validating card ${card.card?.meta.id}:`, error);
          result.errors++;
        }
      }

      // Validate files
      for (const file of files.files) {
        try {
          const validationResult = await this.validateFile(file, options);
          result.validated += validationResult.validated;
          result.conflicts += validationResult.conflicts;
          result.resolved += validationResult.resolved;
          result.staleRemoved += validationResult.staleRemoved;
          result.errors += validationResult.errors;
        } catch (error) {
          console.error(`Error validating file ${file.path}:`, error);
          result.errors++;
        }
      }

      performanceMonitor.stop(perfId, true);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      performanceMonitor.stop(perfId, false, errorMessage);
      throw error;
    } finally {
      this.isValidationRunning = false;
    }
  }

  // Validate a single card against cloud
  private async validateCard(card: any, options: CacheValidationOptions): Promise<CacheValidationResult> {
    const result: CacheValidationResult = {
      validated: 0,
      conflicts: 0,
      resolved: 0,
      staleRemoved: 0,
      errors: 0,
      timestamp: Date.now()
    };

    try {
      // Check if card is too old
      const cardAge = Date.now() - (card.card?.meta.modified || 0);
      const maxAge = options.maxAge || this.maxCacheAge;

      if (cardAge > maxAge) {
        if (options.removeStale) {
          // Remove stale card
          await dbService.deleteCard(card.card?.meta.id);
          result.staleRemoved++;
          return result;
        }
      }

      // Check if we're online and authenticated
      if (!cloudService.isAuthenticated() || !navigator.onLine) {
        // Can't validate against cloud, mark as valid for now
        result.validated++;
        return result;
      }

      // Get cloud file list to check if card still exists
      const cloudFiles = await cloudService.listFiles();
      const fileName = `${card.card?.meta.id}.md`;
      const cloudFile = cloudFiles._embedded.items.find(f => f.name === fileName);

      if (!cloudFile) {
        // Card no longer exists in cloud
        if (options.removeStale) {
          await dbService.deleteCard(card.card?.meta.id);
          result.staleRemoved++;
        }
        return result;
      }

      // Check if card is up to date
      const localModified = new Date(card.card?.meta.modified).getTime();
      const cloudModified = new Date(cloudFile.modified).getTime();

      if (localModified < cloudModified) {
        // Cloud version is newer, potential conflict
        result.conflicts++;

        if (options.resolveConflicts) {
          // Download latest version from cloud
          const content = await cloudService.downloadFile(cloudFile.file);
          const updatedCard = parseMarkdown(content);

          // Save updated card
          await dbService.saveCard(updatedCard);
          result.resolved++;
        }
      } else {
        // Local version is current or newer
        result.validated++;
      }

      return result;
    } catch (error) {
      console.error(`Error validating card:`, error);
      result.errors++;
      return result;
    }
  }

  // Validate a single file against cloud
  private async validateFile(file: any, options: CacheValidationOptions): Promise<CacheValidationResult> {
    const result: CacheValidationResult = {
      validated: 0,
      conflicts: 0,
      resolved: 0,
      staleRemoved: 0,
      errors: 0,
      timestamp: Date.now()
    };

    try {
      // Check if file is too old
      const fileAge = Date.now() - new Date(file.modified).getTime();
      const maxAge = options.maxAge || this.maxCacheAge;

      if (fileAge > maxAge) {
        if (options.removeStale) {
          // Remove stale file
          await dbService.deleteCloudFile(file.path);
          result.staleRemoved++;
          return result;
        }
      }

      // Check if we're online and authenticated
      if (!cloudService.isAuthenticated() || !navigator.onLine) {
        // Can't validate against cloud, mark as valid for now
        result.validated++;
        return result;
      }

      // Get cloud file list to check if file still exists
      const cloudFiles = await cloudService.listFiles();
      const cloudFile = cloudFiles._embedded.items.find(f => f.path === file.path);

      if (!cloudFile) {
        // File no longer exists in cloud
        if (options.removeStale) {
          await dbService.deleteCloudFile(file.path);
          result.staleRemoved++;
        }
        return result;
      }

      // Check if file metadata is up to date
      const localModified = new Date(file.modified).getTime();
      const cloudModified = new Date(cloudFile.modified).getTime();

      if (localModified < cloudModified) {
        // Cloud version is newer, update local metadata
        await dbService.saveCloudFile(cloudFile);
        result.resolved++;
      } else {
        // Local version is current
        result.validated++;
      }

      return result;
    } catch (error) {
      console.error(`Error validating file:`, error);
      result.errors++;
      return result;
    }
  }

  // Get cache entry information
  async getCacheInfo(): Promise<CacheEntryInfo[]> {
    const info: CacheEntryInfo[] = [];

    try {
      // Get all cards
      const cards = await dbService.getAllCards();
      for (const card of cards.cards) {
        if (card) {
          info.push({
            id: card.meta.id,
            type: 'card',
            lastModified: card.meta.modified,
            lastValidated: card.meta.modified, // For now, use modified time
            size: JSON.stringify(card).length,
            status: 'valid'
          });
        }
      }

      // Get all files
      const files = await dbService.getAllCloudFiles();
      for (const file of files.files) {
        if (file) {
          info.push({
            id: file.path,
            type: 'file',
            lastModified: new Date(file.modified).getTime(),
            lastValidated: new Date(file.modified).getTime(), // For now, use modified time
            size: file.size || 0,
            status: 'valid'
          });
        }
      }

      return info;
    } catch (error) {
      console.error('Error getting cache info:', error);
      return [];
    }
  }

  // Clean up stale entries
  async cleanupStaleEntries(maxAge?: number): Promise<number> {
    const maxAgeMs = maxAge || this.maxCacheAge;
    let removedCount = 0;

    try {
      // Get all cards
      const cards = await dbService.getAllCards();
      const now = Date.now();

      for (const card of cards.cards) {
        if (card) {
          const cardAge = now - card.meta.modified;
          if (cardAge > maxAgeMs) {
            await dbService.deleteCard(card.meta.id);
            removedCount++;
          }
        }
      }

      // Get all files
      const files = await dbService.getAllCloudFiles();

      for (const file of files.files) {
        if (file) {
          const fileAge = now - new Date(file.modified).getTime();
          if (fileAge > maxAgeMs) {
            await dbService.deleteCloudFile(file.path);
            removedCount++;
          }
        }
      }

      return removedCount;
    } catch (error) {
      console.error('Error cleaning up stale entries:', error);
      throw error;
    }
  }

  // Check cache size and storage quota
  async getCacheSizeInfo(): Promise<{
    totalSize: number;
    cardCount: number;
    fileCount: number;
    quotaInfo?: StorageEstimate;
  }> {
    try {
      let totalSize = 0;
      let cardCount = 0;
      let fileCount = 0;

      // Get all cards
      const cards = await dbService.getAllCards();
      for (const card of cards.cards) {
        if (card) {
          totalSize += JSON.stringify(card).length;
          cardCount++;
        }
      }

      // Get all files
      const files = await dbService.getAllCloudFiles();
      for (const file of files.files) {
        if (file) {
          totalSize += file.size || 0;
          fileCount++;
        }
      }

      // Try to get storage quota info
      let quotaInfo: StorageEstimate | undefined;
      if (navigator.storage && navigator.storage.estimate) {
        quotaInfo = await navigator.storage.estimate();
      }

      return { totalSize, cardCount, fileCount, quotaInfo };
    } catch (error) {
      console.error('Error getting cache size info:', error);
      return { totalSize: 0, cardCount: 0, fileCount: 0 };
    }
  }

  // Optimize cache (cleanup, validate, etc.)
  async optimizeCache(): Promise<CacheValidationResult> {
    const perfId = performanceMonitor.start('optimize-cache', 'cache');

    try {
      // Clean up stale entries
      const staleRemoved = await this.cleanupStaleEntries();

      // Validate remaining entries
      const validationResult = await this.validateCache({
        removeStale: true,
        resolveConflicts: true
      });

      // Add stale removal count to result
      validationResult.staleRemoved += staleRemoved;

      performanceMonitor.stop(perfId, true);
      return validationResult;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      performanceMonitor.stop(perfId, false, errorMessage);
      throw error;
    }
  }
}

// Export singleton instance
export const cacheManager = new CacheManager();
```

### Step 2: Enhance DBService with Cache Management Support
Modify the DBService to support cache management operations:

```typescript
// Enhanced DBService in src/lib/services/dbService.ts
import { retryOperation, withTimeout, categorizeIndexedDBError } from '../utils/indexeddbErrorHandler';
import { performanceMonitor } from '../utils/performanceMonitor';
import type { Card } from '../types';
import type { CloudFile } from '../types/cloud';

export class DBService {
  private db: IDBDatabase | null = null;
  private readonly DB_NAME = 'MarkdownCardsDB';
  private readonly VERSION = 1;
  private readonly CARDS_STORE = 'cards';
  private readonly FILES_STORE = 'files';
  private readonly METADATA_STORE = 'metadata'; // New store for cache metadata

  // ... existing code ...

  // Enhanced initialization with metadata store
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

  // Enhanced card operations with metadata tracking
  async saveCard(card: Card): Promise<{ success: boolean; error?: string; attempts?: number }> {
    // ... existing code ...

    try {
      // ... existing code ...

      // Also save metadata for cache management
      const metadata = {
        key: `card:${card.meta.id}`,
        type: 'card',
        lastModified: card.meta.modified,
        lastValidated: Date.now(),
        timestamp: Date.now()
      };

      await this.saveMetadata(metadata);

      // ... existing code ...
    } catch (error) {
      // ... existing code ...
    }
  }

  // Enhanced getCard with metadata update
  async getCard(id: string): Promise<{
    card: Card | null;
    error?: string;
    attempts?: number;
    fromCache?: boolean;
  }> {
    // ... existing code ...

    try {
      // ... existing code ...

      // Update last access time in metadata
      if (result.success && result.result) {
        const metadata = {
          key: `card:${id}`,
          type: 'card',
          lastModified: (result.result as Card).meta.modified,
          lastAccessed: Date.now(),
          timestamp: Date.now()
        };

        await this.saveMetadata(metadata);
      }

      // ... existing code ...
    } catch (error) {
      // ... existing code ...
    }
  }

  // New metadata operations for cache management
  async saveMetadata(metadata: any): Promise<{ success: boolean; error?: string }> {
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
            const transaction = db.transaction([this.METADATA_STORE], 'readwrite');
            const store = transaction.objectStore(this.METADATA_STORE);

            const request = store.put(metadata);
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

  async getMetadata(key: string): Promise<{ metadata: any; error?: string }> {
    if (!this.isBrowser()) {
      return { metadata: null };
    }

    if (!this.isInitialized) {
      const initResult = await this.init();
      if (!initResult.success) {
        return { metadata: null, error: initResult.error };
      }
    }

    const result = await retryOperation(
      async () => {
        return new Promise((resolve, reject) => {
          try {
            const db = this.getDb();
            const transaction = db.transaction([this.METADATA_STORE], 'readonly');
            const store = transaction.objectStore(this.METADATA_STORE);

            const request = store.get(key);
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
      metadata: result.success ? result.result : null,
      error: result.error ? categorizeIndexedDBError(result.error).message : undefined
    };
  }

  async getAllMetadata(): Promise<{ metadata: any[]; error?: string }> {
    if (!this.isBrowser()) {
      return { metadata: [] };
    }

    if (!this.isInitialized) {
      const initResult = await this.init();
      if (!initResult.success) {
        return { metadata: [], error: initResult.error };
      }
    }

    const result = await retryOperation(
      async () => {
        return new Promise((resolve, reject) => {
          try {
            const db = this.getDb();
            const transaction = db.transaction([this.METADATA_STORE], 'readonly');
            const store = transaction.objectStore(this.METADATA_STORE);

            const request = store.getAll();
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
      metadata: result.success ? result.result as any[] : [],
      error: result.error ? categorizeIndexedDBError(result.error).message : undefined
    };
  }

  // Enhanced clearAllData to also clear metadata
  async clearAllData(): Promise<{ success: boolean; error?: string; attempts?: number }> {
    if (!this.isBrowser()) {
      return { success: true, attempts: 1 };
    }

    if (!this.isInitialized) {
      const initResult = await this.init();
      if (!initResult.success) {
        return { success: false, error: initResult.error, attempts: 1 };
      }
    }

    const result = await retryOperation(
      async () => {
        return new Promise((resolve, reject) => {
          try {
            const db = this.getDb();
            const transaction = db.transaction([this.CARDS_STORE, this.FILES_STORE, this.METADATA_STORE], 'readwrite');
            const cardStore = transaction.objectStore(this.CARDS_STORE);
            const fileStore = transaction.objectStore(this.FILES_STORE);
            const metadataStore = transaction.objectStore(this.METADATA_STORE);

            const cardRequest = cardStore.clear();
            const fileRequest = fileStore.clear();
            const metadataRequest = metadataStore.clear();

            let completed = 0;
            const total = 3;
            let hadError = false;
            let errorMessage = '';

            const checkCompletion = () => {
              if (hadError) {
                reject(new Error(errorMessage));
              } else if (completed === total) {
                resolve(true);
              }
            };

            cardRequest.onsuccess = () => {
              completed++;
              checkCompletion();
            };

            cardRequest.onerror = () => {
              hadError = true;
              errorMessage = cardRequest.error ? cardRequest.error.message : 'Card clear error';
              checkCompletion();
            };

            fileRequest.onsuccess = () => {
              completed++;
              checkCompletion();
            };

            fileRequest.onerror = () => {
              hadError = true;
              errorMessage = fileRequest.error ? fileRequest.error.message : 'File clear error';
              checkCompletion();
            };

            metadataRequest.onsuccess = () => {
              completed++;
              checkCompletion();
            };

            metadataRequest.onerror = () => {
              hadError = true;
              errorMessage = metadataRequest.error ? metadataRequest.error.message : 'Metadata clear error';
              checkCompletion();
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
      success: result.success,
      error: result.error ? categorizeIndexedDBError(result.error).message : undefined,
      attempts: result.attempts
    };
  }
}
```

### Step 3: Enhance CloudStore with Cache Validation
Modify the cloudStore to integrate with cache management:

```typescript
// Enhanced cloudStore.ts with cache validation
import { writable, derived, get } from 'svelte/store';
import type { CloudFile, SyncStatus } from '../types/cloud';
import { cloudService } from '../services/cloudService';
import { dbService } from '../services/dbService';
import { parseMarkdown } from '../utils/markdownParser';
import type { Card } from '../types';
import { performanceMonitor } from '../utils/performanceMonitor';
import { cacheManager } from '../utils/cacheManager';

// ... existing code ...

// Enhanced sync status store with cache validation info
export const syncStatus = writable<SyncStatus & {
  lastValidation?: number;
  validationResult?: any;
}>({
  isSyncing: false,
  lastSync: null,
  error: null,
  lastValidation: null
});

// Cache validation status
export const cacheValidationStatus = writable<{
  isRunning: boolean;
  lastRun?: number;
  result?: any;
  error?: string;
}>({
  isRunning: false,
  lastRun: null
});

// Enhanced sync files from cloud with cache validation
export async function syncFilesFromCloud(): Promise<void> {
  // Check if we're authenticated
  const authStatus = get(isAuthenticated);
  if (!authStatus) {
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

// Manual cache validation function
export async function validateCache(options: any = {}): Promise<void> {
  cacheValidationStatus.set({ isRunning: true, lastRun: Date.now() });

  try {
    const validationResult = await cacheManager.validateCache(options);

    cacheValidationStatus.set({
      isRunning: false,
      lastRun: Date.now(),
      result: validationResult
    });

    // Update sync status with validation info
    syncStatus.update(status => ({
      ...status,
      lastValidation: Date.now(),
      validationResult
    }));
  } catch (error) {
    console.error('Error validating cache:', error);
    cacheValidationStatus.set({
      isRunning: false,
      lastRun: Date.now(),
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

// Cache optimization function
export async function optimizeCache(): Promise<void> {
  cacheValidationStatus.set({ isRunning: true, lastRun: Date.now() });

  try {
    const validationResult = await cacheManager.optimizeCache();

    cacheValidationStatus.set({
      isRunning: false,
      lastRun: Date.now(),
      result: validationResult
    });

    // Update sync status with optimization info
    syncStatus.update(status => ({
      ...status,
      lastValidation: Date.now(),
      validationResult
    }));
  } catch (error) {
    console.error('Error optimizing cache:', error);
    cacheValidationStatus.set({
      isRunning: false,
      lastRun: Date.now(),
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

// Get cache information for UI
export async function getCacheInfo() {
  return await cacheManager.getCacheInfo();
}

// Get cache size information
export async function getCacheSizeInfo() {
  return await cacheManager.getCacheSizeInfo();
}
```

### Step 4: Add Cache Management UI
Create a component to display cache management information and controls:

```svelte
<!-- src/lib/components/CacheManager.svelte -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    cacheValidationStatus,
    validateCache,
    optimizeCache,
    getCacheInfo,
    getCacheSizeInfo
  } from '$lib/stores/cloudStore';

  let validationStatus = {
    isRunning: false,
    lastRun: null,
    result: null,
    error: null
  };

  let cacheInfo = [];
  let cacheSizeInfo = { totalSize: 0, cardCount: 0, fileCount: 0, quotaInfo: null };
  let refreshInterval: number;

  // Update cache information periodically
  async function updateCacheInfo() {
    try {
      cacheInfo = await getCacheInfo();
      cacheSizeInfo = await getCacheSizeInfo();
    } catch (error) {
      console.error('Error updating cache info:', error);
    }
  }

  // Handle manual cache validation
  async function handleValidateCache() {
    try {
      await validateCache({ removeStale: true, resolveConflicts: true });
    } catch (error) {
      console.error('Error validating cache:', error);
    }
  }

  // Handle cache optimization
  async function handleOptimizeCache() {
    try {
      await optimizeCache();
    } catch (error) {
      console.error('Error optimizing cache:', error);
    }
  }

  onMount(() => {
    // Subscribe to validation status updates
    const unsubscribe = cacheValidationStatus.subscribe(status => {
      validationStatus = status;
    });

    // Update cache info initially and periodically
    updateCacheInfo();
    refreshInterval = setInterval(updateCacheInfo, 30000); // Every 30 seconds

    return () => {
      unsubscribe();
      if (refreshInterval) {
        clearInterval(refreshInterval);
      }
    };
  });
</script>

<div class="cache-manager">
  <div class="header">
    <h3>Cache Management</h3>
    <div class="actions">
      <button
        class="action-button"
        on:click={handleValidateCache}
        disabled={validationStatus.isRunning}
      >
        {validationStatus.isRunning ? 'Validating...' : 'Validate Cache'}
      </button>
      <button
        class="action-button optimize"
        on:click={handleOptimizeCache}
        disabled={validationStatus.isRunning}
      >
        {validationStatus.isRunning ? 'Optimizing...' : 'Optimize Cache'}
      </button>
    </div>
  </div>

  <!-- Validation Status -->
  <div class="validation-status">
    <h4>Validation Status</h4>
    {#if validationStatus.isRunning}
      <div class="status running">
        <span class="spinner">↻</span>
        Cache validation in progress...
      </div>
    {:else if validationStatus.lastRun}
      <div class="status completed">
        Last validation: {new Date(validationStatus.lastRun).toLocaleString()}
        {#if validationStatus.result}
          <div class="result-summary">
            <span>Validated: {validationStatus.result.validated}</span>
            <span>Conflicts: {validationStatus.result.conflicts}</span>
            <span>Resolved: {validationStatus.result.resolved}</span>
            <span>Stale Removed: {validationStatus.result.staleRemoved}</span>
            <span>Errors: {validationStatus.result.errors}</span>
          </div>
        {/if}
      </div>
    {/if}

    {#if validationStatus.error}
      <div class="status error">
        Error: {validationStatus.error}
      </div>
    {/if}
  </div>

  <!-- Cache Size Information -->
  <div class="cache-size">
    <h4>Cache Size</h4>
    <div class="size-info">
      <div class="size-item">
        <span class="label">Total Size:</span>
        <span class="value">{(cacheSizeInfo.totalSize / 1024 / 1024).toFixed(2)} MB</span>
      </div>
      <div class="size-item">
        <span class="label">Cards:</span>
        <span class="value">{cacheSizeInfo.cardCount}</span>
      </div>
      <div class="size-item">
        <span class="label">Files:</span>
        <span class="value">{cacheSizeInfo.fileCount}</span>
      </div>
      {#if cacheSizeInfo.quotaInfo}
        <div class="size-item">
          <span class="label">Quota Used:</span>
          <span class="value">
            {cacheSizeInfo.quotaInfo.usage ? (cacheSizeInfo.quotaInfo.usage / 1024 / 1024).toFixed(2) : '0'} MB
          </span>
        </div>
        <div class="size-item">
          <span class="label">Quota Available:</span>
          <span class="value">
            {cacheSizeInfo.quotaInfo.quota ? (cacheSizeInfo.quota / 1024 / 1024).toFixed(2) : 'Unknown'} MB
          </span>
        </div>
      {/if}
    </div>
  </div>

  <!-- Cache Entries -->
  <div class="cache-entries">
    <h4>Cache Entries ({cacheInfo.length})</h4>
    {#if cacheInfo.length > 0}
      <div class="entries-list">
        {#each cacheInfo as entry}
          <div class="entry-item {entry.status}">
            <div class="entry-header">
              <span class="entry-id">{entry.id}</span>
              <span class="entry-type">{entry.type}</span>
              <span class="entry-status {entry.status}">{entry.status}</span>
            </div>
            <div class="entry-details">
              <span>Modified: {new Date(entry.lastModified).toLocaleString()}</span>
              <span>Size: {(entry.size / 1024).toFixed(2)} KB</span>
              {#if entry.cloudModified}
                <span>Cloud Modified: {new Date(entry.cloudModified).toLocaleString()}</span>
              {/if}
            </div>
            {#if entry.conflictDetails}
              <div class="conflict-details">
                Conflict: {entry.conflictDetails}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {:else}
      <div class="no-entries">
        No cache entries found
      </div>
    {/if}
  </div>
</div>

<style>
  .cache-manager {
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

  .action-button.optimize {
    background-color: #28a745;
  }

  .action-button.optimize:hover:not(:disabled) {
    background-color: #1e7e34;
  }

  .validation-status {
    margin-bottom: 1.5rem;
  }

  .validation-status h4 {
    margin-top: 0;
    margin-bottom: 0.5rem;
    color: #495057;
  }

  .status {
    padding: 0.75rem;
    border-radius: 4px;
    margin-bottom: 0.5rem;
  }

  .status.running {
    background-color: #cce5ff;
    color: #004085;
  }

  .status.completed {
    background-color: #d4edda;
    color: #155724;
  }

  .status.error {
    background-color: #f8d7da;
    color: #721c24;
  }

  .spinner {
    display: inline-block;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }

  .result-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    margin-top: 0.5rem;
    font-size: 0.9rem;
  }

  .cache-size {
    margin-bottom: 1.5rem;
  }

  .cache-size h4 {
    margin-top: 0;
    margin-bottom: 0.5rem;
    color: #495057;
  }

  .size-info {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
  }

  .size-item {
    display: flex;
    justify-content: space-between;
    padding: 0.5rem;
    background-color: white;
    border: 1px solid #dee2e6;
    border-radius: 4px;
  }

  .label {
    color: #6c757d;
  }

  .value {
    font-weight: 500;
    color: #495057;
  }

  .cache-entries h4 {
    margin-top: 0;
    margin-bottom: 0.5rem;
    color: #495057;
  }

  .entries-list {
    max-height: 300px;
    overflow-y: auto;
    border: 1px solid #dee2e6;
    border-radius: 4px;
  }

  .entry-item {
    padding: 0.75rem;
    border-bottom: 1px solid #dee2e6;
  }

  .entry-item:last-child {
    border-bottom: none;
  }

  .entry-item.valid {
    background-color: #d4edda;
  }

  .entry-item.stale {
    background-color: #fff3cd;
  }

  .entry-item.conflict {
    background-color: #f8d7da;
  }

  .entry-item.error {
    background-color: #f8d7da;
  }

  .entry-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.25rem;
  }

  .entry-id {
    font-weight: 500;
    color: #495057;
  }

  .entry-type {
    font-size: 0.8rem;
    color: #6c757d;
  }

  .entry-status {
    font-size: 0.8rem;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    text-transform: uppercase;
  }

  .entry-status.valid {
    background-color: #28a745;
    color: white;
  }

  .entry-status.stale {
    background-color: #ffc107;
    color: #212529;
  }

  .entry-status.conflict {
    background-color: #dc3545;
    color: white;
  }

  .entry-status.error {
    background-color: #dc3545;
    color: white;
  }

  .entry-details {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    font-size: 0.85rem;
    color: #6c757d;
  }

  .conflict-details {
    margin-top: 0.25rem;
    padding: 0.25rem;
    background-color: rgba(220, 53, 69, 0.1);
    border-radius: 4px;
    font-size: 0.8rem;
    color: #721c24;
  }

  .no-entries {
    padding: 1rem;
    text-align: center;
    color: #6c757d;
    font-style: italic;
  }
</style>
```

### Step 5: Integrate Cache Management with Application Lifecycle
Add cache management to the application's main lifecycle:

```typescript
// src/lib/stores/appStore.ts
import { cacheManager } from '../utils/cacheManager';
import { onMount } from 'svelte';

// Initialize cache management when app starts
export function initializeCacheManagement() {
  // Start periodic cache validation
  cacheManager.startPeriodicValidation();

  // Validate cache on app start
  cacheManager.validateCache({ removeStale: true, resolveConflicts: true });

  // Validate cache when network status changes
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      cacheManager.validateCache({ removeStale: true, resolveConflicts: true });
    });
  }
}

// Clean up cache management when app is destroyed
export function cleanupCacheManagement() {
  cacheManager.stopPeriodicValidation();
}

// Usage in main app component
// onMount(() => {
//   initializeCacheManagement();
//
//   return () => {
//     cleanupCacheManagement();
//   };
// });
```

## Performance Considerations
1. **Batch Processing**: Process cache validation in batches to avoid blocking UI
2. **Background Tasks**: Run validation tasks in background with minimal impact
3. **Smart Scheduling**: Schedule validation during low-activity periods
4. **Incremental Validation**: Validate only changed or recently accessed entries

## Error Handling
1. **Graceful Degradation**: Continue functioning even if cache validation fails
2. **Retry Logic**: Retry failed validation operations with exponential backoff
3. **Error Reporting**: Log validation errors for debugging
4. **User Feedback**: Inform users of validation issues without disrupting workflow

## Testing Plan
1. **Unit Tests**: Test cache validation logic and conflict resolution
2. **Integration Tests**: Test full cache management workflows
3. **Conflict Tests**: Test various conflict scenarios and resolution strategies
4. **Performance Tests**: Measure impact of validation on application performance
5. **Edge Case Tests**: Test behavior with large caches and limited storage

## Success Metrics
1. **Validation Coverage**: > 95% of cache entries validated regularly
2. **Conflict Resolution**: > 90% of conflicts automatically resolved
3. **Stale Entry Removal**: > 99% of stale entries removed within max age
4. **Performance Impact**: < 5% impact on normal application operations
5. **User Experience**: Clear feedback and minimal disruption during validation
