<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount, onDestroy } from 'svelte';
  import { isAuthenticated, logout, checkAuthStatus } from '$lib/stores/cloudStore';
  import { get } from 'svelte/store';

  let username = 'User';
  let authState = false;

  // Function to fetch user data
  async function fetchUserData() {
    if (get(isAuthenticated)) {
      try {
        const response = await fetch('/api/auth/user');
        if (response.ok) {
          const userData = await response.json();
          username = userData.username;
        }
      } catch (error) {
        console.error('Error fetching user data:', error);
      }
    } else {
      username = 'User';
    }
  }

  // Subscribe to authentication state changes
  const unsubscribe = isAuthenticated.subscribe((value) => {
    authState = value;
    // Update user data when auth state changes
    fetchUserData();
  });

  // Fetch user data when component mounts
  onMount(async () => {
    await checkAuthStatus();

    // Fetch user data after checking auth status
    fetchUserData();
  });

  // Clean up subscription
  onDestroy(() => {
    unsubscribe();
  });

  async function handleLogin() {
    goto('/login');
  }

  async function handleLogout() {
    await logout();
    // Check auth status after logout to ensure state is updated
    await checkAuthStatus();
    // Redirect to login page after logout
    goto('/login');
  }

  function onBurgerClick() {
    document.querySelector('.navbar-menu')?.classList.toggle('is-active');
    document.querySelector('.navbar-burger')?.classList.toggle('is-active');
  }
</script>

<header class="header">
  <nav class="navbar" role="navigation" aria-label="main navigation">
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

        <button class="navbar-burger" aria-label="menu" aria-expanded="false" data-target="navbar-menu" on:click={onBurgerClick}>
          <span aria-hidden="true"></span>
          <span aria-hidden="true"></span>
          <span aria-hidden="true"></span>
          <span aria-hidden="true"></span>
        </button>
      </div>

      <div class="navbar-menu" id="navbar-menu">
        <div class="navbar-start">
        </div>

        <div class="navbar-end">
          {#if authState}
            <div class="navbar-item">
              <span class="username">{username}</span>
            </div>
            <div class="navbar-item">
              <button
                class="button"
                on:click={handleLogout}
                role="menuitem"
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
