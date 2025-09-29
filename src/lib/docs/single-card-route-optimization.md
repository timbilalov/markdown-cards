# Single Card Route Optimization: IndexedDB-First Loading

## Overview
This document details the implementation approach for optimizing the single card route to read content from IndexedDB first, falling back to cloud retrieval only when necessary. This enhancement will improve card loading performance and reduce unnecessary cloud requests.

## Current Implementation Analysis
The current single card route (`src/routes/card/[slug]/`) loads cards through:

1. `+page.svelte` calls `loadCard(slug)` from `cardStore`
2. `cardStore.loadCard()` implements a cloud-first approach:
   - Attempts to load from cloud with local caching
   - Falls back to local cache only if cloud loading fails
   - Creates a new card if not found anywhere

```typescript
// Current implementation in cardStore.ts
export async function loadCard(filename: string) {
  if (!browser) return;

  try {
    // First try to load from cloud with local caching
    if (cloudService.isAuthenticated()) {
      // We need to find the cloud file first
      const response = await fetch('/api/cloud/files');

      if (response.ok) {
        const files = await response.json();
        const file = files._embedded.items.find((f: any) => f.name === `${filename}.md`);

        if (file) {
          // Load card from cloud with local caching
          const card = await loadCardFromCloud(file);
          if (card) {
            cardStore.set(card);
            return;
          }
        }
      }
    }

    // Fallback to local cache
    const cachedCard = await dbService.getCard(filename);
    if (cachedCard) {
      cardStore.set(cachedCard);
      return;
    }

    // If not found anywhere, create a new card
    const newCard = createNewCard(filename);
    cardStore.set(newCard);
  } catch (error) {
    console.error('Error loading card:', error);
    cardStore.set(null);
  }
}
```

## Enhanced Implementation Plan

### 1. IndexedDB-First Loading Strategy
The new approach will:
1. Check IndexedDB first for the requested card
2. Validate if the cached version is current
3. Only fetch from cloud if needed
4. Update IndexedDB with fresh data when fetched from cloud

### 2. Smart Cache Validation
Implement intelligent cache validation by:
1. Comparing modification timestamps between local and cloud versions
2. Using ETags or similar mechanisms if available
3. Implementing a time-based cache expiration strategy

### 3. Performance Monitoring
Add timing measurements for:
1. IndexedDB retrieval operations
2. Cloud fetch operations
3. Cache validation operations

## Implementation Steps

### Step 1: Enhance CardStore Load Logic
Modify `loadCard` function to implement IndexedDB-first approach:

```typescript
export async function loadCard(filename: string) {
  if (!browser) return;

  try {
    // Start timing for performance monitoring
    const startTime = performance.now();

    // First try to load from IndexedDB
    const cachedCard = await dbService.getCard(filename);
    if (cachedCard) {
      // Log performance metric
      const dbTime = performance.now() - startTime;
      console.log(`IndexedDB card load time: ${dbTime}ms`);

      // Check if we're online and if the cache might be stale
      const isOnline = navigator.onLine;
      if (isOnline && cloudService.isAuthenticated()) {
        // Check if cache is fresh in background
        checkCacheFreshness(filename, cachedCard);
      }

      cardStore.set(cachedCard);

      // If we're offline or not authenticated, we're done
      if (!isOnline || !cloudService.isAuthenticated()) {
        return;
      }
    }

    // If not in cache or we need to verify freshness, check cloud
    if (cloudService.isAuthenticated()) {
      const cloudStartTime = performance.now();

      // We need to find the cloud file first
      const response = await fetch('/api/cloud/files');

      if (response.ok) {
        const files = await response.json();
        const file = files._embedded.items.find((f: any) => f.name === `${filename}.md`);

        if (file) {
          // Load card from cloud with local caching
          const card = await loadCardFromCloud(file);
          if (card) {
            // Log performance metric
            const cloudTime = performance.now() - cloudStartTime;
            console.log(`Cloud card load time: ${cloudTime}ms`);

            cardStore.set(card);
            return;
          }
        }
      }
    }

    // If we have a cached version, use it even if cloud check failed
    if (cachedCard) {
      cardStore.set(cachedCard);
      return;
    }

    // If not found anywhere, create a new card
    const newCard = createNewCard(filename);
    cardStore.set(newCard);
  } catch (error) {
    console.error('Error loading card:', error);

    // Try to fallback to any cached version
    try {
      const cachedCard = await dbService.getCard(filename);
      if (cachedCard) {
        cardStore.set(cachedCard);
        return;
      }
    } catch (cacheError) {
      console.error('Error loading cached card:', cacheError);
    }

    cardStore.set(null);
  }
}
```

