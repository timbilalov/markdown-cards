<script lang="ts">
  import type { StorageComparison } from '$lib/services/storageManagement';
  import type { NoteInventoryRow, NoteCopy } from '$lib/domain/storageSync';
  import { storageNoteLabel } from '$lib/utils/storageNoteLabel';
  import { storageFolderLabel } from '$lib/utils/storageLocationLabel';
  import { orderStorageColumns } from '$lib/utils/storageColumnOrder';

  let { model }: { model: StorageComparison } = $props();
  const columns = $derived(orderStorageColumns(model.columns));
  const date = (time: number) => new Date(time).toLocaleString();

  function version(row: NoteInventoryRow, copy: NoteCopy) {
    return copy.status === 'present'
      ? row.comparison.versions.findIndex(item => item.source === copy.source)
      : -1;
  }

  function latest(row: NoteInventoryRow, id: string) {
    return (
      row.comparison.freshness.status === 'latest' &&
      row.comparison.freshness.storageIds.includes(id)
    );
  }

  function copies(row: NoteInventoryRow): NoteCopy[] {
    const byStorage = new Map(row.copies.map(copy => [copy.storageId, copy]));
    return columns.map(
      column => byStorage.get(column.id) ?? { storageId: column.id, status: 'unavailable' }
    );
  }
</script>

{#if model.snapshots.some(source => source.status === 'unavailable')}
  <p role="alert" class="notification is-warning">
    Список заметок недоступен полностью: некоторые хранилища не ответили.
  </p>
{/if}
{#if !model.rows.length && model.snapshots.every(source => source.status === 'available')}
  <p>Заметок нет.</p>
{/if}
<div class="table-container" data-storage-table>
  <table class="table is-bordered is-fullwidth">
    <caption>
      Текущие копии исходных файлов. Актуальность — по Modified внутри документа; даты облака
      показаны отдельно.
    </caption>
    <thead>
      <tr>
        <th scope="col">Заметка</th>
        {#each columns as column (column.id)}
          <th scope="col" data-storage-id={column.id}>
            {column.label}
            <small data-storage-folder>
              {column.rootPath === undefined
                ? 'Папка неизвестна'
                : `Папка: ${storageFolderLabel(column.rootPath)}`}
            </small>
            {#if column.active}<span class="tag is-info is-light">Активное</span>
            {/if}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each model.rows as row (row.path)}
        <tr data-note-path={row.path}>
          <th scope="row">
            {storageNoteLabel(row)}{#if row.comparison.freshness.status === 'undetermined'}
              <small>Актуальность неопределённа</small>
            {/if}
          </th>
          {#each copies(row) as copy (copy.storageId)}
            <td
              data-storage-id={copy.storageId}
              data-latest={latest(row, copy.storageId)}
              class:is-latest={latest(row, copy.storageId)}
            >
              {#if copy.status === 'missing'}Нет файла
              {:else if copy.status === 'unavailable'}Недоступно
              {:else}
                {@const index = version(row, copy)}
                {@const modified = row.comparison.versions[index]?.modifiedAt ?? null}
                {#if latest(row, copy.storageId)}
                  <strong>Актуальная · версия {index + 1}</strong>
                {:else}<span>Версия {index + 1}</span>
                {/if}
                {#if modified !== null}<time
                    data-document-modified
                    datetime={new Date(modified).toISOString()}
                  >
                    {date(modified)}
                  </time>
                {:else}
                  <small>Дата документа неизвестна</small>
                {/if}
                {#if copy.revision !== null}
                  <small>Ревизия: {copy.revision}</small>
                {/if}
                {#if copy.storageModifiedAt !== undefined}
                  <small>
                    Дата в листинге облака: <time
                      data-storage-modified
                      datetime={new Date(copy.storageModifiedAt).toISOString()}
                    >
                      {date(copy.storageModifiedAt)}
                    </time>
                  </small>
                {/if}
                <details>
                  <summary>Исходник</summary>
                  <pre>{copy.source}</pre>
                </details>
              {/if}
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  caption {
    text-align: left;
    margin-bottom: 1rem;
    color: inherit;
  }
  th {
    min-width: 12rem;
  }
  td {
    min-width: 16rem;
    vertical-align: top;
  }
  .is-latest {
    background-color: var(--bulma-success-soft);
  }
  small,
  time[data-document-modified] {
    display: block;
    font-weight: normal;
  }
  pre {
    max-width: 34rem;
    max-height: 24rem;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  details {
    margin-top: 0.6rem;
  }
  summary {
    cursor: pointer;
  }
  .tag {
    margin-left: 0.4rem;
  }
</style>
