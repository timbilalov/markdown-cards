<script lang="ts">
  import { onMount } from 'svelte';
  import { pageTitle } from '$lib/stores/titleStore';
  import { app } from '$lib/stores/appFacade';
  import { isAuthenticated } from '$lib/stores/cloudStore';
  import { deriveBoardColumns } from '$lib/domain/board';
  import type { BoardCard, BoardColumn } from '$lib/domain/types';

  pageTitle.set('MD Cards - Main Page');

  let cards: BoardCard[] = [];
  let loading = true;
  let offlineMode = false;
  let loadSource: 'indexeddb' | 'cloud' | 'mixed' = 'cloud';
  let loadTime = 0;
  let error: string | null = null;
  let columns: BoardColumn[] = [];
  $: columns = deriveBoardColumns(cards);

  onMount(() => {
    const controller = new AbortController();
    void app.loadBoard(state => {
      cards = state.cards; loading = state.loading; offlineMode = state.offline;
      loadSource = state.source; loadTime = state.elapsed;
      error = state.error;
    }, controller.signal);
    return () => controller.abort();
  });
</script>

<div class="container px-4">
  {#if error}<p role="alert">Не удалось загрузить доску: {error}</p>{/if}
  <div class="header">
    <div class="status-bar">
      {#if loading}
        <span class="tag">Loading...</span>
      {:else if error}
        <span class="tag is-warning">{cards.length ? 'Показаны сохранённые заметки' : 'Список заметок недоступен'}</span>
      {:else}
        <span class="tag is-success">Loaded from {loadSource} in {loadTime.toFixed(2)}ms</span>
      {/if}

      {#if offlineMode}
        <span class="tag is-warning">Offline Mode</span>
      {/if}
    </div>
  </div>

  {#if loading && cards.length === 0}
    <div class="loading">Loading files...</div>
  {:else}
    <div class="kanban-board columns is-mobile">
      {#if cards.length > 0}
        {#each columns as column}
          <div class="kanban-column column">
            <h2 class="column-title">
              {column.status}
              <span class="card-count">({column.cards.length})</span>
            </h2>

            {#each column.cards as card}
              <a href={`/card/${encodeURIComponent(card.filename)}${card.filename === 'new' ? '?mode=edit' : ''}`} class="card" data-source={card.source}>
                {#if card.image}
                  <div class="card-image">
                    <img src={card.image} alt={card.title} />
                  </div>
                {/if}
                <div class="card-content">
                  <h3>{card.title}</h3>
                  {#if card.readOnly}<span class="tag">Только чтение</span>{/if}
                  <p class="modified-date">
                    {#if card.modified === undefined}
                      Дата изменения неизвестна
                    {:else}
                      Modified: {new Date(card.modified).toLocaleDateString()}
                    {/if}
                  </p>
                  <span class="source-indicator" title="Data source: {card.source}">
                    <span class="icon">
                      <span class="fa {card.source === 'indexeddb' ? 'fa-floppy-o' : card.source === 'cloud' ? 'fa-cloud' : card.source === 'mixed' ? 'fa-refresh' : 'fa-file'}"></span>
                    </span>
                  </span>
                </div>
              </a>
            {/each}

            <a href="/card/new" class="card">
              <div class="card-content">
                <h3>+ New Card</h3>
              </div>
            </a>
          </div>
        {/each}
      {:else if $isAuthenticated}
        <div class="no-cards">
          <p>{error ? 'Не удалось получить список заметок.' : 'No cards available in your cloud storage.'}</p>
          <a href="/card/new">+ New Card</a>
        </div>
      {:else}
        <div class="no-cards">
          <p><a href="/login">Войдите</a>, чтобы загрузить заметки из облака.</p>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
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

  .loading {
    text-align: center;
    padding: 2rem;
    font-size: 1.2rem;
    color: #6c757d;
  }

  .kanban-board {
    overflow-x: auto;
    gap: 1rem;
    padding: 1rem 0;
  }

  .kanban-column {
    min-width: 300px;
  }

  .card {
    display: block;
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
