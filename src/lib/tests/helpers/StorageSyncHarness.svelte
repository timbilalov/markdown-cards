<script lang="ts">
  import { untrack } from 'svelte';
  import StorageSyncPanel from '../../components/StorageSyncPanel.svelte';
  import type { StorageComparison } from '../../services/storageManagement';

  let {
    initial,
    replacement,
    oncomplete
  }: {
    initial: StorageComparison;
    replacement: StorageComparison;
    oncomplete: () => Promise<void>;
  } = $props();
  let model = $state.raw(untrack(() => initial));
</script>

<button onclick={() => (model = replacement)}>Replace comparison</button>
<StorageSyncPanel {model} {oncomplete} />
