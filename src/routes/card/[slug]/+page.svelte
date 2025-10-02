<script lang="ts">
  import { onMount } from 'svelte';
  import CombinedCardView from '../../../lib/components/CombinedCardView.svelte';
  import MarkdownPreview from '../../../lib/components/MarkdownPreview.svelte';
  import { loadCard, cardLoading, cardLoadSource, cardLoadTime, isOffline, cardStore } from '../../../lib/stores/cardStore';
  import { pageTitle } from '$lib/stores/titleStore';
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

  // Update page title when card data changes
  cardStore.subscribe((card) => {
    if (card) {
      pageTitle.set(card.title);
    } else if (slug === 'new') {
      pageTitle.set('New Card - MD Cards');
    } else {
      pageTitle.set('Card - MD Cards');
    }
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


<div class="container px-4">
  {#if loading}
    <div class="loading">
      <p>Loading card...</p>
      <div class="icon">
        <span class="fa fa-spinner fa-pulse"></span>
      </div>
    </div>
  {:else}
    <div class="status-bar">
      {#if loadSource}
        <span class="tag is-success">Loaded from {loadSource} in {loadTime.toFixed(2)}ms</span>
      {/if}

      {#if offlineMode}
        <span class="tag is-warning">Offline Mode - Changes will be synced when online</span>
      {/if}

      <button class="button" on:click={toggleViewMode}>
        Switch to {viewMode === 'combined' ? 'Markdown' : 'Editor'} View
      </button>
    </div>

    {#if viewMode === 'combined'}
      <CombinedCardView />
    {:else}
      <MarkdownPreview />
    {/if}
  {/if}
</div>
<style>
  .status-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    flex-wrap: wrap;
    gap: 1rem;
  }

  .loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 2rem;
  }
</style>
