<script lang="ts">
  import { onMount } from 'svelte';
  import { app } from '$lib/stores/appFacade';
  import StorageTable from '$lib/components/StorageTable.svelte';
  import StorageSyncPanel from '$lib/components/StorageSyncPanel.svelte';
  import StorageCachePanel from '$lib/components/StorageCachePanel.svelte';
  import StorageLoadingDialog from '$lib/components/StorageLoadingDialog.svelte';
  import type { StorageComparison } from '$lib/services/storageManagement';
  import type { StorageInventoryProgress } from '$lib/application/storageInventory';

  let model = $state<StorageComparison | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let progress = $state<StorageInventoryProgress | null>(null);
  let syncBusy = $state(false);
  let cacheBusy = $state(false);
  let controller: AbortController | undefined;

  async function refresh() {
    controller?.abort();
    controller = new AbortController();
    const current = controller;
    loading = true;
    progress = null;
    error = null;
    try {
      const result = await app.loadStorageComparison(current.signal, value => {
        if (!current.signal.aborted) progress = value;
      });
      if (!current.signal.aborted) model = result;
    } catch (reason) {
      if (!current.signal.aborted)
        error = reason instanceof Error ? reason.message : 'Не удалось получить версии.';
    } finally {
      if (!current.signal.aborted) loading = false;
    }
  }

  onMount(() => {
    void refresh();
    return () => controller?.abort();
  });
</script>

<svelte:head><title>Хранилища · Markdown Cards</title></svelte:head>
<main class="container p-4" aria-busy={loading || syncBusy}>
  <h1 class="title">Хранилища и версии заметок</h1>
  <p class="mb-4">
    Основное хранилище задаётся на сервере. На этой странице доступны также резервные облака и
    локальные копии каждого подключения.
  </p>
  <p class="mb-4">
    Пути Dropbox указаны в пределах области доступа приложения. «/» обозначает её корень.
  </p>
  <button class="button mb-4" disabled={loading || cacheBusy || syncBusy} onclick={refresh}>
    Обновить версии
  </button>
  {#if error}
    <p role="alert" class="notification is-danger">{error}</p>
  {/if}
  {#if model}
    {#if model.catalogError}
      <p role="alert" class="notification is-warning">
        {model.catalogError}
      </p>
    {/if}
    <StorageCachePanel {model} oncomplete={refresh} onbusy={value => (cacheBusy = value)} />
    <fieldset disabled={cacheBusy || loading}>
      <StorageSyncPanel {model} oncomplete={refresh} onbusy={value => (syncBusy = value)} />
    </fieldset>
    <StorageTable {model} />
  {/if}
</main>
{#if loading || syncBusy}
  <StorageLoadingDialog {progress} syncing={syncBusy && !loading} />
{/if}

<style>
  fieldset {
    min-inline-size: 0;
  }
</style>