### Step 2: Implement Cache Freshness Checking
Add a function to check if cached cards are up-to-date:

```typescript
async function checkCacheFreshness(filename: string, cachedCard: Card): Promise<void> {
  try {
    // We need to find the cloud file to check modification time
    const response = await fetch('/api/cloud/files');

    if (response.ok) {
      const files = await response.json();
      const file = files._embedded.items.find((f: any) => f.name === `${filename}.md`);

      if (file) {
        const cachedModified = new Date(cachedCard.meta.modified).getTime();
        const cloudModified = new Date(file.modified).getTime();

        // If cloud version is newer, update the cache
        if (cloudModified > cachedModified) {
          const updatedCard = await loadCardFromCloud(file);
          if (updatedCard) {
            cardStore.set(updatedCard);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error checking cache freshness:', error);
    // Not critical - we'll use the cached version
  }
}
```

### Step 3: Enhance LoadCardFromCloud Function
Modify the existing `loadCardFromCloud` function to improve performance monitoring:

```typescript
export async function loadCardFromCloud(file: CloudFile): Promise<Card | null> {
  const startTime = performance.now();

  try {
    // First check if we have it in local cache
    const cachedCard = await dbService.getCard(file.name.replace('.md', ''));
    if (cachedCard) {
      // Check if the cached version is up to date
      const cachedModified = new Date(cachedCard.meta.modified).getTime();
      const cloudModified = new Date(file.modified).getTime();

      if (cachedModified >= cloudModified) {
        const cacheTime = performance.now() - startTime;
        console.log(`Cached card validation time: ${cacheTime}ms`);
        return cachedCard;
      }
    }

    // If not in cache or outdated, download from cloud
    const downloadStartTime = performance.now();
    const response = await fetch(`/api/cloud/download?path=${encodeURIComponent(file.path)}`);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const content = await response.text();
    const parseStartTime = performance.now();
    const card = parseMarkdown(content);

    // Cache it locally
    await dbService.saveCard(card);

    const totalTime = performance.now() - startTime;
    const downloadTime = parseStartTime - downloadStartTime;
    const parseTime = performance.now() - parseStartTime;

    console.log(`Cloud card load breakdown - Total: ${totalTime}ms, Download: ${downloadTime}ms, Parse: ${parseTime}ms`);

    return card;
  } catch (error) {
    console.error('Error loading card from cloud:', error);
    return null;
  }
}
```

### Step 4: Add Offline Detection
Enhance the card loading to handle offline scenarios gracefully:

```typescript
// Add to cardStore.ts
function isOnline(): boolean {
  if (typeof navigator !== 'undefined') {
    return navigator.onLine;
  }
  return true; // Assume online in server environments
}

// Enhanced loadCard function with offline handling
export async function loadCard(filename: string) {
  if (!browser) return;

  try {
    // Check online status
    const online = isOnline();

    // Always try IndexedDB first
    const cachedCard = await dbService.getCard(filename);
    if (cachedCard) {
      cardStore.set(cachedCard);

      // If offline, we're done
      if (!online) {
        return;
      }
    }

    // If online and authenticated, check cloud
    if (online && cloudService.isAuthenticated()) {
      const cloudStartTime = performance.now();

      try {
        const response = await fetch('/api/cloud/files', {
          // Add timeout to prevent hanging
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
              return;
            }
          }
        }
      } catch (networkError) {
        console.warn('Network error checking cloud, using cached version:', networkError);
        // Continue with cached version if available
        if (cachedCard) {
          return;
        }
      }
    }

    // If we have a cached version, use it
    if (cachedCard) {
      return;
    }

    // If not found anywhere, create a new card
    const newCard = createNewCard(filename);
    cardStore.set(newCard);
  } catch (error) {
    console.error('Error loading card:', error);

    // Try to fallback to any cached version
    try {
      const cachedCard = await dbService.getCard(filename);
      if (cachedCard) {
        cardStore.set(cachedCard);
        return;
      }
    } catch (cacheError) {
      console.error('Error loading cached card:', cacheError);
    }

    cardStore.set(null);
  }
}
```

