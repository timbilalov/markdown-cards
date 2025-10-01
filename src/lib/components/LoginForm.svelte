<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import { createEventDispatcher } from 'svelte';

  interface LoginFormProps {
    loading?: boolean;
    error?: string | null;
  }

  interface LoginFormEvents {
    submit: LoginFormSubmitEvent;
  }

  interface LoginFormSubmitEvent {
    username: string;
    password: string;
    rememberMe: boolean;
  }

  export let loading = false;
  export let error: string | null = null;

  let username = '';
  let password = '';
  let rememberMe = false;

  const dispatch = createEventDispatcher<LoginFormEvents>();

  function handleSubmit() {
    dispatch('submit', {
      username,
      password,
      rememberMe
    });
  }
</script>

<div class="login-form-container">
  {#if error}
    <div class="error-message">
      {error}
    </div>
  {/if}

  <form on:submit|preventDefault={handleSubmit} class="login-form">
    <div class="form-group">
      <label for="username">Username</label>
      <input
        id="username"
        type="text"
        bind:value={username}
        placeholder="Enter your username"
        required
        autocomplete="username"
        class="form-input"
      />
    </div>

    <div class="form-group">
      <label for="password">Password</label>
      <input
        id="password"
        type="password"
        bind:value={password}
        placeholder="Enter your password"
        required
        autocomplete="current-password"
        class="form-input"
      />
    </div>

    <div class="form-group checkbox-group">
      <label class="checkbox-label">
        <input
          type="checkbox"
          bind:checked={rememberMe}
          class="checkbox-input"
        />
        <span class="checkbox-text">Remember me</span>
      </label>
    </div>

    <button
      type="submit"
      disabled={loading}
      class="login-button"
    >
      {#if loading}
        <span class="loading-spinner"></span>
        Signing in...
      {:else}
        Sign In
      {/if}
    </button>
  </form>
</div>

<style>
  .login-form-container {
    width: 100%;
  }

  .error-message {
    background-color: #fee;
    color: #c33;
    padding: 0.75rem;
    border-radius: 6px;
    margin-bottom: 1.5rem;
    border: 1px solid #fcc;
    font-size: 0.875rem;
  }

  .login-form {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .form-group.checkbox-group {
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
  }

  label {
    font-weight: 500;
    color: #333;
    font-size: 0.875rem;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-weight: normal;
  }

  .form-input {
    padding: 0.75rem 1rem;
    border: 1px solid #ddd;
    border-radius: 6px;
    font-size: 1rem;
    transition: border-color 0.2s;
  }

  .form-input:focus {
    outline: none;
    border-color: #667eea;
    box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
  }

  .checkbox-input {
    width: 1rem;
    height: 1rem;
    accent-color: #667eea;
  }

  .login-button {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    border-radius: 6px;
    padding: 0.875rem;
    font-size: 1rem;
    font-weight: 500;
    cursor: pointer;
    transition: transform 0.2s, box-shadow 0.2s;
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 0.5rem;
  }

  .login-button:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
  }

  .login-button:disabled {
    opacity: 0.7;
    cursor: not-allowed;
  }

  .loading-spinner {
    width: 1rem;
    height: 1rem;
    border: 2px solid transparent;
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
