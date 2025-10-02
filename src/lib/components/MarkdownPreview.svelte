<script lang="ts">
  import { cardStore } from '../stores/cardStore';
  import { marked } from 'marked';
  import { serializeCard, type Card } from '../utils/markdownSerializer';

  // Configure marked to handle newlines better
  marked.setOptions({
    breaks: true, // Convert single newlines to <br>
    gfm: true // Use GitHub Flavored Markdown
  });

  $: markdown = $cardStore ? serializeCard($cardStore) : '';
  $: htmlContent = marked(markdown);
</script>

<div class="content my-4">
  {@html htmlContent}
</div>
