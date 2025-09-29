# Dual Sync Mechanism: Saving Cards to Both IndexedDB and Cloud

## Overview
This document details the implementation approach for ensuring all card modifications are saved to both IndexedDB and the cloud to maintain data consistency across platforms. The implementation will enhance the existing save functionality with improved error handling, transactional approaches, and sync status tracking.

## Current Implementation Analysis
The current save mechanism (`cardStore.saveCard()`) already attempts to save to both stores:
1. Updates the modified timestamp
2. Saves to cloud via `saveCardToCloud()`
3. Falls back to local saving if cloud save fails

However, there are several areas for improvement:
- No transactional approach to ensure consistency
- Limited error handling and recovery
- No sync status tracking
- No offline queuing for failed cloud saves

```typescript
// Current implementation in cardStore.ts
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
    // Save to both local cache and cloud
    const success = await saveCardToCloud(updatedCard, `${filename}.md`);
    if (!success) {
      throw new Error('Failed to save card to cloud');
    }
    cardStore.set(updatedCard);
  } catch (error) {
    console.error('Error saving card:', error);
    // Even if cloud save fails, try to save locally
    try {
      await dbService.saveCard(updatedCard);
      cardStore.set(updatedCard);
    } catch (localError) {
      console.error('Error saving card locally:', localError);
    }
  }
}
```

## Enhanced Implementation Plan

### 1. Transactional Dual Save Approach
Implement a transactional approach that:
1. Saves to IndexedDB first (for immediate availability)
2. Attempts to save to cloud
3. Handles partial failures gracefully
4. Maintains sync status tracking

### 2. Sync Status Tracking
Add comprehensive sync status tracking:
1. Track which cards need cloud synchronization
2. Maintain a queue of pending sync operations
3. Provide visual feedback to users
4. Handle conflict resolution

### 3. Offline Queue Management
Implement robust offline queue management:
1. Queue failed cloud saves for retry when online
2. Persist queue to IndexedDB for durability
3. Process queue automatically when connectivity is restored
4. Handle queue overflow and prioritization

## Implementation Steps

### Step 1: Enhance CardStore Save Logic
Modify `saveCard` function to implement transactional approach:

```typescript
// Enhanced saveCard function with transactional approach
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
    // Always save to local cache first for immediate availability
    const localSaveStart = performance.now();
    await dbService.saveCard(updatedCard);
    const localSaveTime = performance.now() - localSaveStart;
    console.log(`Local save time: ${localSaveTime}ms`);

    // Update store immediately for responsive UI
    cardStore.set(updatedCard);

    // Track sync status
    syncStatusStore.updateCardStatus(filename, 'pending');

    // Attempt to save to cloud
    const cloudSaveStart = performance.now();
    const success = await saveCardToCloud(updatedCard, `${filename}.md`);
    const cloudSaveTime = performance.now() - cloudSaveStart;
    console.log(`Cloud save time: ${cloudSaveTime}ms`);

    if (success) {
      // Successfully saved to both stores
      syncStatusStore.updateCardStatus(filename, 'synced');
      return true;
    } else {
      // Cloud save failed, but local save succeeded
      syncStatusStore.updateCardStatus(filename, 'local_only');

      // Queue for later sync if we're offline or experiencing issues
      if (!isOnline()) {
        await queueForSync(updatedCard, `${filename}.md`, 'save');
      }

      return false;
    }
  } catch (error) {
    console.error('Error saving card:', error);

    // If local save also failed, that's a critical error
    syncStatusStore.updateCardStatus(filename, 'error');
    return false;
  }
}
```

### Step 2: Implement Sync Status Store
Create a new store to track sync status of cards:

