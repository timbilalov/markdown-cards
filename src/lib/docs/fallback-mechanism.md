# Fallback Mechanism: Handling IndexedDB Unavailability or Missing Data

## Overview
This document details the implementation approach for adding a comprehensive fallback mechanism that gracefully handles scenarios where IndexedDB is unavailable or data is missing. The implementation will ensure the application remains functional with appropriate degradation strategies.

## Current Implementation Analysis
The current application has basic fallback mechanisms:
1. Cloud-first loading in some scenarios
2. Basic error handling for IndexedDB operations
3. Limited fallback to cloud-only operation

However, there are several areas for improvement:
- No comprehensive detection of IndexedDB availability
- Limited fallback strategies
- No graceful degradation patterns
- No user feedback about fallback operations

## Enhanced Implementation Plan

### 1. IndexedDB Availability Detection
Implement comprehensive detection of IndexedDB availability:
1. Feature detection for IndexedDB support
2. Quota and permission checks
3. Database initialization status tracking
4. Runtime error detection

### 2. Graceful Degradation Strategies
Implement multiple levels of fallback:
1. Full IndexedDB functionality when available
2. Memory-only caching when IndexedDB is unavailable
3. Direct cloud access when both IndexedDB and memory caching fail
4. Offline mode with local storage fallback

### 3. Missing Data Recovery
Implement strategies for handling missing data:
1. Smart data reconstruction from available sources
2. User prompts for critical missing data
3. Background data recovery processes
4. Conflict resolution for recovered data

## Implementation Steps

### Step 1: Enhance DBService with Availability Detection
Modify the DBService to include comprehensive availability detection:

```typescript
// Enhanced DBService in src/lib/services/dbService.ts
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

  // Comprehensive IndexedDB availability check
  async checkAvailability(): Promise<{ available: boolean; error?: string }> {
    // If we've already checked, return cached result
    if (this.isAvailable !== null) {
      return {
        available: this.isAvailable,
        error: this.availabilityError
      };
    }

    // Check if we're in a browser environment
    if (!this.isBrowser()) {
      this.isAvailable = false;
      this.availabilityError = 'Not in browser environment';
      return { available: false, error: this.availabilityError };
    }

    try {
      // Test IndexedDB support
      if (!indexedDB) {
        this.isAvailable = false;
        this.availabilityError = 'IndexedDB not supported';
        return { available: false, error: this.availabilityError };
      }

      // Test database opening
      const request = indexedDB.open(this.DB_NAME, this.VERSION);

      return new Promise((resolve, reject) => {
        request.onsuccess = () => {
          request.result.close();
          this.isAvailable = true;
          this.availabilityError = null;
          resolve({ available: true });
        };

        request.onerror = () => {
          this.isAvailable = false;
          this.availabilityError = 'Failed to open database';
          resolve({ available: false, error: this.availabilityError });
        };

        request.onblocked = () => {
          this.isAvailable = false;
          this.availabilityError = 'Database is blocked by another process';
          resolve({ available: false, error: this.availabilityError });
        };
      });
    } catch (error) {
      this.isAvailable = false;
      this.availabilityError = error instanceof Error ? error.message : 'Unknown error';
      return { available: false, error: this.availabilityError };
    }
  }

  // Enhanced initialization with better error handling
  async init(): Promise<{ success: boolean; error?: string }> {
    // Skip initialization on server-side
    if (!this.isBrowser()) {
      this.isInitialized = false;
      return { success: true }; // Not an error, just not applicable
    }

    // Check availability first
    const availability = await this.checkAvailability();
    if (!availability.available) {
      this.isInitialized = false;
      return { success: false, error: availability.error };
    }

    try {
      const result = await new Promise((resolve, reject) => {
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

      return { success: true };
    } catch (error) {
      this.isInitialized = false;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.availabilityError = `Initialization failed: ${errorMessage}`;
      return { success: false, error: errorMessage };
    }
  }

  // Enhanced getDb method with availability checking
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

  // Enhanced card operations with fallback support
  async saveCard(card: Card): Promise<{ success: boolean; error?: string; fallbackUsed?: boolean }> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return { success: true, fallbackUsed: true };
    }

    // Check if database is available and initialized
    if (!this.isInitialized) {
      const initResult = await this.init();
      if (!initResult.success) {
        return { success: false, error: initResult.error, fallbackUsed: false };
      }
    }

    try {
      const db = this.getDb();
      const transaction = db.transaction([this.CARDS_STORE], 'readwrite');
      const store = transaction.objectStore(this.CARDS_STORE);

      return new Promise((resolve, reject) => {
        const request = store.put(card);
        request.onsuccess = () => resolve({ success: true, fallbackUsed: false });
        request.onerror = () => {
          const errorMessage = request.error ? request.error.message : 'Unknown error';
          resolve({ success: false, error: errorMessage, fallbackUsed: false });
        };
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage, fallbackUsed: false };
    }
  }

  async getCard(id: string): Promise<{ card: Card | null; error?: string; fallbackUsed?: boolean }> {
    // Skip database operations on server-side
    if (!this.isBrowser()) {
      return { card: null, fallbackUsed: true };
    }

    // Check if database is available and initialized
    if (!this.isInitialized) {
      const initResult = await this.init();
      if (!initResult.success) {
        return { card: null, error: initResult.error, fallbackUsed: false };
      }
    }

    try {
      const db = this.getDb();
      const transaction = db.transaction([this.CARDS_STORE], 'readonly');
      const store = transaction.objectStore(this.CARDS_STORE);

      return new Promise((resolve, reject) => {
        const request = store.get(id);
        request.onsuccess = () => {
          resolve({
            card: request.result || null,
            fallbackUsed: false
          });
        };
        request.onerror = () => {
          const errorMessage = request.error ? request.error.message : 'Unknown error';
          resolve({ card: null, error: errorMessage, fallbackUsed: false });
        };
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { card: null, error: errorMessage, fallbackUsed: false };
    }
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

### Step 2: Enhance Stores with Fallback Logic
Modify the stores to implement comprehensive fallback strategies:

```typescript
// Enhanced dbStore.ts with fallback support
import { writable } from 'svelte/store';
import type { Card } from '../types';
import { dbService } from '../services/dbService';