### Step 5: Add User Feedback
Enhance the CardEditor component to provide user feedback about data loading sources:

```svelte
<!-- Add to CardEditor.svelte -->
<script>
  // ... existing imports and code ...

  // Add reactive variable to track data source
  let dataSource = 'unknown'; // 'indexeddb', 'cloud', 'new'
  let loadingTime = 0;

  // Modify onMount to track data source
  onMount(async () => {
    const startTime = performance.now();

    const slug = $page.params.slug;
    if (slug && slug !== 'new') {
      // Set initial data source
      const cachedCard = await dbService.getCard(slug);
      dataSource = cachedCard ? 'indexeddb' : 'cloud';

      await loadCard(slug);

      // Update with actual data source after load
      const finalCard = get(cardStore);
      if (finalCard) {
        dataSource = finalCard.meta.id === slug ?
          (cachedCard && cachedCard.meta.modified === finalCard.meta.modified ?
            'indexeddb' : 'cloud') : 'new';
      }
    } else {
      dataSource = 'new';
    }

    loadingTime = performance.now() - startTime;
  });
</script>

<!-- Add to the UI to show data source -->
<div class="data-source-indicator">
  {#if dataSource === 'indexeddb'}
    <span class="source-badge local">Loaded from local cache</span>
  {:else if dataSource === 'cloud'}
    <span class="source-badge cloud">Loaded from cloud</span>
  {:else if dataSource === 'new'}
    <span class="source-badge new">New card</span>
  {/if}
  <span class="loading-time">Load time: {loadingTime.toFixed(0)}ms</span>
</div>

<style>
  .data-source-indicator {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    padding: 0.5rem;
    background-color: #f8f9fa;
    border-radius: 4px;
    font-size: 0.9rem;
  }

  .source-badge {
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-weight: bold;
  }

  .source-badge.local {
    background-color: #d4edda;
    color: #155724;
  }

  .source-badge.cloud {
    background-color: #cce5ff;
    color: #004085;
  }

  .source-badge.new {
    background-color: #fff3cd;
    color: #856404;
  }

  .loading-time {
    color: #6c757d;
  }
</style>
```

## Performance Considerations
1. **Timing Measurements**: All operations should be timed for performance monitoring
2. **Background Updates**: Cache validation should happen in the background when possible
3. **Connection Detection**: Use `navigator.onLine` to detect connection status
4. **Request Timeouts**: Implement timeouts for cloud requests to prevent hanging

## Error Handling
1. **Network Errors**: Graceful fallback to cached data
2. **IndexedDB Errors**: Fallback to cloud-only operation
3. **Parsing Errors**: Handle malformed markdown files
4. **Timeouts**: Implement reasonable timeouts for all network operations

## Testing Plan
1. **Unit Tests**: Test IndexedDB-first loading logic
2. **Integration Tests**: Test full card loading flow
3. **Offline Tests**: Test behavior when offline
4. **Performance Tests**: Measure load times for different scenarios
5. **Edge Case Tests**: Test with various network conditions

## Success Metrics
1. **Load Time**: Card loading in < 100ms when available in IndexedDB
2. **Cloud API Usage**: Reduced cloud requests for cards already in cache
3. **User Experience**: Clear indication of data source for transparency
4. **Error Rate**: < 1% error rate for card loading operations
5. **Offline Support**: Full functionality when offline with queued syncs