```typescript
// src/lib/stores/syncStatusStore.ts
import { writable } from 'svelte/store';

export type SyncStatus = 'synced' | 'pending' | 'local_only' | 'error' | 'syncing';

interface CardSyncStatus {
  id: string;
  status: SyncStatus;
  lastAttempt?: number;
  error?: string;
  retryCount: number;
}

interface SyncQueueItem {
  id: string;
  card: any;
  filename: string;
  operation: 'save' | 'delete';
  timestamp: number;
  retryCount: number;
}

interface SyncStatusStore {
  cards: Record<string, CardSyncStatus>;
  queue: SyncQueueItem[];
  isProcessingQueue: boolean;
}

const initialState: SyncStatusStore = {
  cards: {},
  queue: [],
  isProcessingQueue: false
};

export const syncStatusStore = writable<SyncStatusStore>(initialState);

export function updateCardStatus(cardId: string, status: SyncStatus, error?: string) {
  syncStatusStore.update(store => {
    const updatedCards = { ...store.cards };
    updatedCards[cardId] = {
      id: cardId,
      status,
      lastAttempt: Date.now(),
      error: error,
      retryCount: status === 'error' ? (updatedCards[cardId]?.retryCount || 0) + 1 : 0
    };
    return { ...store, cards: updatedCards };
  });
}

export function getCardStatus(cardId: string): SyncStatus {
  let status: SyncStatus = 'synced';
  syncStatusStore.subscribe(store => {
    status = store.cards[cardId]?.status || 'synced';
  })();
  return status;
}

// Queue management functions
export async function queueForSync(card: any, filename: string, operation: 'save' | 'delete') {
  syncStatusStore.update(store => {
    const newQueueItem: SyncQueueItem = {
      id: `${card.meta.id}-${Date.now()}`,
      card,
      filename,
      operation,
      timestamp: Date.now(),
      retryCount: 0
    };

    return {
      ...store,
      queue: [...store.queue, newQueueItem]
    };
  });

  // Try to process queue if we're online
  if (isOnline()) {
    await processSyncQueue();
  }
}

export async function processSyncQueue() {
  syncStatusStore.update(store => ({
    ...store,
    isProcessingQueue: true
  }));

  try {
    const queue = get(syncStatusStore).queue;

    for (const item of queue) {
      try {
        if (item.operation === 'save') {
          const success = await saveCardToCloud(item.card, item.filename);
          if (success) {
            // Remove from queue on success
            syncStatusStore.update(store => ({
              ...store,
              queue: store.queue.filter(q => q.id !== item.id)
            }));

            // Update card status
            updateCardStatus(item.card.meta.id, 'synced');
          } else {
            // Increment retry count
            syncStatusStore.update(store => {
              const updatedQueue = store.queue.map(q =>
                q.id === item.id ? { ...q, retryCount: q.retryCount + 1 } : q
              );
              return { ...store, queue: updatedQueue };
            });

            // If too many retries, mark as error
            if (item.retryCount >= 3) {
              updateCardStatus(item.card.meta.id, 'error', 'Failed to sync after 3 attempts');
              syncStatusStore.update(store => ({
                ...store,
                queue: store.queue.filter(q => q.id !== item.id)
              }));
            }
          }
        } else if (item.operation === 'delete') {
          // Implement delete operation
          // ...
        }
      } catch (error) {
        console.error('Error processing sync queue item:', error);
        // Increment retry count
        syncStatusStore.update(store => {
          const updatedQueue = store.queue.map(q =>
            q.id === item.id ? { ...q, retryCount: q.retryCount + 1 } : q
          );
          return { ...store, queue: updatedQueue };
        });
      }
    }
  } finally {
    syncStatusStore.update(store => ({
      ...store,
      isProcessingQueue: false
    }));
  }
}

// Initialize and set up event listeners
if (typeof window !== 'undefined') {
  // Process queue when online status changes
  window.addEventListener('online', () => {
    processSyncQueue();
  });

  // Periodically process queue
  setInterval(() => {
    if (isOnline()) {
      processSyncQueue();
    }
  }, 30000); // Every 30 seconds
}
```

### Step 3: Enhance SaveCardToCloud Function
Modify the existing `saveCardToCloud` function to improve error handling and reporting:

```typescript
// Enhanced saveCardToCloud function in cloudStore.ts
export async function saveCardToCloud(card: Card, filename: string): Promise<boolean> {
  const startTime = performance.now();

  try {
    // Save to local cache first (if not already saved)
    const localSaveStart = performance.now();
    await dbService.saveCard(card);
    const localSaveTime = performance.now() - localSaveStart;

    // Then save to cloud
    const { serializeCard } = await import('../utils/markdownSerializer');
    const markdown = serializeCard(card);

    const formData = new FormData();
    formData.append('path', filename);
    formData.append('content', markdown);
    formData.append('overwrite', 'true');

    const response = await fetch('/api/cloud/upload', {
      method: 'POST',
      body: formData,
      // Add timeout to prevent hanging
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
    }

    // Update the file list to reflect the change
    await syncFilesFromCloud();

    const totalTime = performance.now() - startTime;
    console.log(`Dual save completed - Local: ${localSaveTime}ms, Cloud: ${totalTime - localSaveTime}ms, Total: ${totalTime}ms`);

    return true;
  } catch (error) {
    console.error('Error saving card to cloud:', error);

    // If we're offline, queue for later sync
    if (!isOnline() || (error instanceof Error && error.name === 'AbortError')) {
      await queueForSync(card, filename, 'save');
      return false;
    }

    return false;
  }
}
```

### Step 4: Add Conflict Resolution
Implement conflict resolution for cases where the same card has been modified both locally and in the cloud:

