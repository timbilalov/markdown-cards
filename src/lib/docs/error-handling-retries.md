# Robust Error Handling for IndexedDB Operations with Retries

## Overview
This document details the implementation approach for adding robust error handling with retry mechanisms for all IndexedDB operations. The implementation will ensure reliable data access even in the face of transient errors, quota issues, or other common IndexedDB problems.

## Current Implementation Analysis
The current application has basic error handling for IndexedDB operations:
1. Simple try/catch blocks around operations
2. Basic error logging
3. No retry mechanisms
4. No sophisticated error categorization

However, there are several areas for improvement:
- No retry logic for transient errors
- No exponential backoff strategies
- No error categorization for different handling approaches
- No quota management
- No timeout handling for long-running operations

## Enhanced Implementation Plan

### 1. Error Categorization
Implement comprehensive error categorization:
1. Transient errors (network issues, temporary failures)
2. Permanent errors (quota exceeded, corruption)
3. User errors (invalid data, constraints)
4. System errors (browser limitations, permissions)

### 2. Retry Mechanisms
Implement intelligent retry strategies:
1. Exponential backoff for transient errors
2. Jitter to prevent thundering herd problems
3. Maximum retry limits
4. Different strategies for different error types

### 3. Timeout Handling
Implement timeout mechanisms:
1. Operation timeouts to prevent hanging
2. Graceful timeout handling
3. User feedback during long operations

### 4. Quota Management
Implement quota monitoring and management:
1. Storage quota checking
2. Cleanup strategies for quota issues
3. User notifications for quota problems

## Implementation Steps

### Step 1: Create Error Handling Utilities
Create utility functions for error categorization and retry logic:

