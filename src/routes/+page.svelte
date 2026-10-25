<script lang="ts">
  import { onMount } from 'svelte';
  import { pageTitle } from '$lib/stores/titleStore';
  import { app } from '$lib/stores/appFacade';
  import { isAuthenticated } from '$lib/stores/cloudStore';
  import { deriveBoardColumns } from '$lib/domain/board';
  import type { BoardLoader, BoardLoadState } from '$lib/application/loadBoard';
  import type { BoardCard, BoardColumn } from '$lib/domain/types';

  pageTitle.set('MD Cards - Main Page');

  let cards: BoardCard[] = [];
  let loading = true;
  let progress: BoardLoadState['progress'] = null;
  let pendingFilenames = new Set<string>();
  let failedFilenames = new Set<string>();
  let board: BoardLoader | null = null;
  let offlineMode = false;
  let loadSource: 'indexeddb' | 'cloud' | 'mixed' = 'cloud';
  let loadTime = 0;
  let error: string | null = null;
  let columns: BoardColumn[] = [];
  $: columns = deriveBoardColumns(cards);

  onMount(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    board = app.createBoardLoader(state => {
      cards = state.cards; loading = state.loading; offlineMode = state.offline;
      progress = state.progress;
      pendingFilenames = new Set(state.pendingFilenames);
      failedFilenames = new Set(state.failedFilenames);
      loadSource = state.source; loadTime = state.elapsed;
      error = state.error;
      clearTimeout(timer);
      if (!state.loading && state.nextRefreshAt !== null && state.pendingFilenames.length === 0) {
        timer = setTimeout(() => {
          if (document.visibilityState !== 'hidden') void board?.load();
        }, Math.max(1000, state.nextRefreshAt - Date.now()));
      }
    }, controller.signal);
    void board.load();
    const onVisible = () => { if (document.visibilityState !== 'hidden') void board?.load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible);
      controller.abort(); board = null;
    };
  });
</script>

<div class="container px-4">
  {#if error}<p role="alert">Не удалось загрузить доску: {error}</p>{/if}
  <div class="header">
    <div class="status-bar">
      {#if loading}
        <div class="board-progress" role="status" aria-live="polite" aria-atomic="true">
          <span class="loading-spinner" aria-hidden="true"></span>
          {#if progress && progress.total > 0}
            <span>Обновление заметок <span class="progress-count">{progress.completed} / {progress.total}</span></span>
            <progress max={progress.total} value={progress.completed} aria-label="Загрузка заметок"></progress>
          {:else}
            <span>Загрузка заметок…</span>
          {/if}
        </div>
      {:else if error}
        <span class="tag is-warning">{cards.length ? 'Показаны сохранённые заметки' : 'Список заметок недоступен'}</span>
      {:else}
        <span class="tag is-success">Loaded from {loadSource} in {loadTime.toFixed(2)}ms</span>
      {/if}

      {#if offlineMode}
        <span class="tag is-warning">Offline Mode</span>
      {/if}
    </div>
    <button type="button" class="button is-small is-light" disabled={loading || pendingFilenames.size > 0}
      title="Загрузить все заметки из облака" aria-label="Обновить все заметки из облака"
      onclick={() => { void board?.refresh(); }}>
      <span class="icon is-small"><span class="fa fa-refresh" aria-hidden="true"></span></span>
      <span>Обновить</span>
    </button>
  </div>

  {#if loading && cards.length === 0}
    <div class="loading">Loading files...</div>
  {:else}
    <div class="kanban-board columns is-mobile">
      {#if cards.length > 0}
        {#each columns as column (column.status)}
          <div class="kanban-column column">
            <h2 class="column-title">
              {column.status}
              <span class="card-count">({column.cards.length})</span>
            </h2>

            {#each column.cards as card (card.filename)}
              <div class="board-card" class:has-load-error={failedFilenames.has(card.filename)}>
                <a href={`/card/${encodeURIComponent(card.filename)}${card.filename === 'new' ? '?mode=edit' : ''}`} class="card" data-source={card.source} aria-busy={pendingFilenames.has(card.filename)}>
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
                    {#if !failedFilenames.has(card.filename)}
                      <span class="source-indicator" title={pendingFilenames.has(card.filename) ? 'Загрузка из облака' : `Data source: ${card.source}`}>
                        <span class="icon">
                          {#if pendingFilenames.has(card.filename)}
                            <span class="loading-spinner card-loading" role="img" aria-label="Загрузка из облака"></span>
                          {:else}
                            <span class="fa {card.source === 'indexeddb' ? 'fa-floppy-o' : card.source === 'cloud' ? 'fa-cloud' : card.source === 'mixed' ? 'fa-refresh' : 'fa-file'}"></span>
                          {/if}
                        </span>
                      </span>
                    {/if}
                  </div>
                </a>
                {#if failedFilenames.has(card.filename)}
                  <button type="button" class="card-load-error"
                    disabled={loading && progress === null}
                    title="Не удалось загрузить из облака. Повторить загрузку"
                    aria-label={`Повторить загрузку заметки «${card.title}»`}
                    onclick={() => { void board?.retry(card.filename); }}>
                    <span class="fa fa-exclamation-triangle" aria-hidden="true"></span>
                    Повторить
                  </button>
                {/if}
              </div>
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

  .board-progress {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    color: var(--bulma-text-weak, #6c757d);
    font-size: 0.8125rem;
    min-height: 1.5rem;
  }

  .progress-count {
    margin-left: 0.25rem;
    font-variant-numeric: tabular-nums;
  }

  .board-progress progress {
    width: 4rem;
    height: 0.25rem;
    accent-color: currentColor;
  }

  .loading-spinner {
    width: 0.75rem;
    height: 0.75rem;
    border: 1.5px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .card-loading {
    width: 1rem;
    height: 1rem;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .loading-spinner { animation: none; }
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

  .board-card {
    position: relative;
    margin-bottom: 1.5rem;
  }

  .has-load-error h3 {
    padding-right: 5rem;
  }

  .card-load-error {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.25rem 0.4rem;
    border: 1px solid currentColor;
    border-radius: 0.375rem;
    background: var(--bulma-scheme-main, #fff);
    color: var(--bulma-danger, #d33c40);
    font: inherit;
    font-size: 0.75rem;
    cursor: pointer;
  }

  .card-load-error:hover {
    background: var(--bulma-danger-soft, #fff0f0);
  }

  .card-load-error:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
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
