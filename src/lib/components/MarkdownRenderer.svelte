<script lang="ts">
  import { marked } from 'marked';

  export let markdown: string = '';

  $: htmlContent = marked(markdown);
</script>

<div class="markdown-renderer">
  {@html htmlContent}
</div>

<style>
  .markdown-renderer {
    padding: 0;
    border: none;
    background: transparent;
  }

  .markdown-renderer :global(h1) {
    font-size: 2rem;
    font-weight: bold;
    margin: 1rem 0;
  }

  .markdown-renderer :global(h2) {
    font-size: 1.5rem;
    font-weight: bold;
    margin: 0.8rem 0;
  }

  .markdown-renderer :global(h3) {
    font-size: 1.2rem;
    font-weight: bold;
    margin: 0.6rem 0;
  }

  .markdown-renderer :global(p) {
    margin: 0.5rem 0;
    line-height: 1.5;
  }

  .markdown-renderer :global(ul), .markdown-renderer :global(ol) {
    margin: 0.5rem 0;
    padding-left: 1.5rem;
  }

  .markdown-renderer :global(li) {
    margin: 0.2rem 0;
  }

  .markdown-renderer :global(strong) {
    font-weight: bold;
  }

  .markdown-renderer :global(em) {
    font-style: italic;
  }

  .markdown-renderer :global(del) {
    text-decoration: line-through;
  }
</style>