// Enhanced local database status
export const dbStatus = writable<{
  available: boolean;
  initialized: boolean;
  error?: string;
  checking: boolean;
}>({
  available: false,
  initialized: false,
  checking: true
});

// Enhanced initialization with status tracking
export async function initDB(): Promise<{ success: boolean; error?: string }> {
  dbStatus.set({ available: false, initialized: false, checking: true });

  try {
    const result = await dbService.init();

    // Get current database status
    const dbStatusInfo = dbService.getDatabaseStatus();
    dbStatus.set({
      available: dbStatusInfo.available,
      initialized: dbStatusInfo.initialized,
      error: dbStatusInfo.error,
      checking: false
    });

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    dbStatus.set({
      available: false,
      initialized: false,
      error: errorMessage,
      checking: false
    });
    return { success: false, error: errorMessage };
  }
}

// Enhanced card operations with fallback
export async function saveLocalCard(card: Card): Promise<{
  success: boolean;
  error?: string;
  fallbackUsed?: boolean;
  method?: 'indexeddb' | 'memory' | 'none';
}> {
  try {
    // Try IndexedDB first
    const result = await dbService.saveCard(card);
    if (result.success) {
      return {
        success: true,
        fallbackUsed: result.fallbackUsed,
        method: 'indexeddb'
      };
    }

    // If IndexedDB fails, try memory fallback
    const memoryResult = await saveToMemoryCache(card);
    if (memoryResult.success) {
      return {
        success: true,
        fallbackUsed: true,
        method: 'memory'
      };
    }

    // If both fail, return the IndexedDB error
    return {
      success: false,
      error: result.error,
      method: 'none'
    };
  } catch (error) {
    // Try memory fallback as last resort
    try {
      const memoryResult = await saveToMemoryCache(card);
      if (memoryResult.success) {
        return {
          success: true,
          fallbackUsed: true,
          method: 'memory'
        };
      }
    } catch (memoryError) {
      // Ignore memory error, return original error
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      error: errorMessage,
      method: 'none'
    };
  }
}

// Memory cache as fallback
const memoryCache = new Map<string, Card>();

