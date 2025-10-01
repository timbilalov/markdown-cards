<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import { createEventDispatcher } from 'svelte';

  interface RememberMeCheckboxProps {
    checked?: boolean;
  }

  interface RememberMeCheckboxEvents {
    change: CustomEvent<boolean>;
  }

  export let checked = false;

  const dispatch = createEventDispatcher<RememberMeCheckboxEvents>();

  function handleChange() {
    checked = !checked;
    dispatch('change', new CustomEvent<boolean>('change', { detail: checked }));
  }
</script>

<div class="remember-me-container">
  <label class="checkbox-label">
    <input
      type="checkbox"
      bind:checked={checked}
      on:change={handleChange}
      class="checkbox-input"
    />
    <span class="checkbox-text">Remember me</span>
  </label>
</div>

<style>
  .remember-me-container {
    display: flex;
    align-items: center;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-weight: normal;
    font-size: 0.875rem;
    color: #333;
  }

  .checkbox-input {
    width: 1rem;
    height: 1rem;
    accent-color: #667eea;
  }

  .checkbox-text {
    user-select: none;
  }
</style>
