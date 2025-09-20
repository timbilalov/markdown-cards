<script lang="ts">
  import { onMount } from 'svelte';
  import { cloudFiles, isAuthenticated, syncFilesFromCloud } from '$lib/stores/cloudStore';
  import { dbInitialized, initDB } from '$lib/stores/dbStore';
  import type { CloudFile } from '$lib/types/cloud';

  interface Card {
    id: string;
    title: string;
    modified: string;
  }

  let cards: Card[] = [];
  let loading = true;

  onMount(async () => {
    // Initialize the database
    await initDB();

    // Try to sync files from cloud
    await syncFilesFromCloud();
    loading = false;
  });

  // Derive cards from cloud files
  $: cards = $cloudFiles
    .filter((file: CloudFile) => file.name.endsWith('.md'))
    .map((file: CloudFile) => {
      // Extract ID from filename (remove .md extension)
      const id = file.name.replace('.md', '');
      // For now, we'll use the filename as title
      // In a more complete implementation, we'd parse the file to get the actual title
      return {
        id: id,
        title: id,
        modified: file.modified
      };
    });
</script>

<div class="container">
  <div class="header">
    <h1>Markdown Cards</h1>
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

<style>
  .container {
    max-width: 800px;
    margin: 0 auto;
    padding: 2rem;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 2rem;
  }

  .loading {
    text-align: center;
    padding: 2rem;
    font-size: 1.2rem;
    color: #6c757d;
  }

  .card-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1rem;
    margin-top: 2rem;
  }

  .card {
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    padding: 1.5rem;
    text-decoration: none;
    color: inherit;
    transition: transform 0.2s, box-shadow 0.2s;
  }

  .card:hover {
    transform: translateY(-5px);
    box-shadow: 0 5px 15px rgba(0,0,0,0.1);
  }

  .new-card {
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: #f8f9fa;
    color: #6c757d;
    font-weight: bold;
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
    font-size: 0.9rem;
    color: #6c757d;
    margin-top: 0.5rem;
  }
</style>