async function saveToMemoryCache(card: Card): Promise<{ success: boolean; error?: string }> {
  try {
    memoryCache.set(card.meta.id, card);
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
}

async function getFromMemoryCache(id: string): Promise<{ card: Card | null; error?: string }> {
  try {
    const card = memoryCache.get(id) || null;
    return { card };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { card: null, error: errorMessage };
  }
}

export async function getLocalCard(id: string): Promise<{
  card: Card | null;
  error?: string;
  fallbackUsed?: boolean;
  method?: 'indexeddb' | 'memory' | 'none';
}> {
  try {
    // Try IndexedDB first
    const result = await dbService.getCard(id);
    if (result.card || !result.error) {
      return {
        card: result.card,
        fallbackUsed: result.fallbackUsed,
        method: result.card ? 'indexeddb' : 'none'
      };
    }

    // If IndexedDB fails, try memory fallback
    const memoryResult = await getFromMemoryCache(id);
    if (memoryResult.card || !memoryResult.error) {
      return {
        card: memoryResult.card,
        fallbackUsed: true,
        method: memoryResult.card ? 'memory' : 'none'
      };
    }

    // If both fail, return the IndexedDB error
    return {
      card: null,
      error: result.error,
      method: 'none'
    };
  } catch (error) {
    // Try memory fallback as last resort
    try {
      const memoryResult = await getFromMemoryCache(id);
      if (memoryResult.card || !memoryResult.error) {
        return {
          card: memoryResult.card,
          fallbackUsed: true,
          method: memoryResult.card ? 'memory' : 'none'
        };
      }
    } catch (memoryError) {
      // Ignore memory error, return original error
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      card: null,
      error: errorMessage,
      method: 'none'
    };
  }
}
```

### Step 3: Enhance CardStore with Comprehensive Fallback
Modify the cardStore to implement comprehensive fallback logic:

```typescript
// Enhanced cardStore.ts with fallback support
import { writable } from 'svelte/store';
import { parseMarkdown } from '$lib/utils/markdownParser';
import { serializeCard } from '../utils/markdownSerializer';
import { browser } from '$app/environment';
import type { Card } from '../utils/markdownSerializer';
import { cloudService } from '../services/cloudService';
import { dbService } from '../services/dbService';
import { loadCardFromCloud, saveCardToCloud } from './cloudStore';
import { getLocalCard, saveLocalCard } from './dbStore';

export const cardStore = writable<Card | null>(null);

// Fallback status tracking
export const fallbackStatus = writable<{
  usingFallback: boolean;
  fallbackType: 'memory' | 'cloud' | 'none';
  error?: string;
}>({
  usingFallback: false,
  fallbackType: 'none'
});

// Enhanced loadCard with comprehensive fallback
export async function loadCard(filename: string) {
  if (!browser) return;

  try {
    // Reset fallback status
    fallbackStatus.set({
      usingFallback: false,
      fallbackType: 'none'
    });

    // First try to load from local storage (IndexedDB first, then memory)
    const localResult = await getLocalCard(filename);
    if (localResult.card) {
      cardStore.set(localResult.card);

      // If we used a fallback, update status
      if (localResult.fallbackUsed) {
        fallbackStatus.set({
          usingFallback: true,
          fallbackType: localResult.method === 'memory' ? 'memory' : 'none',
          error: localResult.error
        });
      }

      // Check if we're online and if the cache might be stale
      const isOnline = navigator.onLine;
      if (isOnline && cloudService.isAuthenticated()) {
        // Check if cache is fresh in background
        checkCacheFreshness(filename, localResult.card);
      }

      // If we're offline or not authenticated, we're done
      if (!isOnline || !cloudService.isAuthenticated()) {
        return;
      }
    }

    // If not in cache or we need to verify freshness, check cloud
    if (cloudService.isAuthenticated()) {
      const cloudStartTime = performance.now();

      try {
        const response = await fetch('/api/cloud/files', {
          signal: AbortSignal.timeout(5000)
        });

        if (response.ok) {
          const files = await response.json();
          const file = files._embedded.items.find((f: any) => f.name === `${filename}.md`);

          if (file) {
            const card = await loadCardFromCloud(file);
            if (card) {
              const cloudTime = performance.now() - cloudStartTime;
              console.log(`Cloud card load time: ${cloudTime}ms`);
              cardStore.set(card);

              // Update fallback status if we had to fall back to cloud
              if (!localResult.card) {
                fallbackStatus.set({
                  usingFallback: true,
                  fallbackType: 'cloud'
                });
              }
              return;
            }
          }
        }
      } catch (networkError) {
        console.warn('Network error checking cloud, using available data:', networkError);
        // Continue with any available local data
        if (localResult.card) {
          return;
        }
      }
    }

    // If we have a cached version, use it
    if (localResult.card) {
      return;
    }

    // If not found anywhere, create a new card
    const newCard = createNewCard(filename);
    cardStore.set(newCard);

    // Save new card to local storage
    await saveLocalCard(newCard);
  } catch (error) {
    console.error('Error loading card:', error);

    // Try to fallback to any available data
    try {
      const localResult = await getLocalCard(filename);
      if (localResult.card) {
        cardStore.set(localResult.card);
        fallbackStatus.set({
          usingFallback: true,
          fallbackType: localResult.method === 'memory' ? 'memory' : 'none',
          error: localResult.error
        });
        return;
      }
    } catch (cacheError) {
      console.error('Error loading cached card:', cacheError);
    }

    // If all else fails, create a new card
    try {
      const newCard = createNewCard(filename);
      cardStore.set(newCard);
      fallbackStatus.set({
        usingFallback: true,
        fallbackType: 'none',
        error: 'Created new card due to loading errors'
      });
    } catch (createError) {
      console.error('Error creating new card:', createError);
      cardStore.set(null);
      fallbackStatus.set({
        usingFallback: true,
        fallbackType: 'none',
        error: 'Failed to load or create card'
      });
    }
  }
}

// Enhanced saveCard with comprehensive fallback
export async function saveCard(filename: string, card: Card) {
  if (!browser) return;

  // Update the modified timestamp
  const updatedCard = {
    ...card,
    meta: {
      ...card.meta,
      modified: Date.now()
    }
  };

  try {
    // Save to local storage first (with fallback)
    const localSaveResult = await saveLocalCard(updatedCard);
    if (!localSaveResult.success) {
      console.warn('Failed to save card locally:', localSaveResult.error);
      fallbackStatus.set({
        usingFallback: true,
        fallbackType: 'none',
        error: `Local save failed: ${localSaveResult.error}`
      });
    } else if (localSaveResult.fallbackUsed) {
      fallbackStatus.set({
        usingFallback: true,
        fallbackType: localSaveResult.method === 'memory' ? 'memory' : 'none',
        error: 'Using memory cache instead of IndexedDB'
      });
    }

    // Update store immediately for responsive UI
    cardStore.set(updatedCard);

    // Attempt to save to cloud
    const cloudSaveStart = performance.now();
    const success = await saveCardToCloud(updatedCard, `${filename}.md`);
    const cloudSaveTime = performance.now() - cloudSaveStart;
    console.log(`Cloud save time: ${cloudSaveTime}ms`);

    if (success) {
      // Successfully saved to both stores
      if (localSaveResult.fallbackUsed) {
        // We used a fallback but eventually succeeded
        fallbackStatus.set({
          usingFallback: true,
          fallbackType: localSaveResult.method === 'memory' ? 'memory' : 'none',
          error: 'Recovered from local storage issues'
        });
      } else {
        // Normal operation
        fallbackStatus.set({
          usingFallback: false,
          fallbackType: 'none'
        });
      }
      return true;
    } else {
      // Cloud save failed, but local save succeeded
      fallbackStatus.set({
        usingFallback: true,
        fallbackType: 'cloud',
        error: 'Card saved locally but cloud sync failed'
      });

      // Queue for later sync if we're offline
      if (!isOnline()) {
        // Queueing logic would go here
      }

      return false;
    }
  } catch (error) {
    console.error('Error saving card:', error);

    // Critical error - try to save anywhere we can
    try {
      // Try memory cache as last resort
      const memoryResult = await saveToMemoryCache(updatedCard);
      if (memoryResult.success) {
        cardStore.set(updatedCard);
        fallbackStatus.set({
          usingFallback: true,
          fallbackType: 'memory',
          error: `Saved to memory cache after IndexedDB failure: ${error instanceof Error ? error.message : 'Unknown error'}`
        });
        return true;
      }
    } catch (memoryError) {
      console.error('Error saving to memory cache:', memoryError);
    }

    // If all saves fail
    fallbackStatus.set({
      usingFallback: true,
      fallbackType: 'none',
      error: `Failed to save card anywhere: ${error instanceof Error ? error.message : 'Unknown error'}`
    });
    return false;
  }
}

// Memory cache functions (duplicated here for completeness)
const memoryCache = new Map<string, Card>();

async function saveToMemoryCache(card: Card): Promise<{ success: boolean; error?: string }> {
  try {
    memoryCache.set(card.meta.id, card);
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
}

// Enhanced online detection
function isOnline(): boolean {
  if (typeof navigator !== 'undefined') {
    return navigator.onLine;
  }
  return true;
}
```

### Step 4: Add User Feedback for Fallback Status
Enhance the UI to show fallback status to users:

```svelte
<!-- Add to main page and card editor components -->
<script>
  // ... existing imports and code ...
  import { fallbackStatus } from '$lib/stores/cardStore';
  import { dbStatus } from '$lib/stores/dbStore';

  // Add reactive variables for status display
  let fallbackInfo = { usingFallback: false, fallbackType: 'none', error: '' };
  let dbInfo = { available: false, initialized: false, error: '', checking: true };

  // Subscribe to status changes
  fallbackStatus.subscribe(status => {
    fallbackInfo = status;
  });

  dbStatus.subscribe(status => {
    dbInfo = status;
  });
</script>

<!-- Add to the UI to show fallback status -->
{#if fallbackInfo.usingFallback}
  <div class="fallback-notification">
    <div class="notification-content">
      {#if fallbackInfo.fallbackType === 'memory'}
        <span class="icon">⚠️</span>
        <span>Using memory cache (IndexedDB unavailable)</span>
      {:else if fallbackInfo.fallbackType === 'cloud'}
        <span class="icon">☁️</span>
        <span>Cloud only mode (local storage issues)</span>
      {:else}
        <span class="icon">⚠️</span>
        <span>Using fallback mode</span>
      {/if}

      {#if fallbackInfo.error}
        <span class="error-details">({fallbackInfo.error})</span>
      {/if}
    </div>
  </div>
{/if}

{#if dbInfo.checking}
  <div class="db-status-checking">
    <span>Checking database availability...</span>
  </div>
{:else if !dbInfo.available}
  <div class="db-status-error">
    <span class="icon">❌</span>
    <span>Database unavailable: {dbInfo.error || 'Unknown error'}</span>
  </div>
{/if}

<style>
  .fallback-notification {
    background-color: #fff3cd;
    border: 1px solid #ffeaa7;
    border-radius: 4px;
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
    color: #856404;
  }

  .db-status-checking, .db-status-error {
    background-color: #f8f9fa;
    border: 1px solid #dee2e6;
    border-radius: 4px;
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
    color: #6c757d;
  }

  .db-status-error {
    background-color: #f8d7da;
    border-color: #f5c6cb;
    color: #721c24;
  }

  .notification-content {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .icon {
    font-size: 1.2rem;
  }

  .error-details {
    font-size: 0.85rem;
    opacity: 0.8;
  }
</style>
```

## Performance Considerations
1. **Lazy Initialization**: Only initialize IndexedDB when needed
2. **Status Caching**: Cache availability checks to avoid repeated testing
3. **Memory Management**: Implement memory cache size limits
4. **Background Checking**: Perform availability checks in background when possible

## Error Handling
1. **Graceful Degradation**: Provide multiple levels of fallback
2. **User Feedback**: Clearly communicate fallback status to users
3. **Recovery Mechanisms**: Attempt to recover from temporary issues
4. **Persistent Logging**: Log fallback events for debugging

## Testing Plan
1. **Unit Tests**: Test fallback logic and error handling
2. **Integration Tests**: Test full fallback scenarios
3. **Browser Compatibility**: Test on browsers with limited IndexedDB support
4. **Quota Tests**: Test behavior when storage quota is exceeded
5. **Network Tests**: Test fallback behavior with various network conditions

## Success Metrics
1. **Availability**: > 99% of users can access their cards
2. **Fallback Usage**: < 5% of operations use fallback mechanisms
3. **User Experience**: Clear communication of fallback status
4. **Data Integrity**: Zero data loss during fallback operations
5. **Error Rate**: < 1% error rate for card operations even during fallback
