<script lang="ts">
  import { onMount } from 'svelte';
  import type { StorageInventoryProgress } from '$lib/application/storageInventory';

  let { progress, syncing }: { progress: StorageInventoryProgress | null; syncing: boolean } =
    $props();
  let dialog: HTMLDialogElement;
  const percent = $derived(
    !syncing && progress?.phase === 'reading'
      ? progress.total > 0
        ? Math.floor((progress.completed / progress.total) * 100)
        : 100
      : undefined
  );
  const stage = $derived(
    syncing
      ? 'Синхронизируем заметки…'
      : !progress
        ? 'Получаем список хранилищ…'
        : progress.phase === 'listing'
          ? 'Получаем списки файлов…'
          : progress.completed === progress.total
            ? 'Подготавливаем таблицу версий…'
            : 'Читаем версии заметок…'
  );

  onMount(() => {
    dialog.showModal();
    return () => dialog.close();
  });
</script>

<dialog
  bind:this={dialog}
  class="box"
  aria-labelledby="storage-loading-title"
  aria-describedby="storage-loading-description"
  aria-modal="true"
  oncancel={event => event.preventDefault()}
>
  <h2 id="storage-loading-title" class="title is-4">Обновление хранилищ</h2>
  <p id="storage-loading-description" class="mb-4">
    Пожалуйста, дождитесь завершения. После обновления интерфейс станет доступен.
  </p>
  <div role="status" aria-live="polite" aria-atomic="true">
    <p class="mb-3">{stage}</p>
    {#if percent !== undefined && progress}
      <p class="progress-details mb-2">
        <span>Обработано копий: {progress.completed} из {progress.total}</span>
        <strong>{percent}%</strong>
      </p>
    {:else if !syncing && progress?.phase === 'listing'}
      <p class="mb-2">Проверено хранилищ: {progress.completed} из {progress.total}</p>
    {/if}
  </div>
  <progress class="progress is-info" value={percent} max="100" aria-label="Загрузка версий заметок">
    {percent === undefined ? '' : `${percent}%`}
  </progress>
</dialog>

<style>
  dialog {
    margin: auto;
    width: min(32rem, calc(100vw - 2rem));
    max-height: calc(100dvh - 2rem);
    overflow: auto;
  }
  dialog:not([open]) {
    display: none;
  }
  dialog::backdrop {
    background: rgb(0 0 0 / 0.65);
  }
  .progress-details {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.5rem;
  }
</style>
