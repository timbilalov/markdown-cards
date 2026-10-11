<script lang="ts">
  import { cardStore } from '../stores/cardStore';
  import { renderMarkdownPreview } from '../utils/markdownPreview';
  import { serializeMarkdownDocument } from '../domain/markdown';

  export let formatVersion: 1 | null = null;

  $: serialized = $cardStore && formatVersion === 1 ? serializeMarkdownDocument($cardStore) : null;
  $: markdown = serialized?.status === 'success' ? serialized.markdown : '';
  $: htmlContent = renderMarkdownPreview(markdown);
</script>

<div class="content my-4">
  {#if $cardStore && formatVersion !== 1}
    <p role="alert">Формат заметки не определён. Откройте её заново.</p>
  {:else if serialized?.status === 'invalid'}
    <p role="alert">Изменения нельзя представить в текущем формате заметки. Проверьте содержимое в редакторе.</p>
  {:else}
    {@html htmlContent}
  {/if}
</div>
