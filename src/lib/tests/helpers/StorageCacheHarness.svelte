<script lang="ts">
  import { untrack } from 'svelte';
  import StorageCachePanel from '../../components/StorageCachePanel.svelte';
  import type { StorageComparison } from '../../services/storageManagement';

  let { model, oncomplete }: { model: StorageComparison; oncomplete: () => Promise<void> } =
    $props();
  let current = $state.raw(untrack(() => model));
</script>

<button onclick={() => (current = { ...current })}>Refresh comparison</button>
<StorageCachePanel model={current} {oncomplete} />
