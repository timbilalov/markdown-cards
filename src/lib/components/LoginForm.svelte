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
    <div class="notification is-danger is-light">
      {error}
    </div>
  {/if}

  <form on:submit|preventDefault={handleSubmit} class="box">
    <div class="field">
      <label class="label" for="username">Username</label>
      <div class="control has-icons-left has-icons-right">
        <input
          id="username"
          type="text"
          bind:value={username}
          placeholder="Enter your username"
          required
          autocomplete="username"
          class="input"
        />
        <span class="icon is-small is-left">
          <i class="fas fa-user"></i>
        </span>
      </div>
    </div>

    <div class="field">
      <label class="label" for="password">Password</label>
      <div class="control has-icons-left has-icons-right">
        <input
          id="password"
          type="password"
          bind:value={password}
          placeholder="Enter your password"
          required
          autocomplete="current-password"
          class="input"
        />
        <span class="icon is-small is-left">
          <i class="fas fa-lock"></i>
        </span>
      </div>
    </div>

    <div class="field">
      <div class="control">
        <label class="checkbox">
          <input
            type="checkbox"
            bind:checked={rememberMe}
          />
          Remember me
        </label>
      </div>
    </div>

    <button
      type="submit"
      disabled={loading}
      class={`button ${loading ? 'is-loading' : ''}`}
    >
      Sign In
    </button>
  </form>
</div>
