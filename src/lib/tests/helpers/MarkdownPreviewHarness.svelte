<script lang="ts">
  import type { Writable } from 'svelte/store';
  import MarkdownPreview from '../../components/MarkdownPreview.svelte';

  export let version: Writable<1 | null>;
</script>

<MarkdownPreview formatVersion={$version} />
