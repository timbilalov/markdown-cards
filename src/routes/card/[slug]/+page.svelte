<script lang="ts">
  import { onMount } from 'svelte';
  import CombinedCardView from '../../../lib/components/CombinedCardView.svelte';
  import MarkdownPreview from '../../../lib/components/MarkdownPreview.svelte';
  import { loadCard, cardLoading, cardLoadSource, cardLoadTime, isOffline } from '../../../lib/stores/cardStore';
  import { page } from '$app/stores';
  import { performanceMonitor } from '$lib/services/performanceMonitor';

  let slug: string | undefined;
  let loading = false;
  let loadSource: 'indexeddb' | 'cloud' | 'memory' | null = null;
  let loadTime = 0;
  let offlineMode = false;
  let viewMode: 'combined' | 'markdown' = 'combined';

  // Subscribe to store values
  cardLoading.subscribe(value => {
    loading = value;
  });

  cardLoadSource.subscribe(value => {
    loadSource = value;
  });

  cardLoadTime.subscribe(value => {
    loadTime = value;
  });

  isOffline.subscribe(value => {
    offlineMode = value;
  });

  onMount(async () => {
    slug = $page.params.slug;
    if (slug && slug !== 'new') {
      await loadCard(slug);
    }
  });

  function toggleViewMode() {
    viewMode = viewMode === 'combined' ? 'markdown' : 'combined';
  }
</script>


<div class="card-container">
  {#if loading}
    <div class="loading">
      <p>Loading card...</p>
      <div class="spinner"></div>
    </div>
  {:else}
    <div class="status-bar">
      {#if loadSource}
        <span class="status success">Loaded from {loadSource} in {loadTime.toFixed(2)}ms</span>
      {/if}

      {#if offlineMode}
        <span class="status offline">Offline Mode - Changes will be synced when online</span>
      {/if}

      <button class="toggle-view" on:click={toggleViewMode}>
        Switch to {viewMode === 'combined' ? 'Markdown' : 'Editor'} View
      </button>
    </div>

    {#if viewMode === 'combined'}
      <CombinedCardView />
    {:else}
      <div class="markdown-preview-container">
        <MarkdownPreview />
      </div>
    {/if}
  {/if}
</div>
<style>
  .card-container {
    max-width: 800px;
    margin: 0 auto;
    padding: 20px;
  }

  .status-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    flex-wrap: wrap;
    gap: 1rem;
  }

  .status {
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.875rem;
  }

  .status.success {
    background-color: #d4edda;
    color: #155724;
  }

  .status.offline {
    background-color: #f8d7da;
    color: #721c24;
  }


  .toggle-view {
    background-color: #007bff;
    color: white;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
  }

  .toggle-view:hover {
    background-color: #0056b3;
  }

  .loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 2rem;
  }

  .spinner {
    width: 40px;
    height: 40px;
    border: 4px solid #f3f3f3;
    border-top: 4px solid #007bff;
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin-top: 1rem;
  }

  .markdown-preview-container {
    background: white;
    border-radius: 8px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
    padding: 1.5rem;
    margin: 1rem 0;
  }

  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
</style>
