# Main Page Optimization: Display Card Titles from IndexedDB

## Overview
This document details the implementation approach for optimizing the main page to display actual card titles from IndexedDB instead of using filenames/IDs. This enhancement will improve user experience by showing meaningful titles and reduce the need for cloud requests during initial page load.

## Current Implementation Analysis
The current main page (`src/routes/+page.svelte`) displays card information by:
1. Loading cloud files via `syncFilesFromCloud()`
2. Converting filenames to IDs and using them as titles
3. Not utilizing any local IndexedDB data for display

```javascript
// Current implementation in +page.svelte
$: cards = $cloudFiles
  .filter((file: CloudFile) => file.name.endsWith('.md'))
  .map((file: CloudFile) => {
    // Extract ID from filename (remove .md extension)
    const id = file.name.replace('.md', '');
    // For now, we'll use the filename as title
    // In a more complete implementation, we'd parse the file to get the actual title
    return {
      id: id,
      title: id,  // Using ID as title - not ideal
      modified: file.modified
    };
  });
```

## Enhanced Implementation Plan

### 1. Data Structure Enhancement
We need to enhance the IndexedDB schema to store card titles for quick retrieval:

#### Current DB Schema
```typescript
// In dbService.ts
const cardStore = db.createObjectStore(this.CARDS_STORE, { keyPath: 'meta.id' });
cardStore.createIndex('title', 'title', { unique: false });
cardStore.createIndex('modified', 'meta.modified', { unique: false });
```

#### Enhanced DB Schema
We'll add a new index for quick title retrieval and ensure titles are properly stored:

```typescript
// Enhanced schema (will be implemented in dbService)
const cardStore = db.createObjectStore(this.CARDS_STORE, { keyPath: 'meta.id' });
cardStore.createIndex('title', 'title', { unique: false });
cardStore.createIndex('displayTitle', 'meta.title', { unique: false }); // New index
cardStore.createIndex('modified', 'meta.modified', { unique: false });
```

### 2. Initial Sync Enhancement
During the initial sync process, we need to extract and store titles:

#### Current Sync Process
1. Fetch file list from cloud
2. Cache file metadata in IndexedDB
3. Load card content on-demand

#### Enhanced Sync Process
1. Fetch file list from cloud
2. For each markdown file:
   - Download content from cloud
   - Parse title from content
   - Store complete card with title in IndexedDB
3. Cache file metadata in IndexedDB
4. Update main page display from IndexedDB

### 3. Main Page Display Enhancement
The main page will be modified to:

#### Current Display Logic
- Uses filenames as titles
- Relies on cloud file list

#### Enhanced Display Logic
- Retrieve card titles directly from IndexedDB
- Display actual card titles instead of IDs
- Show loading states appropriately
- Provide user feedback about data sources

## Implementation Steps

### Step 1: Enhance DBService
1. Add methods to retrieve card titles efficiently
2. Add performance monitoring for title retrieval operations
3. Implement error handling for title retrieval

### Step 2: Enhance CloudStore
1. Modify `syncFilesFromCloud` to also fetch and store card content
2. Add title extraction during sync process
3. Implement progress tracking for initial sync

### Step 3: Modify Main Page Component
1. Update data derivation to use IndexedDB titles
2. Add loading states and progress indicators
3. Add user feedback about data sources

### Step 4: Add Performance Monitoring
1. Track IndexedDB title retrieval times
2. Monitor cloud sync performance
3. Log metrics for optimization

## Technical Details

### Enhanced DBService Methods
```typescript
// New method to get card titles for main page display
async getCardTitles(): Promise<{id: string, title: string, modified: number}[]> {
  if (!this.isBrowser()) {
    return Promise.resolve([]);
  }

  const db = this.getDb();
  const transaction = db.transaction([this.CARDS_STORE], 'readonly');
  const store = transaction.objectStore(this.CARDS_STORE);
  const index = store.index('title');

  return new Promise((resolve, reject) => {
    const request = index.getAll();
    request.onsuccess = () => {
      // Extract just the needed fields for display
      const titles = request.result.map(card => ({
        id: card.meta.id,
        title: card.title,
        modified: card.meta.modified
      }));
      resolve(titles);
    };
    request.onerror = () => reject(request.error);
  });
}

// Enhanced saveCard method to ensure titles are properly stored
async saveCard(card: Card): Promise<void> {
  // Ensure title is properly set
  const cardToSave = {
    ...card,
    title: card.title || card.meta.id // Fallback to ID if no title
  };

  // Rest of existing implementation
  // ...
}
```

