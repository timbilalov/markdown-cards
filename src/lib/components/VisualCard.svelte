<script lang="ts">
  import { cardStore } from '$lib/stores/cardStore';
  import MarkdownRenderer from '$lib/components/MarkdownRenderer.svelte';
  import type { Card, CardSection } from '$lib/utils/markdownSerializer';

  let currentCard: Card | null = null;

  cardStore.subscribe((value) => {
    currentCard = value;
  });

  function renderSectionContent(section: CardSection) {
    let markdown = '';
    section.items.forEach(item => {
      let prefix = '';
      let text = item.text;

      // Add strikethrough for checked items in all list types
      if (item.checked) {
        text = `~~${text}~~`;
      }

      if (section.type === 'unordered') prefix = '- ';
      if (section.type === 'ordered') prefix = '1. ';
      if (section.type === 'checklist') prefix = item.checked ? '- [x] ' : '- [ ] ';

      markdown += `${prefix}${text}\n`;
    });
    return markdown;
  }
</script>

<div class="visual-card">
  {#if currentCard}
    <div class="card-header">
      <h1 class="card-title">{currentCard.title}</h1>
      <div class="card-meta">
        <span class="card-id">ID: {currentCard.meta.id}</span>
        {#if currentCard.status}
          <span class="card-status">Status: {currentCard.status}</span>
        {/if}
      </div>
    </div>

    <div class="card-content">
      <div class="card-description">
        <h2>Description</h2>
        <MarkdownRenderer markdown={currentCard.description} />
      </div>

      {#if currentCard.sections && currentCard.sections.length > 0}
        <div class="card-sections">
          {#each currentCard.sections as section}
            <div class="card-section">
              <h3>{section.heading}</h3>
              <MarkdownRenderer markdown={renderSectionContent(section)} />
            </div>
          {/each}
        </div>
      {/if}

      <div class="card-metadata">
        <div class="meta-item">
          <span class="meta-label">Created:</span>
          <span class="meta-value">{new Date(currentCard.meta.created).toLocaleString()}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Modified:</span>
          <span class="meta-value">{new Date(currentCard.meta.modified).toLocaleString()}</span>
        </div>
        {#if currentCard.tags && currentCard.tags.length > 0}
          <div class="meta-item">
            <span class="meta-label">Tags:</span>
            <span class="meta-value">
              {#each currentCard.tags as tag}
                <span class="tag">{tag}</span>
              {/each}
            </span>
          </div>
        {/if}
      </div>
    </div>
  {:else}
    <div class="no-card">
      <p>No card data available</p>
    </div>
  {/if}
</div>

<style>
  .visual-card {
    background: white;
    border-radius: 8px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
    padding: 1.5rem;
    margin: 1rem 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
  }

  .card-header {
    border-bottom: 1px solid #e0e0e0;
    padding-bottom: 1rem;
    margin-bottom: 1.5rem;
  }

  .card-title {
    font-size: 1.8rem;
    font-weight: 600;
    margin: 0 0 0.5rem 0;
    color: #333;
  }

  .card-meta {
    display: flex;
    gap: 1rem;
    font-size: 0.9rem;
    color: #666;
  }

  .card-content {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .card-description h2,
  .card-sections h2,
  .card-section h3 {
    font-size: 1.3rem;
    font-weight: 600;
    margin: 0 0 0.75rem 0;
    color: #444;
    border-bottom: 1px solid #eee;
    padding-bottom: 0.25rem;
  }

  .card-section {
    background: #f9f9f9;
    border-radius: 6px;
    padding: 1rem;
  }

  .card-section h3 {
    font-size: 1.1rem;
    border-bottom: none;
    margin-bottom: 0.5rem;
  }

  .card-metadata {
    background: #f5f5f5;
    border-radius: 6px;
    padding: 1rem;
    margin-top: 1rem;
  }

  .meta-item {
    display: flex;
    margin-bottom: 0.5rem;
  }

  .meta-item:last-child {
    margin-bottom: 0;
  }

  .meta-label {
    font-weight: 600;
    width: 100px;
    color: #555;
  }

  .meta-value {
    flex: 1;
    color: #666;
  }

  .tag {
    display: inline-block;
    background: #007bff;
    color: white;
    padding: 0.2rem 0.5rem;
    border-radius: 12px;
    font-size: 0.8rem;
    margin-right: 0.3rem;
  }

  .no-card {
    text-align: center;
    padding: 2rem;
    color: #666;
  }
</style>
