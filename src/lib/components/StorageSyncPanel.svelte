<script lang="ts">
  import { onMount } from 'svelte';
  import { app } from '$lib/stores/appFacade';
  import type { StorageComparison } from '$lib/services/storageManagement';
  import type { PreparedStorageSync } from '$lib/services/manualStorageSync';
  import type { NoteSyncResult, NoteSyncOutcome } from '$lib/application/executeNoteSync';
  import type { ManualSyncState } from '$lib/services/manualStorageSync';
  import type { ManualSyncOperation } from '$lib/ports/manualSyncJournal';
  import { storageNoteLabel } from '$lib/utils/storageNoteLabel';
  import { storageLocationLabel } from '$lib/utils/storageLocationLabel';
  import { orderStorageColumns } from '$lib/utils/storageColumnOrder';

  let { model, oncomplete }: { model: StorageComparison; oncomplete: () => Promise<void> } =
    $props();
  let source = $state('');
  let path = $state('');
  let targets = $state<string[]>([]);
  let queue = $state<PreparedStorageSync | null>(null);
  let queueModel = $state.raw<StorageComparison | null>(null);
  let queueMessage = $state<string | null>(null);
  let results = $state<NoteSyncResult[]>([]);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let recovery = $state<ManualSyncState | null>(null);
  let recoveryMessages = $state<Record<string, string>>({});
  let alive = true;
  let recoveryRequest = 0;
  const choices = $derived(
    orderStorageColumns(model.columns).filter(column => model.storages.has(column.id))
  );
  const targetChoices = $derived(choices.filter(column => column.id !== source));
  const referenceChoices = $derived(
    choices.filter(column =>
      model.rows.some(
        row =>
          (!path || row.path === path) &&
          row.copies.some(copy => copy.storageId === column.id && copy.status === 'present')
      )
    )
  );
  $effect(() => {
    if (source && !referenceChoices.some(column => column.id === source)) {
      source = '';
    }
  });
  $effect(() => {
    if (queueModel && queueModel !== model) {
      queue = null;
      queueModel = null;
      queueMessage = 'Версии обновлены. Очередь очищена; подготовьте синхронизацию заново.';
    }
  });

  const label = (id: string) => {
    const column = model.columns.find(column => column.id === id);
    return column ? storageLocationLabel(column) : id;
  };
  const reasons: Record<string, string> = {
    'same-storage': 'То же хранилище',
    identical: 'Копии совпадают',
    'source-missing': 'Нет в эталоне — пропуск',
    'source-changed': 'Эталон изменился — обновите версии',
    'target-changed': 'Назначение изменилось — обновите версии',
    'no-longer-identical': 'Копии больше не совпадают — обновите версии',
    'case-collision': 'Коллизия регистра имени — запись заблокирована',
    uncertain: 'Предыдущая запись не подтверждена',
    busy: 'Синхронизация занята другой вкладкой',
    'ownership-unavailable': 'Для синхронизации нужен браузер с Web Locks',
    'local-error': 'Ошибка локального хранилища',
    'invalid-path': 'Недопустимое имя файла',
    'source-unavailable': 'Эталон недоступен',
    'target-unavailable': 'Назначение недоступно',
    'context-changed': 'Подключение изменилось — подготовьте план заново',
    'unknown-source': 'Эталон не найден',
    'unknown-target': 'Назначение не найдено'
  };

  function outcome(result: NoteSyncOutcome): string {
    if (result.status === 'written') return 'Записано';
    if (result.status === 'skipped' || result.status === 'blocked')
      return reasons[result.reason] ?? 'Запись заблокирована';
    if (result.status === 'conflict') return 'Конфликт — запись остановлена';
    if (result.status === 'unsupported') return 'Безопасная запись не поддерживается';
    if (result.status === 'invalid') return 'Некорректные данные — запись остановлена';
    return result.outcome === 'unknown'
      ? 'Результат неизвестен — проверьте запись'
      : result.reason === 'auth'
        ? 'Требуется вход'
        : 'Хранилище недоступно, запись не выполнена';
  }

  function selectionChanged() {
    error = null;
    queueMessage = null;
  }

  function selectTargets(all: boolean) {
    targets = all ? targetChoices.map(column => column.id) : [];
    selectionChanged();
  }

  function prepare() {
    if (busy) return;
    error = null;
    queueMessage = null;
    const prepared = app.prepareStorageSync(model, {
      paths: path ? [path] : model.rows.map(row => row.path),
      sourceStorageId: source,
      targetStorageIds: targetChoices
        .filter(column => targets.includes(column.id))
        .map(column => column.id)
    });
    const current = queueModel === model ? queue : null;
    const key = (action: PreparedStorageSync['actions'][number]) =>
      JSON.stringify([action.path, action.targetStorageId]);
    const existing = new Map(current?.actions.map(action => [key(action), action]));
    const conflict = prepared.actions.find(action => {
      const queued = existing.get(key(action));
      return queued && queued.sourceStorageId !== action.sourceStorageId;
    });
    if (conflict) {
      error = `В очереди уже есть ${conflict.path} → ${label(conflict.targetStorageId)} с другим эталоном. Удалите прежнюю операцию перед добавлением.`;
      return;
    }
    const added = prepared.actions.filter(action => !existing.has(key(action)));
    queue = {
      actions: [...(current?.actions ?? []), ...added],
      storageContexts: { ...current?.storageContexts, ...prepared.storageContexts }
    };
    queueModel = model;
    queueMessage = added.length
      ? `Добавлено операций: ${added.length}.`
      : 'Эти операции уже есть в очереди.';
    results = [];
  }

  function removeQueued(index: number) {
    if (busy || !queue || queueModel !== model) return;
    const actions = queue.actions.filter((_, position) => position !== index);
    queue = actions.length ? { ...queue, actions } : null;
    if (!queue) queueModel = null;
    selectionChanged();
  }

  function clearQueue() {
    if (busy) return;
    queue = null;
    queueModel = null;
    selectionChanged();
  }

  async function refreshRecovery() {
    const request = ++recoveryRequest;
    try {
      const result = await app.readManualSyncState();
      if (alive && request === recoveryRequest) recovery = result;
    } catch (reason) {
      if (alive && request === recoveryRequest) throw reason;
    }
  }

  async function execute() {
    if (!queue || queueModel !== model || busy || !queue.actions.some(action => action.status === 'copy'))
      return;
    const submitted = $state.snapshot(queue);
    clearQueue();
    busy = true;
    error = null;
    results = [];
    try {
      results = await app.runStorageSync(model, submitted);
      if (alive) {
        await refreshRecovery();
        await oncomplete();
      }
    } catch {
      error =
        'Не удалось завершить проверку результата. Обновите версии и проверьте журнал перед повтором.';
    } finally {
      busy = false;
    }
  }

  async function recover(operation: ManualSyncOperation, dismiss = false) {
    if (busy) return;
    const captured = $state.snapshot(operation);
    busy = true;
    error = null;
    try {
      const result = dismiss
        ? (await app.dismissManualSync(model, captured))
          ? 'confirmed'
          : 'unavailable'
        : await app.verifyManualSync(model, captured);
      recoveryMessages = {
        ...recoveryMessages,
        [operation.id]:
          result === 'confirmed'
            ? dismiss
              ? 'Намерение отменено; исходник сохранён в истории.'
              : 'Запись подтверждена.'
            : result === 'different'
              ? 'Исходник отличается. Автоматический повтор заблокирован.'
              : 'Не удалось проверить или сохранить результат. Блокировка остаётся.'
      };
      if (result === 'confirmed') {
        await refreshRecovery();
        await oncomplete();
      }
    } catch {
      error = 'Журнал недоступен. Блокировка записи остаётся.';
    } finally {
      busy = false;
    }
  }

  function downloadArchive() {
    if (!recovery) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(recovery, null, 2)], { type: 'application/json' })
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'markdown-cards-sync-archive.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  onMount(() => {
    alive = true;
    targets = choices.map(column => column.id);
    return () => {
      alive = false;
    };
  });

  $effect(() => {
    if (model)
      void refreshRecovery().catch(() => {
        error = 'Не удалось прочитать журнал и архив локальной работы.';
      });
  });
