<script lang="ts">
  import { cardStore, saveCard, createNewCard, cardSaving, cardSaveError, isOffline, processOfflineQueue } from '../stores/cardStore';
  import ListManager from './ListManager.svelte';
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { isAuthenticated } from '../stores/cloudStore';
  import type { Card } from '../utils/markdownSerializer';

  let slug = $page.params.slug;
  let saving = false;
  let saveError: string | null = null;
  let offlineMode = false;

  // Subscribe to store values
  cardSaving.subscribe(value => {
    saving = value;
  });

  cardSaveError.subscribe(value => {
    saveError = value;
  });

  isOffline.subscribe(value => {
    offlineMode = value;
  });

  onMount(() => {
    // If we're creating a new card and there's no card in the store, create a new one
    if (slug === 'new' && !$cardStore) {
      const newCard = createNewCard('New Card');
      cardStore.set(newCard);
    }

    // Process any pending offline operations when online
    if (!offlineMode && isAuthenticated) {
      processOfflineQueue();
    }
  });

  function addSection() {
    cardStore.update(store => {
      if (!store) return store;
      return {
        ...store,
        sections: [
          ...store.sections,
          {
            heading: 'New Section',
            type: 'unordered',
            items: []
          }
        ]
      };
    });
  }

  function removeSection(index: number) {
    cardStore.update(store => {
      if (!store) return store;
      const sections = [...store.sections];
      sections.splice(index, 1);
      return { ...store, sections };
    });
  }

  function updateSectionItems(index: number, items: { text: string; checked: boolean }[]) {
    cardStore.update(store => {
      if (!store) return store;
      const sections = [...store.sections];
      sections[index] = { ...sections[index], items };
      return { ...store, sections };
    });
  }

  function updateSectionType(index: number, type: 'unordered' | 'ordered' | 'checklist') {
    cardStore.update(store => {
      if (!store) return store;
      const sections = [...store.sections];
      sections[index] = { ...sections[index], type };
      return { ...store, sections };
    });
  }

  async function save() {
    saving = true;
    saveError = null;

    try {
      // For new cards, use the card ID as the filename, otherwise use the slug
      const filename = slug === 'new' && $cardStore ? $cardStore.meta.id : slug;
      if (filename && $cardStore) {
        await saveCard(filename, $cardStore);
      }
    } catch (error) {
      saveError = error instanceof Error ? error.message : 'Failed to save card';
      console.error('Error saving card:', error);
    } finally {
      saving = false;
    }
  }

  function renderSectionContent(section: any) {
    let markdown = '';
    section.items.forEach((item: any) => {
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

<div class="combined-card-view">
  <div class="toolbar">
    <button class="button" on:click={save} disabled={saving}>
      {saving ? 'Saving...' : 'Save'}
    </button>
    {#if saveError}
      <div class="save-error">
        Error: {saveError}
      </div>
    {/if}
  </div>

  {#if $cardStore}
    <div class="combined-card-view">
      <div class="combined-card-header">
        <input
          type="text"
          bind:value={$cardStore.title}
          placeholder="Card title"
          class="card-title-input input"
        />
        <div class="card-meta">
          <span class="card-id">ID: {$cardStore.meta.id}</span>
          <input
            type="text"
            bind:value={$cardStore.status}
            placeholder="Status"
            class="input"
          />
        </div>
      </div>

      <div class="card-inner">
        <div class="field">
          <label class="label" for="image">Image</label>
          <div class="control">
            <input
              type="text"
              id="image"
              bind:value={$cardStore.image}
              placeholder="Image URL"
              class="input"
            />
          </div>

          {#if $cardStore.image}
            <div class="card-image-preview">
              <img src={$cardStore.image} alt="Card image" class="card-image" />
            </div>
          {/if}
        </div>

        <div class="card-description">
          <textarea
            bind:value={$cardStore.description}
            placeholder="Card description"
            class="description-input textarea"
          ></textarea>
        </div>

        {#if $cardStore.sections && $cardStore.sections.length > 0}
          <div class="card-sections">
            {#each $cardStore.sections as section, index (index)}
              <div class="box">
                <div class="section-header">
                  <input
                    type="text"
                    bind:value={section.heading}
                    placeholder="Section heading"
                    class="section-heading-input input"
                  />
                  <button on:click={() => removeSection(index)} class="button is-danger">Remove</button>
                </div>
                <div class="section-content">
                  <ListManager
                    section={section}
                    onItemChange={(updatedItems: { text: string; checked: boolean }[]) => updateSectionItems(index, updatedItems)}
                    onTypeChange={(newType: 'unordered' | 'ordered' | 'checklist') => updateSectionType(index, newType)}
                  />
                </div>
              </div>
            {/each}
          </div>
        {/if}

        <button on:click={addSection} class="button">Add Section</button>

        <div class="box">
          <div class="meta-item">
            <span class="meta-label">Created:</span>
            <span class="meta-value">{new Date($cardStore.meta.created).toLocaleString()}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">Modified:</span>
            <span class="meta-value">{new Date($cardStore.meta.modified).toLocaleString()}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">Tags:</span>
            <input
              type="text"
              value={($cardStore.tags || []).join(' ')}
              placeholder="Tags (space separated)"
              class="input"
              on:input={(e: Event) => {
                const target = e.target as HTMLInputElement;
                const tags = target.value.split(/\s+/).filter((tag: string) => tag.length > 0);
                cardStore.update(store => store ? {...store, tags} : store);
              }}
            />
          </div>
        </div>
      </div>
    </div>
  {:else}
    <div class="no-card">
      <p>No card data available</p>
    </div>
  {/if}
</div>

<style>
  .toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
    flex-wrap: wrap;
    gap: 1rem;
  }

  .combined-card-header {
    border-bottom: 1px solid #e0e0e0;
    padding-bottom: 1rem;
    margin-bottom: 1.5rem;
  }

  .card-title-input {
    padding: 0;
    border: none;
    font-size: 1.8rem;
    font-weight: 600;
    margin: 0 0 0.5rem 0;
    height: auto;
  }

  .card-title-input:not(:focus) {
    box-shadow: none;
  }

  input, textarea {
    color: inherit;
  }

  .card-meta {
    display: flex;
    gap: 1rem;
    font-size: 0.9rem;
    color: #666;
    align-items: center;
  }

  .card-inner {
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

  .description-input {
    width: 100%;
    padding: 0;
    font-family: inherit;
    font-size: 1rem;
    resize: none;
    min-height: 0;
    height: auto;

    field-sizing: content;
    border: none;
    background: none;
  }

  .description-input:not(:focus) {
    box-shadow: none;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .section-heading-input {
    font-size: 1.1rem;
    font-weight: 600;
    border: none;
    width: 70%;
    padding: 0;
    height: auto;
  }

  .meta-item {
    display: flex;
    margin-bottom: 0.5rem;
    align-items: center;
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

  .no-card {
    text-align: center;
    padding: 2rem;
    color: #666;
  }

  .save-error {
    color: #dc3545;
    background-color: #f8d7da;
    border: 1px solid #f5c6cb;
    border-radius: 4px;
    padding: 0.5rem;
    margin-top: 0.5rem;
  }

  .offline-warning {
    color: #856404;
    background-color: #fff3cd;
    border: 1px solid #ffeaa7;
    border-radius: 4px;
    padding: 0.5rem;
    margin-top: 0.5rem;
  }

  .card-image-preview {
    margin: 1rem 0;
  }

  .card-image {
    display: block;
    max-width: 400px;
    width: 100%;
    height: auto;
    border-radius: 4px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
  }
</style>
