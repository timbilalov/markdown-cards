<script lang="ts">
  import { onMount } from 'svelte';
  import CombinedCardView from '../../../lib/components/CombinedCardView.svelte';
  import MarkdownPreview from '../../../lib/components/MarkdownPreview.svelte';
  import {
    cardLoading, cardLoadSource, cardLoadTime, cardLoadWarning, isOffline, cardStore,
    cardDocument, cardSaveMessage,
    getCardDocumentSource, getCardDocumentMessage
  } from '../../../lib/stores/cardStore';
  import { app } from '$lib/stores/appFacade';
  const { loadCard, openNewCard, resetCard: resetCardDocument, migrateCard: migrateCurrentCardFormat } = app;
  import { pageTitle } from '$lib/stores/titleStore';
  import { page } from '$app/stores';

  let mounted = false;
  let loadedSlug: string | undefined;
  let viewMode: 'combined' | 'markdown' = 'combined';

  $: slug = $page.params.slug;
  $: isNew = slug === 'new' && $page.url?.searchParams.get('mode') !== 'edit';
  $: routeKey = `${slug}:${isNew}`;
  $: if (mounted && slug && routeKey !== loadedSlug) {
    loadedSlug = routeKey;
    viewMode = 'combined';
    if (isNew) {
      openNewCard();
    } else {
      void loadCard(slug);
    }
  }
  $: pageTitle.set($cardStore?.title ?? (isNew ? 'New Card - MD Cards' : 'Card - MD Cards'));
  $: document = $cardDocument;
  $: isBlocked = document !== null && (document.status !== 'loaded'
    || document.readOnlyReason !== undefined || document.result.status !== 'success');
  $: isLegacy = document?.status === 'loaded'
    && document.readOnlyReason === undefined
    && document.result.status === 'unsupported' && document.result.reason === 'missing-version';

  onMount(() => {
    mounted = true;
    return resetCardDocument;
  });

  function toggleViewMode() {
    viewMode = viewMode === 'combined' ? 'markdown' : 'combined';
  }
</script>


<div class="container px-4">
  {#if !mounted || $cardLoading}
    <div class="loading">
      <p>Loading card...</p>
      <div class="icon">
        <span class="fa fa-spinner fa-pulse"></span>
      </div>
    </div>
  {:else}
    <div class="status-bar">
      {#if $cardLoadSource}
        <span class="tag" class:is-success={$cardLoadSource === 'cloud'} class:is-warning={$cardLoadSource === 'indexeddb'}>Loaded from {$cardLoadSource} in {$cardLoadTime.toFixed(2)}ms</span>
      {/if}

      {#if $isOffline}
        <span class="tag is-warning">Нет подключения к сети. Save сохранит изменения локально; синхронизация продолжится после подключения.</span>
      {/if}

      <button class="button" on:click={toggleViewMode}>
        Switch to {viewMode === 'combined' ? 'Markdown' : 'Editor'} View
      </button>
    </div>

    {#if $cardLoadWarning}
      <p role="alert" class="notification is-warning">{$cardLoadWarning}</p>
    {/if}

    {#if isBlocked && document}
      <div class="toolbar">
        {#if isLegacy}
          <button class="button" on:click={migrateCurrentCardFormat}>Обновить формат</button>
        {/if}
        <button class="button" disabled>Save</button>
      </div>
      <p role="alert">{getCardDocumentMessage(document)}</p>
      {#if document.status === 'loaded'}
        <textarea
          class="textarea original-source"
          aria-label="Исходный Markdown"
          readonly
          rows="18"
          value={getCardDocumentSource(document)}
        ></textarea>
      {/if}
    {:else if viewMode === 'combined'}
      <CombinedCardView />
    {:else}
      <MarkdownPreview formatVersion={document ? 1 : null} />
    {/if}
    {#if $cardSaveMessage}
      <p role="status">{$cardSaveMessage}</p>
    {/if}
  {/if}
</div>
<style>
  .toolbar {
    display: flex;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .original-source {
    width: 100%;
    font-family: monospace;
  }

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
