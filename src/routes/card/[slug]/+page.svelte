<script>
  import { onMount } from 'svelte';
  import CardEditor from '../../../lib/components/CardEditor.svelte';
  import { loadCard } from '../../../lib/stores/cardStore';
  import { page } from '$app/stores';

  onMount(async () => {
    const slug = $page.params.slug;
    if (slug && slug !== 'new') {
      await loadCard(slug);
    }
  });
</script>

<CardEditor />