### Enhanced CloudStore Sync
```typescript
// Enhanced syncFilesFromCloud with content fetching
export async function syncFilesFromCloud(): Promise<void> {
  // Check if we're authenticated
  const authStatus = get(isAuthenticated);
  if (!authStatus) {
    return;
  }

  syncStatus.update(status => ({ ...status, isSyncing: true, error: null }));

  try {
    const response = await fetch('/api/cloud/files');

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    // Store file metadata
    cloudFiles.set(data._embedded.items);

    // Fetch and store card content for markdown files
    const markdownFiles = data._embedded.items.filter((file: CloudFile) =>
      file.name.endsWith('.md'));

    // Process each markdown file
    for (const file of markdownFiles) {
      try {
        // Check if we already have current content
        const existingCard = await dbService.getCard(file.name.replace('.md', ''));
        if (existingCard) {
          const existingModified = new Date(existingCard.meta.modified).getTime();
          const cloudModified = new Date(file.modified).getTime();

          if (existingModified >= cloudModified) {
            // Skip if we have current content
            continue;
          }
        }

        // Fetch content from cloud
        const contentResponse = await fetch(
          `/api/cloud/download?path=${encodeURIComponent(file.path)}`);

        if (contentResponse.ok) {
          const content = await contentResponse.text();
          const card = parseMarkdown(content);

          // Save to IndexedDB
          await dbService.saveCard(card);
        }
      } catch (error) {
        console.error(`Error processing file ${file.name}:`, error);
        // Continue with other files
      }
    }

    syncStatus.update(status => ({
      ...status,
      isSyncing: false,
      lastSync: Date.now(),
      error: null
    }));
  } catch (error) {
    console.error('Error syncing files from cloud:', error);
    syncStatus.update(status => ({
      ...status,
      isSyncing: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }));
  }
}
```

### Enhanced Main Page Component
```svelte
<!-- Enhanced +page.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { cloudFiles, isAuthenticated, syncFilesFromCloud, syncStatus } from '$lib/stores/cloudStore';
  import { dbInitialized, initDB } from '$lib/stores/dbStore';
  import { dbService } from '$lib/services/dbService';
  import type { CloudFile } from '$lib/types/cloud';

  interface Card {
    id: string;
    title: string;
    modified: string;
  }

  let cards: Card[] = [];
  let loading = true;
  let loadingSource = 'initial'; // 'initial', 'indexeddb', 'cloud'
  let syncProgress = 0; // 0-100

  onMount(async () => {
    // Initialize the database
    await initDB();

    // Try to load titles from IndexedDB first for immediate display
    loadingSource = 'indexeddb';
    try {
      const cachedCards = await dbService.getAllCards();
      if (cachedCards.length > 0) {
        cards = cachedCards.map(card => ({
          id: card.meta.id,
          title: card.title,
          modified: new Date(card.meta.modified).toISOString()
        }));
      }
    } catch (error) {
      console.error('Error loading cached titles:', error);
    }

    // Then sync with cloud for updates
    loadingSource = 'cloud';
    await syncFilesFromCloud();

    // Update display with latest data
    try {
      const updatedCards = await dbService.getAllCards();
      cards = updatedCards.map(card => ({
        id: card.meta.id,
        title: card.title,
        modified: new Date(card.meta.modified).toISOString()
      }));
    } catch (error) {
      console.error('Error loading updated titles:', error);
    }

    loading = false;
  });
</script>

<div class="container">
  <div class="header">
    <h1>Markdown Cards</h1>
    {#if loading}
      <div class="loading-indicator">
        <span>Loading from {loadingSource}...</span>
      </div>
    {/if}
  </div>

  {#if loading}
    <div class="loading">Loading files...</div>
  {:else}
    <div class="card-list">
      {#if cards.length > 0}
        {#each cards as card}
          <a href={`/card/${card.id}`} class="card">
            <h2>{card.title}</h2>
            <p class="modified-date">
              Modified: {new Date(card.modified).toLocaleDateString()}
            </p>
          </a>
        {/each}
      {:else if $isAuthenticated}
        <div class="no-cards">
          <p>No cards available in your Yandex Disk folder.</p>
        </div>
      {:else}
        <div class="no-cards">
          <p>Cloud integration not configured. Please set VITE_YANDEX_DISK_TOKEN in your .env file.</p>
        </div>
      {/if}
      <a href="/card/new" class="card new-card">
        <h2>+ New Card</h2>
      </a>
    </div>
  {/if}
</div>
```

## Performance Considerations
1. **Indexing**: Ensure proper database indexes for fast title retrieval
2. **Batching**: Process cloud files in batches to avoid blocking the UI
3. **Caching**: Leverage browser caching for static assets
4. **Lazy Loading**: Consider lazy loading for large card collections

## Error Handling
1. **IndexedDB Unavailable**: Fallback to cloud-only operation
2. **Network Errors**: Retry mechanisms for cloud operations
3. **Parsing Errors**: Graceful handling of malformed markdown files
4. **Storage Quota**: Handle quota exceeded errors appropriately

## Testing Plan
1. **Unit Tests**: Test title extraction and storage logic
2. **Integration Tests**: Test full sync process
3. **Performance Tests**: Measure load times before and after optimization
4. **Edge Case Tests**: Test with various markdown file formats

## Success Metrics
1. **Load Time**: Main page loads in < 200ms for users with cached data
2. **User Experience**: Users see meaningful titles immediately
3. **Cloud API Usage**: Reduced cloud requests for title display
4. **Error Rate**: < 1% error rate for title retrieval operations
