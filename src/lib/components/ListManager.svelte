<script lang="ts">
  import type { CardSection } from '../utils/markdownSerializer';

  export let section: CardSection;
  export let onItemChange: (items: { text: string; checked: boolean }[]) => void;
  export let onTypeChange: (type: 'unordered' | 'ordered' | 'checklist') => void;

  let radioGroupName = 'listType_' + Math.random().toString(36).substring(2, 9);

  function addItem() {
    const newItems = [...section.items, { text: '', checked: false }];
    onItemChange(newItems);
  }

  function removeItem(index: number) {
    const newItems = section.items.filter((_: any, i: number) => i !== index);
    onItemChange(newItems);
  }

  function updateItemText(index: number, text: string) {
    const newItems = section.items.map((item: { text: string; checked: boolean }, i: number) =>
      i === index ? { ...item, text } : item
    );
    onItemChange(newItems);
  }

  function toggleChecked(index: number) {
    const newItems = section.items.map((item: { text: string; checked: boolean }, i: number) =>
      i === index ? { ...item, checked: !item.checked } : item
    );
    onItemChange(newItems);
  }

  function toggleStrikethrough(index: number) {
    const newItems = section.items.map((item: { text: string; checked: boolean }, i: number) =>
      i === index ? { ...item, checked: !item.checked } : item
    );
    onItemChange(newItems);
  }

  function setListType(type: 'unordered' | 'ordered' | 'checklist') {
    onTypeChange(type);
  }
</script>

<div class="list-manager">
  <div class="radios list-type-selector">
    <label class="radio">
      <input
        type="radio"
        name={radioGroupName}
        checked={section.type === 'unordered'}
        value="unordered"
        on:change={() => setListType('unordered')}
      />
      Unordered
    </label>

    <label class="radio">
      <input
        type="radio"
        name={radioGroupName}
        checked={section.type === 'ordered'}
        value="ordered"
        on:change={() => setListType('ordered')}
      />
      Ordered
    </label>

    <label class="radio">
      <input
        type="radio"
        name={radioGroupName}
        checked={section.type === 'checklist'}
        value="checklist"
        on:change={() => setListType('checklist')}
      />
      Checklist
    </label>
  </div>

  <div class="list-items">
    {#each section.items as item, index (index)}
      <div class="list-item">
        {#if section.type === 'checklist'}
          <input
            type="checkbox"
            checked={item.checked}
            on:change={() => toggleChecked(index)}
          />
        {/if}

        <textarea
          bind:value={item.text}
          on:input={(e) => updateItemText(index, (e.target as HTMLInputElement).value)}
          placeholder="List item"
          class={`textarea item-text-content ${item.checked ? 'strikethrough' : ''}`}
        ></textarea>

        <div class="buttons are-small">
          {#if section.type !== 'checklist'}
            <button class="button" on:click={() => toggleStrikethrough(index)} aria-label="strikethrough" title="strikethrough">
              <span class="fa fa-strikethrough"></span>
            </button>
          {/if}

          <button class="button is-danger" on:click={() => removeItem(index)} aria-label="remove" title="remove">
            <span class="fa fa-trash"></span>
          </button>
        </div>
      </div>
    {/each}
  </div>

  <button class="button" on:click={addItem}>Add Item</button>
</div>

<style>
  .list-manager {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .list-type-selector {
    margin-bottom: 10px;
  }

  .list-items {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  input, textarea {
    color: inherit;
  }

  .list-item {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding-left: 20px;
    position: relative;
    min-height: 1.5rem;
    align-items: flex-start;
  }

  .list-item::before {
    content: '';
    position: absolute;
    left: 0;
    top: 10px;
    width: 10px;
    height: 1px;
    background-color: currentColor;
  }

  .item-text-content {
    field-sizing: content;
    background: none;
    border: none;
    height: auto;
    padding: 0;
    min-height: 0;
    width: auto;
    min-width: 0;
    resize: none;
  }

  .item-text-content:not(:focus) {
    box-shadow: none;
  }

  .list-item:not(:focus-within) .buttons {
    display: none;
  }

  .strikethrough {
    text-decoration: line-through;
    opacity: 0.7;
  }
</style>
