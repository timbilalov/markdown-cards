# Performance Monitoring for IndexedDB and Cloud Operations

## Overview
This document details the implementation approach for adding comprehensive performance monitoring to track load times for both IndexedDB and cloud operations. The implementation will provide insights into data access performance, help identify bottlenecks, and enable optimization of data access strategies.

## Current Implementation Analysis
The current application has minimal performance monitoring:
1. Some basic console logging of operation times
2. No structured performance tracking
3. No performance metrics collection
4. No performance thresholds or alerts
5. No user-facing performance indicators

However, there are several areas for improvement:
- No centralized performance monitoring system
- No performance data persistence
- No performance trend analysis
- No performance-based optimization decisions
- No user feedback on performance

## Enhanced Implementation Plan

### 1. Performance Metrics Collection
Implement comprehensive metrics collection for:
1. IndexedDB operation times (read, write, delete)
2. Cloud operation times (API calls, data transfer)
3. Cache hit/miss ratios
4. Sync operation performance
5. Overall page load times

### 2. Performance Thresholds and Alerts
Implement performance monitoring with thresholds:
1. IndexedDB operations: < 100ms target
2. Cloud operations: < 1000ms target
3. Cache hit rate: > 80% target
4. Error rates: < 1% target

### 3. Performance Data Persistence
Implement performance data storage:
1. In-memory storage for real-time metrics
2. IndexedDB storage for historical data
3. Aggregated metrics for trend analysis
4. Export capabilities for detailed analysis

### 4. User Feedback and Visualization
Implement user-facing performance indicators:
1. Real-time performance status
2. Performance trend visualization
3. Performance alerts and recommendations
4. Developer tools integration

## Implementation Steps

### Step 1: Create Performance Monitoring Utilities
Create utility functions for performance monitoring:

