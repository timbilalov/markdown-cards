<script>
  import CardEditor from '../../../lib/components/CardEditor.svelte';
  export let data;

  const { slug, markdown } = data;
</script>

<CardEditor {slug} {markdown} />