```typescript
// src/lib/utils/indexeddbErrorHandler.ts
export type IndexedDBErrorType =
  | 'transient'
  | 'permanent'
  | 'quota'
  | 'user'
  | 'system'
  | 'unknown';

export interface IndexedDBErrorInfo {
  type: IndexedDBErrorType;
  message: string;
  code?: string;
  retryable: boolean;
  maxRetries: number;
  backoffBase: number; // Base delay in milliseconds
}

// Categorize IndexedDB errors
export function categorizeIndexedDBError(error: any): IndexedDBErrorInfo {
  // Handle different types of errors
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorCode = error?.name || error?.code || '';

  // Transient errors - network issues, temporary failures
  if (
    errorMessage.includes('QuotaExceededError') ||
    errorMessage.includes('AbortError') ||
    errorMessage.includes('TimeoutError') ||
    errorCode === 'QuotaExceededError' ||
    errorCode === 'AbortError' ||
    errorCode === 'TimeoutError'
  ) {
    return {
      type: 'transient',
      message: errorMessage,
      code: errorCode,
      retryable: true,
      maxRetries: 3,
      backoffBase: 100 // 100ms base delay
    };
  }

  // Quota errors - storage limits exceeded
  if (
    errorMessage.includes('QuotaExceeded') ||
    errorMessage.includes('NS_ERROR_DOM_QUOTA') ||
    errorCode.includes('QuotaExceeded') ||
    (error && typeof error === 'object' && 'QUOTA_ERR' in error)
  ) {
    return {
      type: 'quota',
      message: errorMessage,
      code: errorCode,
      retryable: false, // Quota errors typically need user intervention
      maxRetries: 0,
      backoffBase: 0
    };
  }

  // User errors - invalid data or constraints
  if (
    errorMessage.includes('ConstraintError') ||
    errorMessage.includes('DataError') ||
    errorMessage.includes('InvalidStateError') ||
    errorCode === 'ConstraintError' ||
    errorCode === 'DataError' ||
    errorCode === 'InvalidStateError'
  ) {
    return {
      type: 'user',
      message: errorMessage,
      code: errorCode,
      retryable: false, // User errors won't be fixed by retrying
      maxRetries: 0,
      backoffBase: 0
    };
  }

  // System errors - browser limitations, permissions
  if (
    errorMessage.includes('SecurityError') ||
    errorMessage.includes('NS_ERROR_FILE_ACCESS_DENIED') ||
    errorCode === 'SecurityError'
  ) {
    return {
      type: 'system',
      message: errorMessage,
      code: errorCode,
      retryable: false, // System errors typically need user intervention
      maxRetries: 0,
      backoffBase: 0
    };
  }

  // Permanent errors - data corruption, database issues
  if (
    errorMessage.includes('UnknownError') ||
    errorMessage.includes('VersionError') ||
    errorCode === 'UnknownError' ||
    errorCode === 'VersionError'
  ) {
    return {
      type: 'permanent',
      message: errorMessage,
      code: errorCode,
      retryable: false, // Permanent errors won't be fixed by retrying
      maxRetries: 0,
      backoffBase: 0
    };
  }

  // Default to unknown error
  return {
    type: 'unknown',
    message: errorMessage,
    code: errorCode,
    retryable: true, // Assume unknown errors are retryable
    maxRetries: 2, // Fewer retries for unknown errors
    backoffBase: 200 // Longer base delay for unknown errors
  };
}

// Calculate exponential backoff with jitter
export function calculateBackoff(
  attempt: number,
  baseDelay: number,
  maxDelay: number = 10000 // 10 seconds max
): number {
  // Exponential backoff: baseDelay * 2^attempt
  const exponentialDelay = baseDelay * Math.pow(2, attempt);

  // Add jitter: random value between 0 and 50% of exponential delay
  const jitter = Math.random() * exponentialDelay * 0.5;

  // Total delay with jitter, capped at maxDelay
  const totalDelay = Math.min(exponentialDelay + jitter, maxDelay);

  return Math.max(totalDelay, 0); // Ensure non-negative
}

// Sleep function for delays
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retry wrapper for async operations
export async function retryOperation<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 100,
  maxDelay: number = 10000
): Promise<{ success: boolean; result?: T; error?: any; attempts: number }> {
  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation();
      return { success: true, result, error: undefined, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;

      // If this is the last attempt, don't retry
      if (attempt === maxRetries) {
        break;
      }

      // Categorize the error to determine if we should retry
      const errorInfo = categorizeIndexedDBError(error);

      // If the error is not retryable, don't retry
      if (!errorInfo.retryable) {
        break;
      }

      // Calculate delay with exponential backoff and jitter
      const delay = calculateBackoff(attempt, baseDelay, maxDelay);

      console.log(`IndexedDB operation failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay.toFixed(0)}ms:`, errorInfo.message);

      // Wait before retrying
      await sleep(delay);
    }
  }

  return { success: false, result: undefined, error: lastError, attempts: maxRetries + 1 };
}

// Enhanced timeout wrapper
export async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number = 5000 // 5 seconds default
): Promise<T> {
  return new Promise((resolve, reject) => {
    // Set up the timeout
    const timeoutId = setTimeout(() => {
      reject(new Error(`Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // Execute the operation
    operation()
      .then(result => {
        clearTimeout(timeoutId);
        resolve(result);
      })
      .catch(error => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}
