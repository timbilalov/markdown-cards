<script lang="ts">
  import { page } from '$app/stores';
  import { app } from '../stores/appFacade';
  import { cardStore, cardDocument, cardSaving, cardSaveError, cardDeliveryStatus } from '../stores/cardStore';
  async function save() {
    const filename = $cardDocument?.filename ?? $page.params.slug;
    if (filename && $cardStore) await app.saveCard(filename, $cardStore);
  }
</script>

<div class="toolbar">
  <button class="button" on:click={save} disabled={$cardSaving}>
    {$cardSaving ? 'Saving...' : 'Save'}
  </button>
  {#if $cardDeliveryStatus === 'unauthorized' || $cardDeliveryStatus === 'remote-unavailable'}
    <button class="button" on:click={() => app.retry()} disabled={$cardSaving}>Повторить синхронизацию</button>
  {/if}
  {#if $cardSaveError}
    <div class="save-error" role="alert">Error: {$cardSaveError}</div>
  {/if}
</div>

<style>
  .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 1rem; }
  .save-error { color: #dc3545; background-color: #f8d7da; border: 1px solid #f5c6cb; border-radius: 4px; padding: 0.5rem; margin-top: 0.5rem; }
</style>