</script>

<section class="box" aria-label="Ручная синхронизация">
  <h2 class="title is-4">Ручная синхронизация</h2>
  <p class="mb-3">
    Выберите заметку, точный эталон и назначения, затем подготовьте синхронизацию. Повторите
    для других заметок и выполните всю очередь. Можно выбрать более старую версию. Исходный
    текст и Modified сохранятся; удалений нет.
  </p>
  <fieldset disabled={busy}>
    <div class="field">
      <label for="sync-notes">Заметки</label>
      <div class="select">
        <select id="sync-notes" aria-label="Заметки" bind:value={path} onchange={selectionChanged}>
          <option value="">Все заметки</option>
          {#each model.rows as row (row.path)}
            <option value={row.path}>{storageNoteLabel(row)}</option>
          {/each}
        </select>
      </div>
    </div>
    <div class="field">
      <label for="sync-reference">Эталон</label>
      <div class="select">
        <select id="sync-reference" aria-label="Эталон" bind:value={source} onchange={selectionChanged}>
          <option value="">Выберите источник</option>
          {#each referenceChoices as column (column.id)}
            <option value={column.id}>{storageLocationLabel(column)}</option>
          {/each}
        </select>
      </div>
    </div>
    <fieldset class="field">
      <legend>Назначения</legend>
      <div class="buttons mb-2">
        <button type="button" class="button is-small" onclick={() => selectTargets(true)}>
          Выбрать всё
        </button>
        <button type="button" class="button is-small" onclick={() => selectTargets(false)}>
          Сбросить все
        </button>
      </div>
      {#each targetChoices as column (column.id)}
        <label class="checkbox mr-4">
          <input type="checkbox" value={column.id} bind:group={targets} onchange={selectionChanged} />
          {storageLocationLabel(column)}
        </label>
      {/each}
    </fieldset>
    <button
      class="button is-info"
      disabled={!source ||
        !targetChoices.some(column => targets.includes(column.id)) ||
        !model.rows.length}
      onclick={prepare}
    >
      Подготовить синхронизацию
    </button>
  </fieldset>
  {#if queueMessage}
    <p class="mt-3" role="status">{queueMessage}</p>
  {/if}
  {#if queue?.actions.length && queueModel === model}
    <div class="notification mt-4" data-sync-preview>
      <h3 class="title is-5">Очередь синхронизации ({queue.actions.length})</h3>
      <p>
        Существующие версии в назначениях будут заменены выбранными эталонами. Проверьте
        направления копирования. К копированию: {queue.actions.filter(action => action.status === 'copy').length}.
      </p>
      <p>Очередь очищается при обновлении версий или перезагрузке страницы.</p>
      <ul>
        {#each queue.actions as action, index (JSON.stringify([action.path, action.targetStorageId]))}
          <li class="sync-queue-row">
            <span>
              {action.path}: {label(action.sourceStorageId)} → {label(action.targetStorageId)} — {action.status ===
              'copy'
                ? 'Копировать'
                : (reasons[action.reason] ?? 'Заблокировано')}
            </span>
            <button
              class="button is-small"
              disabled={busy}
              aria-label={`Удалить из очереди: ${action.path}, ${label(action.sourceStorageId)} → ${label(action.targetStorageId)}`}
              onclick={() => removeQueued(index)}
            >Удалить</button>
          </li>
        {/each}
      </ul>
      <div class="buttons mt-3">
        <button
          class="button is-warning"
          disabled={busy || !queue.actions.some(action => action.status === 'copy')}
          onclick={execute}
        >
          Выполнить синхронизацию
        </button>
        <button class="button" disabled={busy} onclick={clearQueue}>Очистить очередь</button>
      </div>
    </div>
  {/if}
  {#if busy}
    <p role="status">Синхронизация и проверка результата…</p>
  {/if}
  {#if error}
    <p role="alert" class="notification is-danger mt-3">{error}</p>
  {/if}
  {#if results.length}
    <div class="mt-4" role="status">
      <h3 class="title is-5">Результаты</h3>
      <ul>
        {#each results as result (`${result.path}:${result.targetStorageId}`)}<li>
            {result.path}: {label(result.sourceStorageId)} → {label(result.targetStorageId)} —
            <strong>{outcome(result.outcome)}</strong>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  {#if recovery?.pending.length}
    <div class="notification is-warning mt-4">
      <h3 class="title is-5">Неподтверждённые записи</h3>
      <p>
        Проверка читает назначение и сравнивает точный текст. Снятие блокировки отменяет намерение;
        его исходник остаётся в истории. Это действие не повторяет запись.
      </p>
      {#each recovery.pending as operation (operation.id)}
        <div class="mt-3">
          <strong>{operation.path} → {label(operation.targetStorageId)}</strong>
          <details>
            <summary>Исходник намерения</summary>
            <pre>{operation.source}</pre>
          </details>
          <button class="button is-small mr-2" disabled={busy} onclick={() => recover(operation)}>
            Проверить запись
          </button>
          <button class="button is-small" disabled={busy} onclick={() => recover(operation, true)}>
            Снять блокировку
          </button>
          {#if recoveryMessages[operation.id]}
            <p role="status">
              {recoveryMessages[operation.id]}
            </p>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
  {#if recovery && (recovery.archives.length || recovery.history.length)}
    <details class="mt-4">
      <summary>
        Архив локальной работы и история намерений ({recovery.archives.length +
          recovery.history.length})
      </summary>
      <p>Точные исходники сохранены локально. Архив можно скачать перед очисткой данных сайта.</p>
      <button class="button is-small" onclick={downloadArchive}>Скачать архив JSON</button>
      {#each recovery.archives as archive (`${archive.storageLabel}:${archive.id}`)}
        <details>
          <summary>{archive.storageLabel} · {archive.path}</summary>
          {#if archive.draft}<pre>{archive.draft.source}</pre>
          {/if}{#if archive.remote}<pre>{archive.remote.source}</pre>
          {/if}{#each archive.operations as operation}<pre>{operation.source}</pre>
          {/each}
        </details>
      {/each}
      {#each recovery.history as operation (operation.id)}
        <details>
          <summary>
            {operation.path} → {label(operation.targetStorageId)} · намерение отменено
          </summary>
          <pre>{operation.source}</pre>
        </details>
      {/each}
    </details>
  {/if}
</section>

<style>
  fieldset {
    min-inline-size: 0;
  }
  label:not(.checkbox) {
    display: block;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 24rem;
    overflow: auto;
  }
  li {
    margin-top: 0.4rem;
  }
  .sync-queue-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .sync-queue-row span {
    flex: 1 1 20rem;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  details {
    margin: 0.5rem 0;
  }
  .select {
    max-width: 100%;
  }
  select {
    max-width: 100%;
  }
</style>
