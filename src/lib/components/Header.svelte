<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { isAuthenticated } from '$lib/stores/cloudStore';
  import { app } from '$lib/stores/appFacade';

  let username = 'User';
  let menuOpen = false;

  onMount(() => {
    let request = 0;
    const unsubscribe = isAuthenticated.subscribe(authenticated => {
      const current = ++request;
      username = 'User';
      if (authenticated) void fetch('/api/auth/user').then(async response => {
        const data: unknown = response.ok ? await response.json() : null;
        if (current === request && data && typeof data === 'object'
          && 'username' in data && typeof data.username === 'string') username = data.username;
      }).catch(() => {});
    });
    return () => { request++; unsubscribe(); };
  });

  async function handleLogin() {
    goto('/login');
  }

  async function handleLogout() {
    await app.logout();
    // Redirect to login page after logout
    goto('/login');
  }


</script>

<header class="header">
  <nav class="navbar" aria-label="main navigation">
    <div class="container p-4">
      <div class="navbar-brand">
        <div class="navbar-item">
          <a href="/" class="logo-link" aria-label="Home">
            <img
              src="/images/markdown-icon.png"
              alt="Markdown Cards Logo"
              class="logo"
            />
            <span>Markdown Cards</span>
          </a>
        </div>

        <button class="navbar-burger" class:is-active={menuOpen} aria-label="menu" aria-expanded={menuOpen} aria-controls="navbar-menu" on:click={() => menuOpen = !menuOpen}>
          <span aria-hidden="true"></span>
          <span aria-hidden="true"></span>
          <span aria-hidden="true"></span>
          <span aria-hidden="true"></span>
        </button>
      </div>

      <div class="navbar-menu" class:is-active={menuOpen} id="navbar-menu">
        <div class="navbar-start">
        </div>

        <div class="navbar-end">
          {#if $isAuthenticated}
            <div class="navbar-item">
              <span class="username">{username}</span>
            </div>
            <div class="navbar-item">
              <button
                class="button"
                on:click={handleLogout}
              >
                <span class="icon">
                  <i class="fa fa-sign-out"></i>
                </span>
                <span>Sign Out</span>
              </button>
            </div>
          {:else}
            <div class="navbar-item">
              <button
                class="button"
                on:click={handleLogin}
                aria-label="Sign in"
              >
                <span class="icon">
                  <i class="fa fa-sign-in"></i>
                </span>
                <span>Sign In</span>
              </button>
            </div>
          {/if}
        </div>
      </div>
    </div>
  </nav>
</header>

<style>
  .header {
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    position: sticky;
    top: 0;
    z-index: 100;
    margin-bottom: 20px;
  }

  .logo-link {
    display: flex;
    align-items: center;
    text-decoration: none;
    gap: 10px;
    color: inherit;
  }

  .logo {
    height: 40px;
    width: auto;
  }

  @media (prefers-color-scheme: dark) {
    .logo {
      filter: invert(1);
    }
  }
</style>