```

### Step 2: Enhance DBService with Retry Logic
Modify the DBService to use the new error handling utilities:

```typescript
// Enhanced DBService in src/lib/services/dbService.ts
import { retryOperation, withTimeout, categorizeIndexedDBError } from '../utils/indexeddbErrorHandler';
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

  // Enhanced initialization with retry logic
  async init(): Promise<{ success: boolean; error?: string }> {
    // Skip initialization on server-side
    if (!this.isBrowser()) {
      this.isInitialized = false;
      return { success: true }; // Not an error, just not applicable
    }

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
      return { success: true };
    } else {
      this.isInitialized = false;
      const errorInfo = categorizeIndexedDBError(result.error);
      this.availabilityError = `Initialization failed: ${errorInfo.message}`;
      return { success: false, error: errorInfo.message };
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

  // Enhanced card operations with retry logic
  async saveCard(card: Card): Promise<{ success: boolean; error?: string; attempts?: number }> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return { success: true, attempts: 1 };
    }

    // Check if database is available and initialized
    if (!this.isInitialized) {
      const initResult = await this.init();
      if (!initResult.success) {
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

    return {
      success: result.success,
      error: result.error ? categorizeIndexedDBError(result.error).message : undefined,
      attempts: result.attempts
    };
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

    // Check if database is available and initialized
    if (!this.isInitialized) {
      const initResult = await this.init();
      if (!initResult.success) {
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

    return {
      card: result.success ? result.result as Card | null : null,
      error: result.error ? categorizeIndexedDBError(result.error).message : undefined,
      attempts: result.attempts,
      fromCache: false // This would be true if we had a memory cache layer
    };
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

    // Check if database is available and initialized
    if (!this.isInitialized) {
      const initResult = await this.init();
      if (!initResult.success) {
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

    return {
      cards: result.success ? result.result as Card[] : [],
      error: result.error ? categorizeIndexedDBError(result.error).message : undefined,
      attempts: result.attempts,
      fromCache: false
    };
  }

  async deleteCard(id: string): Promise<{ success: boolean; error?: string; attempts?: number }> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return { success: true, attempts: 1 };
    }

    // Check if database is available and initialized
    if (!this.isInitialized) {
      const initResult = await this.init();
      if (!initResult.success) {
        return { success: false, error: initResult.error, attempts: 1 };
      }
    }

    // Use retry logic for delete operation
    const result = await retryOperation(
      async () => {
        return new Promise((resolve, reject) => {
          try {
            const db = this.getDb();
            const transaction = db.transaction([this.CARDS_STORE], 'readwrite');
            const store = transaction.objectStore(this.CARDS_STORE);

            const request = store.delete(id);
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

    return {
      success: result.success,
      error: result.error ? categorizeIndexedDBError(result.error).message : undefined,
      attempts: result.attempts
    };
  }

  // Enhanced cloud file operations with retry logic
  async saveCloudFile(file: CloudFile): Promise<{ success: boolean; error?: string; attempts?: number }> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return { success: true, attempts: 1 };
    }

    // Check if database is available and initialized
    if (!this.isInitialized) {
      const initResult = await this.init();
      if (!initResult.success) {
        return { success: false, error: initResult.error, attempts: 1 };
      }
    }

    // Use retry logic for save operation
    const result = await retryOperation(
      async () => {
        return new Promise((resolve, reject) => {
          try {
            const db = this.getDb();
            const transaction = db.transaction([this.FILES_STORE], 'readwrite');
            const store = transaction.objectStore(this.FILES_STORE);

            const request = store.put(file);
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

    return {
      success: result.success,
      error: result.error ? categorizeIndexedDBError(result.error).message : undefined,
      attempts: result.attempts
    };
  }

  async getCloudFile(path: string): Promise<{
    file: CloudFile | null;
    error?: string;
    attempts?: number;
  }> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return { file: null, attempts: 1 };
    }

    // Check if database is available and initialized
    if (!this.isInitialized) {
      const initResult = await this.init();
      if (!initResult.success) {
        return { file: null, error: initResult.error, attempts: 1 };
      }
    }

    // Use retry logic for get operation
    const result = await retryOperation(
      async () => {
        return new Promise((resolve, reject) => {
          try {
            const db = this.getDb();
            const transaction = db.transaction([this.FILES_STORE], 'readonly');
            const store = transaction.objectStore(this.FILES_STORE);

            const request = store.get(path);
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
      2, // Max 2 retries
      50, // 50ms base delay
      2000 // 2 second max delay
    );

    return {
      file: result.success ? result.result as CloudFile | null : null,
      error: result.error ? categorizeIndexedDBError(result.error).message : undefined,
      attempts: result.attempts
    };
  }

  // Enhanced clearAllData with retry logic
  async clearAllData(): Promise<{ success: boolean; error?: string; attempts?: number }> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return { success: true, attempts: 1 };
    }

    // Check if database is available and initialized
    if (!this.isInitialized) {
      const initResult = await this.init();
      if (!initResult.success) {
        return { success: false, error: initResult.error, attempts: 1 };
      }
    }

    // Use retry logic for clear operation
    const result = await retryOperation(
      async () => {
        return new Promise((resolve, reject) => {
          try {
            const db = this.getDb();
            const transaction = db.transaction([this.CARDS_STORE, this.FILES_STORE], 'readwrite');
            const cardStore = transaction.objectStore(this.CARDS_STORE);
            const fileStore = transaction.objectStore(this.FILES_STORE);

            const cardRequest = cardStore.clear();
            const fileRequest = fileStore.clear();

            let cardSuccess = false;
            let fileSuccess = false;
            let cardError: any = null;
            let fileError: any = null;

            cardRequest.onsuccess = () => {
              cardSuccess = true;
              if (fileSuccess) {
                resolve(true);
              }
            };

            cardRequest.onerror = () => {
              cardError = cardRequest.error;
              if (fileError) {
                const errorMessage = cardError ? cardError.message : (fileError ? fileError.message : 'Unknown error');
                reject(new Error(errorMessage));
              }
            };

            fileRequest.onsuccess = () => {
              fileSuccess = true;
              if (cardSuccess) {
                resolve(true);
              }
            };

            fileRequest.onerror = () => {
              fileError = fileRequest.error;
              if (cardError) {
                const errorMessage = cardError ? cardError.message : (fileError ? fileError.message : 'Unknown error');
                reject(new Error(errorMessage));
              }
            };
          } catch (error) {
            reject(error);
          }
        });
      },
      2, // Max 2 retries
      200, // 200ms base delay
      5000 // 5 second max delay
    );

    return {
      success: result.success,
      error: result.error ? categorizeIndexedDBError(result.error).message : undefined,
      attempts: result.attempts
    };
  }

  // Add method to get database status for UI feedback
  getDatabaseStatus(): {
    available: boolean;
    initialized: boolean;
    error?: string;
    sizeEstimate?: number;
  } {
    return {
      available: this.isAvailable || false,
      initialized: this.isInitialized,
      error: this.availabilityError,
      // Could add size estimation in the future
    };
  }
}
```

### Step 3: Enhance Stores with Error Handling
Modify the stores to use the enhanced error handling:

```typescript
// Enhanced dbStore.ts with error handling
import { writable } from 'svelte/store';
import type { Card } from '../types';
import { dbService } from '../services/dbService';

// Enhanced error tracking
export const dbError = writable<{
  hasError: boolean;
  message?: string;
  type?: string;
  retryCount: number;
  lastAttempt?: number;
}>({
  hasError: false,
  retryCount: 0
});

// Enhanced initialization with error tracking
export async function initDB(): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await dbService.init();

    if (result.success) {
      // Clear any previous errors
      dbError.set({
        hasError: false,
        retryCount: 0
      });
    } else {
      // Track the error
      dbError.set({
        hasError: true,
        message: result.error,
        retryCount: 0,
        lastAttempt: Date.now()
      });
    }

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    dbError.set({
      hasError: true,
      message: errorMessage,
      type: 'initialization',
      retryCount: 0,
      lastAttempt: Date.now()
    });
    return { success: false, error: errorMessage };
  }
}

// Enhanced card operations with error tracking
export async function saveLocalCard(card: Card): Promise<{
  success: boolean;
  error?: string;
  attempts?: number;
}> {
  try {
    const result = await dbService.saveCard(card);

    if (result.success) {
      // Clear any previous errors for this operation
      dbError.set({
        hasError: false,
        retryCount: 0
      });
    } else {
      // Track the error
      dbError.set({
        hasError: true,
        message: result.error,
        retryCount: result.attempts || 0,
        lastAttempt: Date.now()
      });
    }

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    dbError.set({
      hasError: true,
      message: errorMessage,
      type: 'save',
      retryCount: 0,
      lastAttempt: Date.now()
    });
    return { success: false, error: errorMessage };
  }
}

export async function getLocalCard(id: string): Promise<{
  card: Card | null;
  error?: string;
  attempts?: number;
}> {
  try {
    const result = await dbService.getCard(id);

    if (result.card || !result.error) {
      // Clear any previous errors for this operation if successful
      if (!result.error) {
        dbError.set({
          hasError: false,
          retryCount: 0
        });
      }
    } else {
      // Track the error
      dbError.set({
        hasError: true,
        message: result.error,
        retryCount: result.attempts || 0,
        lastAttempt: Date.now()
      });
    }

    return {
      card: result.card,
      error: result.error,
      attempts: result.attempts
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    dbError.set({
      hasError: true,
      message: errorMessage,
      type: 'get',
      retryCount: 0,
      lastAttempt: Date.now()
    });
    return { card: null, error: errorMessage };
  }
}

// Enhanced error recovery function
export async function attemptErrorRecovery(): Promise<{ success: boolean; message?: string }> {
  try {
    // Try to reinitialize the database
    const initResult = await initDB();

    if (initResult.success) {
      // Clear error state
      dbError.set({
        hasError: false,
        retryCount: 0
      });
      return { success: true, message: 'Database reinitialized successfully' };
    } else {
      return { success: false, message: `Reinitialization failed: ${initResult.error}` };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, message: `Recovery failed: ${errorMessage}` };
  }
}
```

### Step 4: Add User Feedback for Error Handling
Enhance the UI to show error handling status to users:

```svelte
<!-- Add to components that use IndexedDB -->
<script>
  // ... existing imports and code ...
  import { dbError } from '$lib/stores/dbStore';

  // Add reactive variable for error display
  let dbErrorInfo = {
    hasError: false,
    message: '',
    type: '',
    retryCount: 0,
    lastAttempt: 0,
    canRecover: false
  };

  // Subscribe to error changes
  dbError.subscribe(error => {
    dbErrorInfo = {
      ...error,
      canRecover: error.hasError && error.retryCount < 3
    };
  });

  // Function to attempt recovery
  async function handleRecovery() {
    // Show recovery in progress
    dbError.set({
      ...dbErrorInfo,
      message: 'Attempting recovery...',
      retryCount: dbErrorInfo.retryCount + 1
    });

    // Attempt recovery
    const result = await attemptErrorRecovery();

    // Update UI with result
    if (!result.success) {
      dbError.set({
        hasError: true,
        message: result.message || 'Recovery failed',
        retryCount: dbErrorInfo.retryCount + 1,
        lastAttempt: Date.now()
      });
    }
  }
</script>

<!-- Add to the UI to show error status -->
{#if dbErrorInfo.hasError}
  <div class="db-error-notification">
    <div class="error-content">
      <span class="icon">⚠️</span>
      <div class="error-details">
        <span class="error-message">{dbErrorInfo.message}</span>
        {#if dbErrorInfo.type}
          <span class="error-type">({dbErrorInfo.type})</span>
        {/if}
        <span class="retry-info">Attempt {dbErrorInfo.retryCount}/3</span>
      </div>
      {#if dbErrorInfo.canRecover}
        <button class="retry-button" on:click={handleRecovery}>
          Retry
        </button>
      {/if}
    </div>

    {#if dbErrorInfo.lastAttempt}
      <div class="error-timestamp">
        Last attempt: {new Date(dbErrorInfo.lastAttempt).toLocaleTimeString()}
      </div>
    {/if}
  </div>
{/if}

<style>
  .db-error-notification {
    background-color: #f8d7da;
    border: 1px solid #f5c6cb;
    border-radius: 4px;
    padding: 1rem;
    margin-bottom: 1rem;
    color: #721c24;
  }

  .error-content {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .error-details {
    flex: 1;
  }

  .error-message {
    font-weight: 500;
  }

  .error-type {
    font-size: 0.85rem;
    opacity: 0.8;
    margin-left: 0.5rem;
  }

  .retry-info {
    font-size: 0.8rem;
    opacity: 0.7;
    display: block;
    margin-top: 0.25rem;
  }

  .retry-button {
    background-color: #721c24;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.5rem 1rem;
    cursor: pointer;
    font-size: 0.9rem;
  }

  .retry-button:hover {
    background-color: #5a151c;
  }

  .error-timestamp {
    font-size: 0.8rem;
    opacity: 0.7;
    margin-top: 0.5rem;
    text-align: right;
  }
</style>
```

## Performance Considerations
1. **Retry Limits**: Implement reasonable retry limits to prevent infinite loops
2. **Backoff Strategies**: Use exponential backoff with jitter to prevent thundering herd
3. **Timeout Handling**: Implement timeouts to prevent hanging operations
4. **Error Categorization**: Only retry transient errors, not permanent ones

## Error Handling
1. **Comprehensive Categorization**: Categorize errors for appropriate handling
2. **User Feedback**: Provide clear error messages and recovery options
3. **Logging**: Log errors for debugging and monitoring
4. **Graceful Degradation**: Continue functioning even when IndexedDB fails

## Testing Plan
1. **Unit Tests**: Test error categorization and retry logic
2. **Integration Tests**: Test full error handling scenarios
3. **Failure Injection**: Test behavior with simulated IndexedDB failures
4. **Performance Tests**: Measure impact of retry mechanisms on performance
5. **User Experience Tests**: Test error messages and recovery flows

## Success Metrics
1. **Error Rate**: Reduce IndexedDB operation error rate by 50%
2. **Recovery Rate**: > 80% of transient errors successfully recovered
3. **User Experience**: Clear error messages and recovery options
4. **Performance**: Minimal impact on normal operation performance
5. **Reliability**: > 99% of operations succeed or provide clear error feedback