```typescript
// src/lib/utils/performanceMonitor.ts
export interface PerformanceMetric {
  id: string;
  operation: string;
  category: 'indexeddb' | 'cloud' | 'cache' | 'sync' | 'ui';
  duration: number; // in milliseconds
  timestamp: number; // Unix timestamp
  success: boolean;
  error?: string;
  metadata?: Record<string, any>;
}

export interface PerformanceSummary {
  averageDuration: number;
  minDuration: number;
  maxDuration: number;
  successRate: number;
  totalOperations: number;
  errorCount: number;
  lastError?: string;
}

export interface PerformanceThresholds {
  indexeddb: {
    read: number;    // ms
    write: number;   // ms
    delete: number;  // ms
  };
  cloud: {
    api: number;     // ms
    download: number; // ms
    upload: number;   // ms
  };
  cache: {
    hitRate: number; // percentage (0-100)
  };
}

export class PerformanceMonitor {
  private metrics: PerformanceMetric[] = [];
  private maxMetrics = 1000; // Limit stored metrics to prevent memory issues
  private thresholds: PerformanceThresholds = {
    indexeddb: {
      read: 100,
      write: 100,
      delete: 100
    },
    cloud: {
      api: 1000,
      download: 2000,
      upload: 2000
    },
    cache: {
      hitRate: 80
    }
  };

  // Start timing an operation
  start(operation: string, category: PerformanceMetric['category'], metadata?: Record<string, any>): string {
    const id = `${operation}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Create a metric entry
    const metric: PerformanceMetric = {
      id,
      operation,
      category,
      duration: -1, // Placeholder, will be updated when stop is called
      timestamp: Date.now(),
      success: false, // Placeholder
      metadata
    };

    // Add to metrics array
    this.addMetric(metric);

    return id;
  }

  // Stop timing an operation
  stop(id: string, success: boolean = true, error?: string): PerformanceMetric | null {
    const metric = this.metrics.find(m => m.id === id);
    if (!metric) {
      console.warn(`Performance metric with id ${id} not found`);
      return null;
    }

    // Update the metric with actual duration and result
    metric.duration = Date.now() - metric.timestamp;
    metric.success = success;
    if (error) {
      metric.error = error;
    }

    console.log(`Performance: ${metric.operation} (${metric.category}) took ${metric.duration}ms ${success ? 'SUCCESS' : 'FAILED'}`);

    // Check if performance is within thresholds
    this.checkThresholds(metric);

    return metric;
  }

  // Record a metric directly (for operations that don't need timing)
  record(
    operation: string,
    category: PerformanceMetric['category'],
    duration: number,
    success: boolean = true,
    error?: string,
    metadata?: Record<string, any>
  ): PerformanceMetric {
    const metric: PerformanceMetric = {
      id: `${operation}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      operation,
      category,
      duration,
      timestamp: Date.now(),
      success,
      error,
      metadata
    };

    this.addMetric(metric);
    console.log(`Performance: ${metric.operation} (${metric.category}) took ${metric.duration}ms ${success ? 'SUCCESS' : 'FAILED'}`);

    // Check if performance is within thresholds
    this.checkThresholds(metric);

    return metric;
  }

  // Add a metric to the collection
  private addMetric(metric: PerformanceMetric) {
    this.metrics.push(metric);

    // Limit the number of stored metrics
    if (this.metrics.length > this.maxMetrics) {
      this.metrics.shift(); // Remove oldest metric
    }
  }

  // Check if a metric exceeds performance thresholds
  private checkThresholds(metric: PerformanceMetric) {
    let threshold: number | undefined;

    if (metric.category === 'indexeddb') {
      if (metric.operation.includes('get') || metric.operation.includes('read')) {
        threshold = this.thresholds.indexeddb.read;
      } else if (metric.operation.includes('save') || metric.operation.includes('put') || metric.operation.includes('write')) {
        threshold = this.thresholds.indexeddb.write;
      } else if (metric.operation.includes('delete')) {
        threshold = this.thresholds.indexeddb.delete;
      }
    } else if (metric.category === 'cloud') {
      if (metric.operation.includes('download') || metric.operation.includes('get')) {
        threshold = this.thresholds.cloud.download;
      } else if (metric.operation.includes('upload') || metric.operation.includes('save') || metric.operation.includes('put')) {
        threshold = this.thresholds.cloud.upload;
      } else {
        threshold = this.thresholds.cloud.api;
      }
    }

    // If we have a threshold and the operation was successful but slow
    if (threshold && metric.success && metric.duration > threshold) {
      console.warn(`Performance warning: ${metric.operation} (${metric.category}) took ${metric.duration}ms, threshold is ${threshold}ms`);
    }

    // If the operation failed
    if (!metric.success) {
      console.error(`Performance error: ${metric.operation} (${metric.category}) failed after ${metric.duration}ms: ${metric.error}`);
    }
  }

  // Get metrics for a specific operation or category
  getMetrics(filter?: { operation?: string; category?: PerformanceMetric['category']; limit?: number }): PerformanceMetric[] {
    let filteredMetrics = this.metrics;

    if (filter?.operation) {
      filteredMetrics = filteredMetrics.filter(m => m.operation === filter.operation);
    }

    if (filter?.category) {
      filteredMetrics = filteredMetrics.filter(m => m.category === filter.category);
    }

    if (filter?.limit) {
      filteredMetrics = filteredMetrics.slice(-filter.limit);
    }

    return filteredMetrics;
  }

  // Get performance summary for a specific operation or category
  getSummary(filter?: { operation?: string; category?: PerformanceMetric['category'] }): PerformanceSummary {
    const metrics = this.getMetrics(filter);

    if (metrics.length === 0) {
      return {
        averageDuration: 0,
        minDuration: 0,
        maxDuration: 0,
        successRate: 100,
        totalOperations: 0,
        errorCount: 0
      };
    }

    const successfulMetrics = metrics.filter(m => m.success);
    const failedMetrics = metrics.filter(m => !m.success);

    const durations = successfulMetrics.map(m => m.duration);
    const averageDuration = durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
    const minDuration = Math.min(...durations);
    const maxDuration = Math.max(...durations);
    const successRate = (successfulMetrics.length / metrics.length) * 100;

    return {
      averageDuration,
      minDuration,
      maxDuration,
      successRate,
      totalOperations: metrics.length,
      errorCount: failedMetrics.length,
      lastError: failedMetrics.length > 0 ? failedMetrics[failedMetrics.length - 1].error : undefined
    };
  }

  // Get cache hit rate
  getCacheHitRate(): number {
    const cacheMetrics = this.metrics.filter(m => m.category === 'cache');
    if (cacheMetrics.length === 0) return 100; // Assume 100% if no cache operations

    const hitMetrics = cacheMetrics.filter(m => m.metadata?.hit === true);
    return (hitMetrics.length / cacheMetrics.length) * 100;
  }

  // Clear all metrics
  clear() {
    this.metrics = [];
  }

  // Export metrics for analysis
  export(): PerformanceMetric[] {
    return [...this.metrics]; // Return a copy
  }

  // Set performance thresholds
  setThresholds(thresholds: Partial<PerformanceThresholds>) {
    this.thresholds = {
      ...this.thresholds,
      ...thresholds
    };
  }

  // Get current thresholds
  getThresholds(): PerformanceThresholds {
    return { ...this.thresholds };
  }
}

// Export singleton instance
export const performanceMonitor = new PerformanceMonitor();
```

### Step 2: Enhance DBService with Performance Monitoring
Modify the DBService to use the performance monitoring utilities:

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

  // Availability status tracking
  private isAvailable: boolean | null = null;
  private availabilityError: string | null = null;
  private isInitialized = false;

  // Check if we're in a browser environment
  private isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
  }

  // Enhanced initialization with performance monitoring
  async init(): Promise<{ success: boolean; error?: string }> {
    // Skip initialization on server-side
    if (!this.isBrowser()) {
      this.isInitialized = false;
      return { success: true }; // Not an error, just not applicable
    }

    const perfId = performanceMonitor.start('db-init', 'indexeddb', { dbName: this.DB_NAME });

    try {
      // Use retry logic for database initialization
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

      if (result.success) {
        this.isAvailable = true;
        this.availabilityError = null;
        performanceMonitor.stop(perfId, true);
        return { success: true };
      } else {
        this.isInitialized = false;
        const errorInfo = categorizeIndexedDBError(result.error);
        this.availabilityError = `Initialization failed: ${errorInfo.message}`;
        performanceMonitor.stop(perfId, false, errorInfo.message);
        return { success: false, error: errorInfo.message };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      performanceMonitor.stop(perfId, false, errorMessage);
      throw error;
    }
  }

  // Enhanced getDb method with better error handling
  private getDb(): IDBDatabase {
    if (!this.isBrowser()) {
      throw new Error('Database operations not available on server-side');
    }

    if (!this.isInitialized) {
      throw new Error('Database not initialized. Call init() first.');
    }

    if (!this.db) {
      throw new Error('Database connection lost');
    }

    return this.db;
  }

  // Enhanced card operations with performance monitoring
  async saveCard(card: Card): Promise<{ success: boolean; error?: string; attempts?: number }> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return { success: true, attempts: 1 };
    }

    const perfId = performanceMonitor.start('save-card', 'indexeddb', { cardId: card.meta.id });

    try {
      // Check if database is available and initialized
      if (!this.isInitialized) {
        const initResult = await this.init();
        if (!initResult.success) {
          performanceMonitor.stop(perfId, false, initResult.error);
          return { success: false, error: initResult.error, attempts: 1 };
        }
      }

      // Use retry logic for save operation
      const result = await retryOperation(
        async () => {
          return new Promise((resolve, reject) => {
            try {
              const db = this.getDb();
              const transaction = db.transaction([this.CARDS_STORE], 'readwrite');
              const store = transaction.objectStore(this.CARDS_STORE);

              const request = store.put(card);
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
        3, // Max 3 retries
        100, // 100ms base delay
        3000 // 3 second max delay
      );

      performanceMonitor.stop(perfId, result.success, result.error);

      return {
        success: result.success,
        error: result.error ? categorizeIndexedDBError(result.error).message : undefined,
        attempts: result.attempts
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      performanceMonitor.stop(perfId, false, errorMessage);
      throw error;
    }
  }

  async getCard(id: string): Promise<{
    card: Card | null;
    error?: string;
    attempts?: number;
    fromCache?: boolean;
  }> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return { card: null, attempts: 1, fromCache: false };
    }

    const perfId = performanceMonitor.start('get-card', 'indexeddb', { cardId: id });

    try {
      // Check if database is available and initialized
      if (!this.isInitialized) {
        const initResult = await this.init();
        if (!initResult.success) {
          performanceMonitor.stop(perfId, false, initResult.error);
          return { card: null, error: initResult.error, attempts: 1, fromCache: false };
        }
      }

      // Use retry logic for get operation
      const result = await retryOperation(
        async () => {
          return new Promise((resolve, reject) => {
            try {
              const db = this.getDb();
              const transaction = db.transaction([this.CARDS_STORE], 'readonly');
              const store = transaction.objectStore(this.CARDS_STORE);

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
        2, // Max 2 retries for read operations
        50, // 50ms base delay
        2000 // 2 second max delay
      );

      performanceMonitor.stop(perfId, result.success, result.error);

      return {
        card: result.success ? result.result as Card | null : null,
        error: result.error ? categorizeIndexedDBError(result.error).message : undefined,
        attempts: result.attempts,
        fromCache: false // This would be true if we had a memory cache layer
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      performanceMonitor.stop(perfId, false, errorMessage);
      throw error;
    }
  }

  async getAllCards(): Promise<{
    cards: Card[];
    error?: string;
    attempts?: number;
    fromCache?: boolean;
  }> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return { cards: [], attempts: 1, fromCache: false };
    }

    const perfId = performanceMonitor.start('get-all-cards', 'indexeddb');

    try {
      // Check if database is available and initialized
      if (!this.isInitialized) {
        const initResult = await this.init();
        if (!initResult.success) {
          performanceMonitor.stop(perfId, false, initResult.error);
          return { cards: [], error: initResult.error, attempts: 1, fromCache: false };
        }
      }

      // Use retry logic for get all operation
      const result = await retryOperation(
        async () => {
          return new Promise((resolve, reject) => {
            try {
              const db = this.getDb();
              const transaction = db.transaction([this.CARDS_STORE], 'readonly');
              const store = transaction.objectStore(this.CARDS_STORE);

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
        2, // Max 2 retries
        100, // 100ms base delay
        5000 // 5 second max delay
      );

      performanceMonitor.stop(perfId, result.success, result.error);

      return {
        cards: result.success ? result.result as Card[] : [],
        error: result.error ? categorizeIndexedDBError(result.error).message : undefined,
        attempts: result.attempts,
        fromCache: false
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      performanceMonitor.stop(perfId, false, errorMessage);
      throw error;
    }
  }

  // Similar enhancements for other methods...
  // deleteCard, saveCloudFile, getCloudFile, getAllCloudFiles, deleteCloudFile, clearAllData
}
```

### Step 3: Enhance CloudService with Performance Monitoring
Modify the CloudService to use the performance monitoring utilities:

```typescript
// Enhanced CloudService in src/lib/services/cloudService.ts
import type { CloudFileListResponse, CloudUploadUrlResponse } from '../types/cloud';
import { dbService } from './dbService';
import { performanceMonitor } from '../utils/performanceMonitor';

export class CloudService {
  private readonly API_BASE = 'https://cloud-api.yandex.net/v1/disk';
  private accessToken: string | null = null;
  private basePath: string = 'md-cards';

  constructor() {
    // Initialize with the token from environment variables
    if (typeof window !== 'undefined') {
      // Client-side: get from Vite environment variables
      this.accessToken = import.meta.env.VITE_YANDEX_DISK_TOKEN || null;
    } else {
      // Server-side: get from process.env
      this.accessToken = process.env.VITE_YANDEX_DISK_TOKEN || null;
    }
  }

  // This method is kept for backward compatibility but will only work on the client side
  setAccessToken(token: string | null): void {
    if (typeof window !== 'undefined') {
      this.accessToken = token;
    }
  }

  setBasePath(path: string): void {
    this.basePath = path;
  }

  private getHeaders(): HeadersInit {
    const headers: HeadersInit = {
      'Accept': 'application/json',
    };

    if (this.accessToken) {
      headers['Authorization'] = `OAuth ${this.accessToken}`;
    }

    return headers;
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
  }

  // Enhanced fetch list of files from Yandex Disk
  async listFiles(): Promise<CloudFileListResponse> {
    if (!this.accessToken) {
      throw new Error('Access token not set');
    }

    const perfId = performanceMonitor.start('list-cloud-files', 'cloud', { basePath: this.basePath });

    try {
      const url = `${this.API_BASE}/resources?path=${encodeURIComponent(this.basePath)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders()
      });

      const data = await this.handleResponse<CloudFileListResponse>(response);

      // Cache the file list in IndexedDB
      for (const file of data._embedded.items) {
        await dbService.saveCloudFile(file);
      }

      performanceMonitor.stop(perfId, true);

      return data;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      performanceMonitor.stop(perfId, false, errorMessage);
      throw error;
    }
  }

  // Enhanced download file content from Yandex Disk
  async downloadFile(fileUrl: string): Promise<string> {
    if (!this.accessToken) {
      throw new Error('Access token not set');
    }

    const perfId = performanceMonitor.start('download-cloud-file', 'cloud');

    try {
      const response = await fetch(fileUrl, {
        method: 'GET',
        headers: this.getHeaders()
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const content = await response.text();
      performanceMonitor.stop(perfId, true);
      return content;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      performanceMonitor.stop(perfId, false, errorMessage);
      throw error;
    }
  }

  // Enhanced get upload URL from Yandex Disk
  async getUploadUrl(filePath: string, overwrite: boolean = true): Promise<CloudUploadUrlResponse> {
    if (!this.accessToken) {
      throw new Error('Access token not set');
    }

    const perfId = performanceMonitor.start('get-upload-url', 'cloud', { filePath, overwrite });

    try {
      const fullPath = `${this.basePath}/${filePath}`;
      const url = `${this.API_BASE}/resources/upload?path=${encodeURIComponent(fullPath)}&overwrite=${overwrite}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders()
      });

      const data = await this.handleResponse<CloudUploadUrlResponse>(response);
      performanceMonitor.stop(perfId, true);
      return data;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      performanceMonitor.stop(perfId, false, errorMessage);
      throw error;
    }
  }

  // Enhanced upload file content to Yandex Disk
  async uploadFile(uploadUrl: string, fileContent: string): Promise<void> {
    if (!this.accessToken) {
      throw new Error('Access token not set');
    }

    const perfId = performanceMonitor.start('upload-file', 'cloud', { contentLength: fileContent.length });

    try {
      const response = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `OAuth ${this.accessToken}`,
          'Content-Type': 'text/plain'
        },
        body: fileContent
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      performanceMonitor.stop(perfId, true);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      performanceMonitor.stop(perfId, false, errorMessage);
      throw error;
    }
  }

  // Check if we're authenticated
  isAuthenticated(): boolean {
    return !!this.accessToken;
  }
}
```

### Step 4: Enhance Stores with Performance Monitoring
Modify the stores to use the performance monitoring utilities:

```typescript
// Enhanced cloudStore.ts with performance monitoring
import { writable, derived, get } from 'svelte/store';
import type { CloudFile, SyncStatus } from '../types/cloud';
import { cloudService } from '../services/cloudService';
import { dbService } from '../services/dbService';
import { parseMarkdown } from '../utils/markdownParser';
import type { Card } from '../types';
import { performanceMonitor } from '../utils/performanceMonitor';

// Cloud file list store
export const cloudFiles = writable<CloudFile[]>([]);

// Sync status store
export const syncStatus = writable<SyncStatus>({
  isSyncing: false,
  lastSync: null,
  error: null
});

// Authentication status
export const isAuthenticated = writable<boolean>(false);

// Performance metrics store
export const performanceMetrics = writable<{
  indexeddb: any;
  cloud: any;
  cache: any;
}>({
  indexeddb: {},
  cloud: {},
  cache: {}
});

// Initialize authentication status based on cloud service
if (typeof window !== 'undefined') {
  isAuthenticated.set(cloudService.isAuthenticated());
}

// Enhanced load files from IndexedDB cache
export async function loadCachedFiles(): Promise<void> {
  const perfId = performanceMonitor.start('load-cached-files', 'cache');

  try {
    const files = await dbService.getAllCloudFiles();
    cloudFiles.set(files);
    performanceMonitor.stop(perfId, true);
  } catch (error) {
    console.error('Error loading cached files:', error);
    performanceMonitor.stop(perfId, false, error instanceof Error ? error.message : 'Unknown error');
  }
}

// Enhanced sync files from cloud
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
    syncStatus.update(status => ({
      ...status,
      isSyncing: false,
      lastSync: Date.now(),
      error: null
    }));

    performanceMonitor.stop(perfId, true);
  } catch (error) {
    console.error('Error syncing files from cloud:', error);
    syncStatus.update(status => ({
      ...status,
      isSyncing: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }));

    performanceMonitor.stop(perfId, false, error instanceof Error ? error.message : 'Unknown error');
  }
}

// Enhanced load a card from cloud with local caching
export async function loadCardFromCloud(file: CloudFile): Promise<Card | null> {
  const perfId = performanceMonitor.start('load-card-from-cloud', 'sync', {
    fileName: file.name,
    fileSize: file.size
  });

  try {
    // First check if we have it in local cache
    const cachedStartTime = performance.now();
    const cachedCard = await dbService.getCard(file.name.replace('.md', ''));
    const cacheCheckTime = performance.now() - cachedStartTime;

    if (cachedCard) {
      // Check if the cached version is up to date
      const cachedModified = new Date(cachedCard.meta.modified).getTime();
      const cloudModified = new Date(file.modified).getTime();

      if (cachedModified >= cloudModified) {
        performanceMonitor.record('cache-hit', 'cache', cacheCheckTime, true, undefined, { hit: true });
        performanceMonitor.stop(perfId, true);
        return cachedCard;
      } else {
        performanceMonitor.record('cache-miss', 'cache', cacheCheckTime, true, undefined, { hit: false });
      }
    } else {
      performanceMonitor.record('cache-miss', 'cache', cacheCheckTime, true, undefined, { hit: false });
    }

    // If not in cache or outdated, download from cloud
    const downloadStartTime = performance.now();
    const response = await fetch(`/api/cloud/download?path=${encodeURIComponent(file.path)}`);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const content = await response.text();
    const downloadTime = performance.now() - downloadStartTime;
    performanceMonitor.record('cloud-download', 'cloud', downloadTime, true);

    const parseStartTime = performance.now();
    const card = parseMarkdown(content);
    const parseTime = performance.now() - parseStartTime;
    performanceMonitor.record('parse-markdown', 'ui', parseTime, true);

    // Cache it locally
    const cacheStartTime = performance.now();
    await dbService.saveCard(card);
    const cacheTime = performance.now() - cacheStartTime;
    performanceMonitor.record('cache-save', 'cache', cacheTime, true);

    performanceMonitor.stop(perfId, true);
    return card;
  } catch (error) {
    console.error('Error loading card from cloud:', error);
    performanceMonitor.stop(perfId, false, error instanceof Error ? error.message : 'Unknown error');
    return null;
  }
}

// Enhanced save a card to both local cache and cloud
export async function saveCardToCloud(card: Card, filename: string): Promise<boolean> {
  const perfId = performanceMonitor.start('save-card-to-cloud', 'sync', {
    fileName: filename
  });

  try {
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
    return false;
  }
}

// Add function to get performance summaries for UI
export function getPerformanceSummaries() {
  return {
    indexeddb: performanceMonitor.getSummary({ category: 'indexeddb' }),
    cloud: performanceMonitor.getSummary({ category: 'cloud' });
    cache: {
      ...performanceMonitor.getSummary({ category: 'cache' }),
      hitRate: performanceMonitor.getCacheHitRate()
    },
    sync: performanceMonitor.getSummary({ category: 'sync' })
  };
}

// Add function to export performance data
export function exportPerformanceData() {
  return performanceMonitor.export();
}
```

### Step 5: Add Performance Monitoring UI
Create a component to display performance metrics to users:

```svelte
<!-- src/lib/components/PerformanceMonitor.svelte -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { performanceMetrics, getPerformanceSummaries } from '$lib/stores/cloudStore';

  let metrics = {
    indexeddb: {},
    cloud: {},
    cache: {},
    sync: {}
  };

  let refreshInterval: number;

  // Update metrics periodically
  function updateMetrics() {
    metrics = getPerformanceSummaries();
  }

  onMount(() => {
    updateMetrics();
    // Refresh metrics every 5 seconds
    refreshInterval = setInterval(updateMetrics, 5000);
  });

  onDestroy(() => {
    if (refreshInterval) {
      clearInterval(refreshInterval);
    }
  });

  // Function to export performance data
  function exportData() {
    const data = exportPerformanceData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `performance-data-${new Date().toISOString()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
</script>

<div class="performance-monitor">
  <div class="header">
    <h3>Performance Monitor</h3>
    <button class="export-button" on:click={exportData}>Export Data</button>
  </div>

  <div class="metrics-grid">
    <!-- IndexedDB Metrics -->
    <div class="metric-card">
      <h4>IndexedDB Operations</h4>
      <div class="metric">
        <span class="label">Average Time:</span>
        <span class="value">{metrics.indexeddb.averageDuration?.toFixed(2) || '0'}ms</span>
      </div>
      <div class="metric">
        <span class="label">Success Rate:</span>
        <span class="value">{metrics.indexeddb.successRate?.toFixed(1) || '100'}%</span>
      </div>
      <div class="metric">
        <span class="label">Total Operations:</span>
        <span class="value">{metrics.indexeddb.totalOperations || 0}</span>
      </div>
      {#if metrics.indexeddb.averageDuration > 100}
        <div class="warning">⚠️ Performance below target (< 100ms)</div>
      {/if}
    </div>

    <!-- Cloud Metrics -->
    <div class="metric-card">
      <h4>Cloud Operations</h4>
      <div class="metric">
        <span class="label">Average Time:</span>
        <span class="value">{metrics.cloud.averageDuration?.toFixed(2) || '0'}ms</span>
      </div>
      <div class="metric">
        <span class="label">Success Rate:</span>
        <span class="value">{metrics.cloud.successRate?.toFixed(1) || '100'}%</span>
      </div>
      <div class="metric">
        <span class="label">Total Operations:</span>
        <span class="value">{metrics.cloud.totalOperations || 0}</span>
      </div>
      {#if metrics.cloud.averageDuration > 1000}
        <div class="warning">⚠️ Performance below target (< 1000ms)</div>
      {/if}
    </div>

    <!-- Cache Metrics -->
    <div class="metric-card">
      <h4>Cache Performance</h4>
      <div class="metric">
        <span class="label">Hit Rate:</span>
        <span class="value">{metrics.cache.hitRate?.toFixed(1) || '100'}%</span>
      </div>
      <div class="metric">
        <span class="label">Total Operations:</span>
        <span class="value">{metrics.cache.totalOperations || 0}</span>
      </div>
      {#if metrics.cache.hitRate < 80}
        <div class="warning">⚠️ Cache hit rate below target (> 80%)</div>
      {/if}
    </div>

    <!-- Sync Metrics -->
    <div class="metric-card">
      <h4>Sync Operations</h4>
      <div class="metric">
        <span class="label">Average Time:</span>
        <span class="value">{metrics.sync.averageDuration?.toFixed(2) || '0'}ms</span>
      </div>
      <div class="metric">
        <span class="label">Success Rate:</span>
        <span class="value">{metrics.sync.successRate?.toFixed(1) || '100'}%</span>
      </div>
      <div class="metric">
        <span class="label">Total Operations:</span>
        <span class="value">{metrics.sync.totalOperations || 0}</span>
      </div>
    </div>
  </div>

  {#if metrics.indexeddb.lastError || metrics.cloud.lastError || metrics.sync.lastError}
    <div class="recent-errors">
      <h4>Recent Errors</h4>
      {#if metrics.indexeddb.lastError}
        <div class="error">IndexedDB: {metrics.indexeddb.lastError}</div>
      {/if}
      {#if metrics.cloud.lastError}
        <div class="error">Cloud: {metrics.cloud.lastError}</div>
      {/if}
      {#if metrics.sync.lastError}
        <div class="error">Sync: {metrics.sync.lastError}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .performance-monitor {
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

  .export-button {
    background-color: #007bff;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.5rem 1rem;
    cursor: pointer;
    font-size: 0.9rem;
  }

  .export-button:hover {
    background-color: #0056b3;
  }

  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .metric-card {
    background-color: white;
    border: 1px solid #dee2e6;
    border-radius: 6px;
    padding: 1rem;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  }

  .metric-card h4 {
    margin-top: 0;
    margin-bottom: 1rem;
    color: #495057;
  }

  .metric {
    display: flex;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }

  .label {
    color: #6c757d;
  }

  .value {
    font-weight: 500;
    color: #495057;
  }

  .warning {
    color: #856404;
    background-color: #fff3cd;
    padding: 0.5rem;
    border-radius: 4px;
    margin-top: 0.5rem;
    font-size: 0.9rem;
  }

  .recent-errors {
    border-top: 1px solid #dee2e6;
    padding-top: 1rem;
  }

  .recent-errors h4 {
    margin-top: 0;
    color: #495057;
  }

  .error {
    background-color: #f8d7da;
    color: #721c24;
    padding: 0.5rem;
    border-radius: 4px;
    margin-bottom: 0.5rem;
    font-size: 0.9rem;
  }
</style>
```

## Performance Considerations
1. **Minimal Overhead**: Performance monitoring should add minimal overhead to operations
2. **Sampling**: Consider sampling for high-frequency operations to reduce overhead
3. **Memory Management**: Limit stored metrics to prevent memory issues
4. **Asynchronous Logging**: Ensure performance logging doesn't block operations

## Error Handling
1. **Graceful Degradation**: Performance monitoring should not break core functionality
2. **Error Logging**: Log monitoring errors separately from application errors
3. **Resource Limits**: Respect system resource limits for monitoring data storage

## Testing Plan
1. **Unit Tests**: Test performance monitoring utilities
2. **Integration Tests**: Test performance monitoring in real operations
3. **Overhead Tests**: Measure impact of monitoring on operation performance
4. **Threshold Tests**: Test threshold detection and alerting
5. **UI Tests**: Test performance visualization components

## Success Metrics
1. **Monitoring Coverage**: > 95% of operations are monitored
2. **Performance Targets**: IndexedDB < 100ms, Cloud < 1000ms
3. **Cache Hit Rate**: > 80% cache hit rate
4. **Error Rate**: < 1% error rate for monitored operations
5. **User Experience**: Clear performance feedback and insights
