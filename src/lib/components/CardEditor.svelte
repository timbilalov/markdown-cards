<script lang="ts">
  import { cardStore, saveCard, createNewCard } from '../stores/cardStore';
  import ListManager from './ListManager.svelte';
  import MarkdownPreview from './MarkdownPreview.svelte';
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { isAuthenticated } from '../stores/cloudStore';
  import type { Card } from '../utils/markdownSerializer';

  let showPreview = false;
  let slug = $page.params.slug;
  let saving = false;
  let saveError: string | null = null;

  onMount(() => {
    // If we're creating a new card and there's no card in the store, create a new one
    if (slug === 'new' && !$cardStore) {
      const newCard = createNewCard('New Card');
      cardStore.set(newCard);
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
</script>

<div class="editor-container">
  <div class="toolbar">
    <button on:click={save} disabled={saving}>
      {saving ? 'Saving...' : 'Save'}
    </button>
    {#if saveError}
      <div class="save-error">
        Error: {saveError}
      </div>
    {/if}
    <label>
      <input type="checkbox" bind:checked={showPreview}>
      Show Preview
    </label>
  </div>

  {#if $cardStore}
    <div class="card-editor">
      <div class="header">
        <input
          type="text"
          bind:value={$cardStore.title}
          placeholder="Card title"
        />
        <textarea
          bind:value={$cardStore.description}
          placeholder="Card description"
        ></textarea>
        <div class="data-fields">
          <div class="data-field">
            <label for="card-status">Status:</label>
            <input
              id="card-status"
              type="text"
              value={$cardStore.status || ''}
              placeholder="Status"
              on:input={(e) => {
                const target = e.target as HTMLInputElement;
                const status = target.value;
                cardStore.update(store => store ? {...store, status} : store);
              }}
            />
          </div>
          <div class="data-field">
            <label for="card-tags">Tags:</label>
            <input
              id="card-tags"
              type="text"
              value={($cardStore.tags || []).join(' ')}
              placeholder="Tags (space separated)"
              on:input={(e: Event) => {
                const target = e.target as HTMLInputElement;
                const tags = target.value.split(/\s+/).filter((tag: string) => tag.length > 0);
                cardStore.update(store => store ? {...store, tags} : store);
              }}
            />
          </div>
          <div class="data-field">
            <label for="card-image">Image URL:</label>
            <input
              id="card-image"
              type="text"
              value={$cardStore.image || ''}
              placeholder="Image URL"
              on:input={(e) => {
                const target = e.target as HTMLInputElement;
                const image = target.value;
                cardStore.update(store => store ? {...store, image} : store);
              }}
            />
          </div>
        </div>
      </div>

      <div class="sections">
        {#each $cardStore.sections as section, index (index)}
          <div class="section">
            <div class="section-header">
              <input
                type="text"
                bind:value={section.heading}
                placeholder="Section heading"
              />
              <button on:click={() => removeSection(index)}>Remove</button>
            </div>
            <ListManager
              section={section}
              onItemChange={(updatedItems: { text: string; checked: boolean }[]) => updateSectionItems(index, updatedItems)}
              onTypeChange={(newType: 'unordered' | 'ordered' | 'checklist') => updateSectionType(index, newType)}
            />
          </div>
        {/each}
        <button on:click={addSection}>Add Section</button>
      </div>

      <!-- Meta section (read-only) -->
      <div class="meta-section">
        <h3>Meta</h3>
        <div class="meta-fields">
          <div class="meta-field">
            <label for="card-id">ID:</label>
            <input id="card-id" type="text" readonly value={$cardStore.meta.id} />
          </div>
          <div class="meta-field">
            <label for="card-created">Created:</label>
            <input id="card-created" type="text" readonly value={new Date($cardStore.meta.created).toISOString().split('T')[0]} />
          </div>
          <div class="meta-field">
            <label for="card-modified">Modified:</label>
            <input id="card-modified" type="text" readonly value={new Date($cardStore.meta.modified).toISOString().split('T')[0]} />
          </div>
        </div>
      </div>
    </div>
  {/if}

  {#if showPreview}
    <MarkdownPreview />
  {/if}
</div>

<style>
  .editor-container {
    max-width: 800px;
    margin: 0 auto;
    padding: 20px;
  }

  .toolbar {
    display: flex;
    justify-content: space-between;
    margin-bottom: 20px;
  }

  .card-editor {
    background: white;
    border-radius: 8px;
    padding: 20px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
  }

  .header input, .header textarea {
    width: 100%;
    margin-bottom: 15px;
    padding: 10px;
    border: 1px solid #ddd;
    border-radius: 4px;
  }

  .header textarea {
    min-height: 100px;
  }

  .section {
    margin-bottom: 20px;
    padding: 15px;
    border: 1px solid #eee;
    border-radius: 4px;
  }

  .section-header {
    display: flex;
    margin-bottom: 10px;
  }

  .section-header input {
    flex-grow: 1;
    padding: 8px;
    border: 1px solid #ddd;
    border-radius: 4px;
  }

  .section-header button {
    margin-left: 10px;
  }
  .meta-section {
    margin-top: 20px;
    padding: 15px;
    border: 1px solid #eee;
    border-radius: 4px;
    background-color: #f5f5f5;
  }

  .meta-section > h3 {
    display: block;
    margin-bottom: 10px;
    font-weight: bold;
  }

  .meta-fields {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .meta-field {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .meta-field label {
    font-weight: bold;
    min-width: 80px;
  }

  .meta-field input {
    flex: 1;
    padding: 8px;
    border: 1px solid #ddd;
    border-radius: 4px;
    background-color: #f9f9f9;
    cursor: not-allowed;
  }

  .save-error {
    color: #dc3545;
    background-color: #f8d7da;
    border: 1px solid #f5c6cb;
    border-radius: 4px;
    padding: 0.5rem;
    margin-top: 0.5rem;
  }

  .data-fields {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-bottom: 15px;
  }

  .data-field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .data-field label {
    font-weight: bold;
  }

  .data-field input {
    padding: 8px;
    border: 1px solid #ddd;
    border-radius: 4px;
  }
</style>
