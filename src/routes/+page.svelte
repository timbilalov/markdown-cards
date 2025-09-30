<script lang="ts">
  import { onMount } from 'svelte';
  import { cloudFiles, isAuthenticated, syncFilesFromCloud, isOffline, loadCardFromCloud } from '$lib/stores/cloudStore';
  import { dbInitialized, initDB, loadLocalCards } from '$lib/stores/dbStore';
  import { performanceMonitor } from '$lib/services/performanceMonitor';
  import { cacheManager } from '$lib/services/cacheManager';
  import type { CloudFile } from '$lib/types/cloud';
  import type { Card } from '$lib/utils/markdownSerializer';

  interface CardDisplay {
    id: string;
    title: string;
    modified: string;
    source: 'indexeddb' | 'cloud' | 'filename' | 'mixed';
    status?: string;
  }

  // Define default kanban board statuses
  const defaultStatuses = [
    'Предстоящие', // Upcoming
    'В процессе',  // In Progress
    'Done'  // Completed
  ];

  // Define status display names for better UI
  const statusDisplayNames: Record<string, string> = {
    'Предстоящие': 'Предстоящие',
    'В процессе': 'В процессе',
    'Done': 'Done'
  };

  let cards: CardDisplay[] = [];
  let loading = true;
  let dbReady = false;
  let offlineMode = false;
  let loadSource: 'indexeddb' | 'cloud' | 'mixed' = 'cloud';
  let loadTime = 0;
  let groupedCards: Record<string, CardDisplay[]> = {};

  // Function to group cards by status
  function groupCardsByStatus(cards: CardDisplay[]): Record<string, CardDisplay[]> {
    const grouped: Record<string, CardDisplay[]> = {};

    // Initialize with default statuses
    defaultStatuses.forEach(status => {
      grouped[status] = [];
    });

    // Group cards by their status
    cards.forEach(card => {
      const status = card.status || 'Без статуса'; // Default for cards without status
      if (!grouped[status]) {
        grouped[status] = [];
      }
      grouped[status].push(card);
    });

    return grouped;
  }

  // Get all unique statuses from cards
  function getAllStatuses(cards: CardDisplay[]): string[] {
    const statuses = new Set<string>();
    cards.forEach(card => {
      statuses.add(card.status || 'Без статуса');
    });
    return Array.from(statuses);
  }

  onMount(async () => {
    const startTime = performance.now();

    // Initialize the database
    await initDB();
    dbReady = true;

    // Try to load cards from IndexedDB first for instant display
    const localCards = await loadLocalCards();
    let localCardMap: Map<string, Card> = new Map();

    if (localCards.length > 0) {
      // Create a map for easy lookup
      localCards.forEach(card => {
        localCardMap.set(card.meta.id, card);
      });

      cards = localCards.map(card => ({
        id: card.meta.id,
        title: card.title,
        modified: new Date(card.meta.modified).toISOString(),
        source: 'indexeddb',
        status: card.status
      }));

      loadSource = 'indexeddb';
      loadTime = performance.now() - startTime;
      loading = false;

      // Record performance metrics
      performanceMonitor.recordCacheHit('main_page', true);

      // Group cards by status
      groupedCards = groupCardsByStatus(cards);
    }

    // Try to sync files from cloud for updated data
    try {
      await syncFilesFromCloud();

      // If we loaded from IndexedDB, check if cloud has newer data
      if (loadSource === 'indexeddb') {
        // Compare timestamps between local and cloud data
        let hasNewerCloudData = false;
        const updatedCards: CardDisplay[] = [];
        const cloudFileMap = new Map<string, CloudFile>();

        // Create a map of cloud files for easy lookup
        $cloudFiles
          .filter((file: CloudFile) => file.name.endsWith('.md'))
          .forEach((file: CloudFile) => {
            const id = file.name.replace('.md', '');
            cloudFileMap.set(id, file);
          });

        // Process all cloud files to determine what needs updating
        for (const [id, file] of cloudFileMap) {
          const cloudModified = new Date(file.modified).getTime();
          const localCard = localCardMap.get(id);

          if (localCard) {
            // Compare modification times
            const localModified = localCard.meta.modified;

            // If cloud version is newer, mark it
            if (cloudModified > localModified) {
              hasNewerCloudData = true;
              updatedCards.push({
                id: id,
                title: localCard.title, // Will be updated with actual title from cloud if we fetch it
                modified: file.modified,
                source: 'mixed', // Mixed because we're combining local and cloud data
                status: localCard.status
              });
            } else {
              // Local version is newer or same, keep it
              updatedCards.push({
                id: id,
                title: localCard.title,
                modified: new Date(localModified).toISOString(),
                source: 'indexeddb',
                status: localCard.status
              });
            }
          } else {
            // New card only in cloud
            hasNewerCloudData = true;
            updatedCards.push({
              id: id,
              title: id, // Will be updated with actual title from cloud if we fetch it
              modified: file.modified,
              source: 'cloud',
              status: undefined
            });
          }
        }

        // Also check for local cards that don't exist in cloud (deleted in cloud)
        for (const [id, localCard] of localCardMap) {
          if (!cloudFileMap.has(id)) {
            // Card exists locally but not in cloud, keep local version
            // Only add if not already in updatedCards
            if (!updatedCards.some(card => card.id === id)) {
              updatedCards.push({
                id: id,
                title: localCard.title,
                modified: new Date(localCard.meta.modified).toISOString(),
                source: 'indexeddb',
                status: localCard.status
              });
            }
          }
        }

        // For cards with newer cloud data, fetch actual titles from cloud
        if (hasNewerCloudData) {
          for (const card of updatedCards) {
            const file = cloudFileMap.get(card.id);
            if (file && card.source === 'mixed') {
              try {
                // Load the actual card from cloud to get the real title
                const cloudCard = await loadCardFromCloud(file);
                if (cloudCard) {
                  card.title = cloudCard.title;
                }
              } catch (error) {
                console.warn(`Could not load card ${card.id} from cloud:`, error);
                // Keep the existing title if we can't load from cloud
              }
            } else if (file && card.source === 'cloud') {
              try {
                // Load the actual card from cloud to get the real title
                const cloudCard = await loadCardFromCloud(file);
                if (cloudCard) {
                  card.title = cloudCard.title;
                }
              } catch (error) {
                console.warn(`Could not load card ${card.id} from cloud:`, error);
                // Keep the filename as title if we can't load from cloud
              }
            }
          }
        }

        // Update cards array with merged data
        cards = updatedCards;
        loadSource = 'mixed'; // Always set to mixed when we've checked both sources

        // Group cards by status
        groupedCards = groupCardsByStatus(cards);
      }
    } catch (error) {
      console.warn('Could not sync with cloud:', error);
      offlineMode = true;

      // Even in offline mode, we still have mixed loading (tried both sources)
      if (loadSource === 'indexeddb') {
        loadSource = 'mixed';
      }
    }

    // If we didn't get cards from IndexedDB, derive them from cloud files
    if (cards.length === 0) {
      // Derive cards from cloud files
      cards = $cloudFiles
        .filter((file: CloudFile) => file.name.endsWith('.md'))
        .map((file: CloudFile) => {
          // Extract ID from filename (remove .md extension)
          const id = file.name.replace('.md', '');
          // Use the filename as title initially
          // In a more complete implementation, we'd parse the file to get the actual title
          return {
            id: id,
            title: id,
            modified: file.modified,
            source: 'cloud',
            status: undefined
          };
        });

      loadSource = cards.length > 0 ? 'cloud' : 'indexeddb';
      loadTime = performance.now() - startTime;
      loading = false;

      // Record performance metrics
      performanceMonitor.recordCacheHit('main_page', false);

      // Group cards by status
      groupedCards = groupCardsByStatus(cards);
    } else if (loadSource !== 'mixed') {
      // We had cards from IndexedDB but didn't update from cloud
      loadSource = 'mixed';
      loadTime = performance.now() - startTime;
      loading = false;
    } else {
      // We already set loadSource to 'mixed' in the cloud sync section
      loadTime = performance.now() - startTime;
      loading = false;

      // Group cards by status
      groupedCards = groupCardsByStatus(cards);
    }

    // Validate cache periodically
    setTimeout(async () => {
      await cacheManager.validateCache();
    }, 5000); // Validate after 5 seconds
  });
