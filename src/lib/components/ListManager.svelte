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

  function setListType(type: 'unordered' | 'ordered' | 'checklist') {
    onTypeChange(type);
  }
</script>

<div class="list-manager">
  <div class="list-type-selector">
    <label>
      <input
        type="radio"
        name={radioGroupName}
        checked={section.type === 'unordered'}
        value="unordered"
        on:change={() => setListType('unordered')}
      />
      Unordered
    </label>
    <label>
      <input
        type="radio"
        name={radioGroupName}
        checked={section.type === 'ordered'}
        value="ordered"
        on:change={() => setListType('ordered')}
      />
      Ordered
    </label>
    <label>
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
        <input
          type="checkbox"
          checked={item.checked}
          on:change={() => toggleChecked(index)}
        />

        <textarea
          bind:value={item.text}
          on:input={(e) => updateItemText(index, (e.target as HTMLInputElement).value)}
          placeholder="List item"
          class={item.checked ? 'strikethrough' : ''}
        ></textarea>

        <button on:click={() => removeItem(index)}>Remove</button>
      </div>
    {/each}
  </div>

  <button on:click={addItem}>Add Item</button>
</div>

<style>
  .list-manager {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .list-type-selector {
    display: flex;
    gap: 15px;
    margin-bottom: 10px;
  }

  .list-items {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .list-item {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  textarea {
    field-sizing: content;
    background: none;
    border: none;
  }

  .strikethrough {
    text-decoration: line-through;
    opacity: 0.7;
  }
</style>
