<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { app } from '$lib/stores/appFacade';
  import type { StorageComparison } from '$lib/services/storageManagement';
  import type { LocalCacheInfo } from '$lib/services/localCacheManagement';
  import { storageFolderLabel } from '$lib/utils/storageLocationLabel';

  let {
    model,
    oncomplete,
    onbusy = () => {}
  }: {
    model: StorageComparison;
    oncomplete: () => Promise<void>;
    onbusy?: (busy: boolean) => void;
  } = $props();
  let caches = $state<LocalCacheInfo[]>([]);
  let selected = $state<LocalCacheInfo | null>(null);
  let busy = $state(false);
  let loading = $state(true);
  let blocked = $state(false);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let dialog: HTMLDialogElement;
  let alive = true;
  let request = 0;
  const statuses: Record<LocalCacheInfo['status'], string> = {
    active: 'Текущее подключение',
    'in-use': 'Используется в этой вкладке',
    reserve: 'Резервное подключение',
    historical: 'Прежнее подключение',
    unverified: 'Подключение не проверено'
  };

  async function load(current: StorageComparison) {
    const revision = ++request;
    loading = true;
    try {
      const result = await app.readLocalCaches(current);
      if (alive && revision === request) {
        caches = result;
        error = null;
      }
    } catch {
      if (alive && revision === request) {
        caches = [];
        error = 'Не удалось проверить локальные кэши. Обновите версии.';
      }
    } finally {
      if (alive && revision === request) loading = false;
    }
  }

  async function confirm(cache: LocalCacheInfo) {
    selected = cache;
    error = null;
    blocked = false;
    await tick();
    dialog.showModal();
  }

  async function remove() {
    if (!selected || busy) return;
    const cache = selected;
    busy = true;
    blocked = false;
    error = null;
    onbusy(true);
    try {
      const result = await app.deleteLocalCache(cache.id, () => {
        if (alive) blocked = true;
      });
      if (!alive) return;
      if (result.status === 'blocked') {
        error = result.reason;
        return;
      }
      dialog.close();
      selected = null;
      notice = result.warning ?? `Кэш «${cache.label}» удалён.`;
      await oncomplete();
      if (alive) await load(model);
    } catch {
      if (alive) error = 'Не удалось удалить кэш. Обновите версии и повторите попытку.';
    } finally {
      busy = false;
      onbusy(false);
    }
  }

  onMount(() => {
    alive = true;
    return () => {
      alive = false;
    };
  });

  $effect(() => {
    void load(model);
  });
</script>

<section class="box" aria-label="Локальные кэши">
  <h2 class="title is-4">Локальные кэши</h2>
  <p class="mb-3">
    Кэши этого браузера. Старое подключение больше не совпадает с настройками сервера, но в его кэше
    могут оставаться нужные заметки. Перед удалением сравните версии и при необходимости
    синхронизируйте их.
  </p>
  {#if notice}
    <p role="status" class="notification is-success is-light">{notice}</p>
  {/if}
  {#if error && !selected}
    <p role="alert" class="notification is-danger is-light">{error}</p>
  {/if}
  {#if loading}
    <p role="status">Проверка локальных кэшей…</p>
  {/if}
  <div class="table-container">
    <table class="table is-fullwidth">
      <thead>
        <tr>
          <th>Кэш</th>
          <th>Папка облака</th>
          <th>Использование</th>
          <th>Содержимое</th>
          <th>Удаление</th>
        </tr>
      </thead>
      <tbody>
        {#each caches as cache (cache.id)}
          <tr data-cache-id={cache.id}>
            <th scope="row">{cache.label}</th>
            <td data-cache-folder>{storageFolderLabel(cache.rootPath)}</td>
            <td>{statuses[cache.status]}</td>
            <td>
              {#if cache.contents}
                <div>Заметок: {cache.contents.notes}</div>
                <div>Локальных изменений: {cache.contents.drafts}</div>
                <div>Незавершённых операций: {cache.contents.pendingOperations}</div>
                {#if cache.contents.historicalOperations}
                  <div>
                    Записей прежней очереди: {cache.contents.historicalOperations}
                  </div>
                {/if}
                {#if cache.contents.archives}
                  <div>
                    Архивных записей: {cache.contents.archives}
                  </div>
                {/if}
              {:else}Не удалось прочитать{/if}
            </td>
            <td>
              <button
                class="button is-danger is-light is-small"
                disabled={busy || loading || Boolean(cache.blockedReason)}
                onclick={() => confirm(cache)}
                aria-label={`Удалить кэш: ${cache.label}`}
              >
                Удалить кэш
              </button>
              {#if cache.blockedReason}
                <small>{cache.blockedReason}</small>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>
<dialog
  bind:this={dialog}
  class="box"
  aria-labelledby="delete-cache-title"
  oncancel={event => {
    if (busy) event.preventDefault();
  }}
  onclose={() => {
    if (!busy) selected = null;
  }}
>
  {#if selected}
    <h3 id="delete-cache-title" class="title is-5">Удалить локальный кэш?</h3>
    <p class="mb-3">{selected.label}</p>
    <p class="mb-3">Папка облака: {storageFolderLabel(selected.rootPath)}</p>
    <p class="mb-3">
      Будут безвозвратно удалены все данные этого кэша: заметки, локальные изменения, очередь
      отправки и архив. Файлы в облачных хранилищах сохранятся.
    </p>
    {#if selected.contents}
      <p class="mb-3">
        Заметок: {selected.contents.notes}. Локальных изменений: {selected.contents.drafts}.
        Незавершённых операций: {selected.contents.pendingOperations}. Записей прежней очереди: {selected
          .contents.historicalOperations}. Архивных записей: {selected.contents.archives}.
      </p>
    {/if}
    {#if selected.status === 'reserve'}
      <p class="mb-3">Кэш будет создан снова при использовании этого подключения.</p>
    {/if}
    {#if blocked}
      <p role="status" class="notification is-warning is-light">
        Удаление ожидает закрытия другой вкладки с этим кэшем. Закройте её, чтобы завершить
        удаление.
      </p>
    {/if}
    {#if error}
      <p role="alert" class="notification is-danger is-light">{error}</p>
    {/if}
    <div class="buttons mt-4">
      <button class="button" disabled={busy} onclick={() => dialog.close()}>Отмена</button>
      <button class="button is-danger" disabled={busy} onclick={remove}>
        {busy ? 'Удаление…' : 'Удалить безвозвратно'}
      </button>
    </div>
  {/if}
</dialog>

<style>
  small {
    display: block;
    max-width: 24rem;
    margin-top: 0.5rem;
  }
  td {
    vertical-align: top;
  }
  dialog {
    margin: auto;
    width: min(36rem, calc(100vw - 2rem));
    max-height: calc(100vh - 2rem);
    overflow: auto;
  }
  dialog:not([open]) {
    display: none;
  }
  dialog::backdrop {
    background: rgb(0 0 0 / 0.6);
  }
</style>