</script>

<div class="container">
  <div class="header">
    <h1>Markdown Cards</h1>
    <div class="status-bar">
      {#if loading}
        <span class="status loading">Loading...</span>
      {:else}
        <span class="status success">Loaded from {loadSource} in {loadTime.toFixed(2)}ms</span>
      {/if}

      {#if offlineMode}
        <span class="status offline">Offline Mode</span>
      {/if}
    </div>
  </div>

  {#if loading && cards.length === 0}
    <div class="loading">Loading files...</div>
  {:else}
    <div class="kanban-board">
      {#if cards.length > 0}
        {#each Object.entries(groupedCards) as [status, statusCards]}
          <div class="kanban-column">
            <h2 class="column-title">
              {statusDisplayNames[status] || status}
              <span class="card-count">({statusCards.length})</span>
            </h2>
            <div class="card-list">
              {#each statusCards as card}
                <a href={`/card/${card.id}`} class="card" data-source={card.source}>
                  <h3>{card.title}</h3>
                  <p class="modified-date">
                    Modified: {new Date(card.modified).toLocaleDateString()}
                  </p>
                  <span class="source-indicator" title="Data source: {card.source}">
                    {card.source === 'indexeddb' ? '💾' : card.source === 'cloud' ? '☁️' : card.source === 'mixed' ? '🔄' : '📄'}
                  </span>
                </a>
              {/each}
              <a href="/card/new" class="card new-card">
                <h3>+ New Card</h3>
              </a>
            </div>
          </div>
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
    </div>
  {/if}
</div>

<style>
  .container {
    max-width: 100%;
    margin: 0 auto;
    padding: 2rem;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 2rem;
    flex-wrap: wrap;
    gap: 1rem;
  }

  .status-bar {
    display: flex;
    gap: 1rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .status {
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.875rem;
  }

  .status.loading {
    background-color: #e0e0e0;
    color: #666;
  }

  .status.success {
    background-color: #d4edda;
    color: #155724;
  }

  .status.offline {
    background-color: #f8d7da;
    color: #721c24;
  }

  .loading {
    text-align: center;
    padding: 2rem;
    font-size: 1.2rem;
    color: #6c757d;
  }

  .kanban-board {
    display: flex;
    overflow-x: auto;
    gap: 1rem;
    padding: 1rem 0;
  }

  .kanban-column {
    min-width: 300px;
    background-color: #f8f9fa;
    border-radius: 8px;
    padding: 1rem;
  }

  .column-title {
    font-size: 1.2rem;
    margin-bottom: 1rem;
    padding-bottom: 0.5rem;
    border-bottom: 2px solid #e0e0e0;
  }

  .card-count {
    font-size: 0.9rem;
    color: #6c757d;
    margin-left: 0.5rem;
  }

  .card-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .card {
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    padding: 1rem;
    text-decoration: none;
    color: inherit;
    transition: transform 0.2s, box-shadow 0.2s;
    position: relative;
    background-color: white;
  }

  .card:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 8px rgba(0,0,0,0.1);
  }

  .new-card {
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: #f8f9fa;
    color: #6c757d;
    font-weight: bold;
    min-height: 100px;
  }

  .new-card:hover {
    background-color: #e9ecef;
    color: #495057;
  }

  .no-cards {
    grid-column: 1 / -1;
    text-align: center;
    padding: 2rem;
    background-color: #f8f9fa;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    color: #6c757d;
  }

  .modified-date {
    font-size: 0.8rem;
    color: #6c757d;
    margin-top: 0.5rem;
  }

  .source-indicator {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    font-size: 1.2rem;
  }
</style>