```typescript
// Add to cardStore.ts
async function resolveConflict(localCard: Card, cloudCard: Card): Promise<Card> {
  // Simple strategy: use the most recently modified version
  const localModified = new Date(localCard.meta.modified).getTime();
  const cloudModified = new Date(cloudCard.meta.modified).getTime();

  if (localModified > cloudModified) {
    console.log(`Conflict resolved: using local version (more recent)`);
    return localCard;
  } else if (cloudModified > localModified) {
    console.log(`Conflict resolved: using cloud version (more recent)`);
    return cloudCard;
  } else {
    // Same timestamp - check content hash or use local version
    console.log(`Conflict resolved: same timestamp, using local version`);
    return localCard;
  }
}

// Enhanced loadCardFromCloud with conflict resolution
export async function loadCardFromCloud(file: CloudFile): Promise<Card | null> {
  try {
    // First check if we have it in local cache
    const cachedCard = await dbService.getCard(file.name.replace('.md', ''));
    if (cachedCard) {
      // Check if the cached version is up to date
      const cachedModified = new Date(cachedCard.meta.modified).getTime();
      const cloudModified = new Date(file.modified).getTime();

      if (cachedModified >= cloudModified) {
        return cachedCard;
      } else {
        // Cloud version is newer, but check if local has unsynced changes
        const syncStatus = getCardStatus(cachedCard.meta.id);
        if (syncStatus === 'local_only' || syncStatus === 'pending') {
          // There are local changes that haven't been synced
          // Download cloud version and resolve conflict
          const response = await fetch(`/api/cloud/download?path=${encodeURIComponent(file.path)}`);

          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }

          const content = await response.text();
          const cloudCard = parseMarkdown(content);

          // Resolve conflict
          const resolvedCard = await resolveConflict(cachedCard, cloudCard);

          // Save resolved version to both stores
          await dbService.saveCard(resolvedCard);
          await saveCardToCloud(resolvedCard, file.name);

          return resolvedCard;
        }
      }
    }

    // If not in cache or outdated, download from cloud
    const response = await fetch(`/api/cloud/download?path=${encodeURIComponent(file.path)}`);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const content = await response.text();
    const card = parseMarkdown(content);

    // Cache it locally
    await dbService.saveCard(card);

    return card;
  } catch (error) {
    console.error('Error loading card from cloud:', error);
    return null;
  }
}
```

### Step 5: Add User Feedback for Sync Status
Enhance the UI to show sync status to users:

```svelte
<!-- Add to CardEditor.svelte -->
<script>
  // ... existing imports and code ...
  import { syncStatusStore } from '$lib/stores/syncStatusStore';

  // Add reactive variable for sync status
  let syncStatus = 'synced';

  // Subscribe to sync status changes
  syncStatusStore.subscribe(store => {
    const card = get(cardStore);
    if (card) {
      syncStatus = store.cards[card.meta.id]?.status || 'synced';
    }
  });
</script>

<!-- Add to the UI to show sync status -->
<div class="sync-status-indicator">
  {#if syncStatus === 'synced'}
    <span class="status-badge synced">Synced</span>
  {:else if syncStatus === 'pending'}
    <span class="status-badge pending">Saving...</span>
  {:else if syncStatus === 'local_only'}
    <span class="status-badge local">Local only (offline)</span>
  {:else if syncStatus === 'syncing'}
    <span class="status-badge syncing">Syncing...</span>
  {:else if syncStatus === 'error'}
    <span class="status-badge error">Sync error</span>
  {/if}
</div>

<style>
  .sync-status-indicator {
    margin-bottom: 1rem;
    padding: 0.5rem;
    background-color: #f8f9fa;
    border-radius: 4px;
    font-size: 0.9rem;
  }

  .status-badge {
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-weight: bold;
  }

  .status-badge.synced {
    background-color: #d4edda;
    color: #155724;
  }

  .status-badge.pending, .status-badge.syncing {
    background-color: #cce5ff;
    color: #004085;
  }

  .status-badge.local {
    background-color: #fff3cd;
    color: #856404;
  }

  .status-badge.error {
    background-color: #f8d7da;
    color: #721c24;
  }
</style>
```

## Performance Considerations
1. **Batch Operations**: For multiple card saves, implement batch operations
2. **Throttling**: Throttle cloud saves to prevent rate limiting
3. **Connection Detection**: Use `navigator.onLine` to detect connection status
4. **Request Timeouts**: Implement timeouts for cloud requests to prevent hanging

## Error Handling
1. **Network Errors**: Queue failed operations for retry
2. **IndexedDB Errors**: Fallback to memory storage temporarily
3. **Conflict Resolution**: Implement intelligent conflict resolution strategies
4. **Quota Management**: Handle storage quota exceeded errors

## Testing Plan
1. **Unit Tests**: Test dual save logic and error handling
2. **Integration Tests**: Test full sync flow with various scenarios
3. **Offline Tests**: Test behavior when offline and reconnecting
4. **Conflict Tests**: Test conflict resolution scenarios
5. **Performance Tests**: Measure sync performance under various conditions

## Success Metrics
1. **Sync Reliability**: > 99% successful sync operations
2. **Data Consistency**: Zero data loss between local and cloud stores
3. **User Experience**: Clear sync status indicators and feedback
4. **Offline Support**: Full functionality when offline with reliable queuing
5. **Error Rate**: < 1% error rate for sync operations
