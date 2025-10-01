<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount, onDestroy } from 'svelte';
  import { isAuthenticated, logout, checkAuthStatus } from '$lib/stores/cloudStore';
  import { get } from 'svelte/store';

  let username = 'User';
  let showUserMenu = false;
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

  function toggleUserMenu() {
    showUserMenu = !showUserMenu;
  }

  function handleClickOutside(event: MouseEvent) {
    const userMenu = document.querySelector('.user-menu');
    const userButton = document.querySelector('.user-button');

    if (userMenu && userButton &&
        !userMenu.contains(event.target as Node) &&
        !userButton.contains(event.target as Node)) {
      showUserMenu = false;
    }
  }

  onMount(() => {
    document.addEventListener('click', handleClickOutside);
    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  });
</script>

<header class="header">
  <div class="header-content">
    <a href="/" class="logo-link" aria-label="Home">
      <img
        src="/images/markdown-icon.png"
        alt="Markdown Cards Logo"
        class="logo"
      />
    </a>

    <div class="header-spacer"></div>

    {#if authState}
      <div class="user-section">
        <button
          class="user-button"
          on:click={toggleUserMenu}
          aria-haspopup="true"
          aria-expanded={showUserMenu}
        >
          <span class="username">{username}</span>
        </button>

        {#if showUserMenu}
          <div class="user-menu" role="menu">
            <button
              class="menu-item"
              on:click={handleLogout}
              role="menuitem"
            >
              <img src="/images/logout-icon.png" alt="" class="menu-icon" />
              Sign Out
            </button>
          </div>
        {/if}
      </div>
    {:else}
      <button
        class="auth-button"
        on:click={handleLogin}
        aria-label="Sign in"
      >
        <img src="/images/login-icon.png" alt="Sign in" class="auth-icon" />
      </button>
    {/if}
  </div>
</header>

<style>
  .header {
    background-color: #f8f9fa;
    border-bottom: 1px solid #e9ecef;
    padding: 0.5rem 1rem;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .header-content {
    display: flex;
    align-items: center;
    max-width: 1200px;
    margin: 0 auto;
  }

  .logo-link {
    display: flex;
    align-items: center;
    text-decoration: none;
  }

  .logo {
    height: 40px;
    width: auto;
  }

  .header-spacer {
    flex-grow: 1;
  }

  .auth-button {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.5rem;
    border-radius: 50%;
    transition: background-color 0.2s;
  }

  .auth-button:hover {
    background-color: #e9ecef;
  }

  .auth-icon {
    width: 24px;
    height: 24px;
  }

  .user-section {
    position: relative;
  }

  .user-button {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: none;
    border: 1px solid #ddd;
    border-radius: 20px;
    padding: 0.5rem 1rem;
    cursor: pointer;
    transition: all 0.2s;
  }

  .user-button:hover {
    background-color: #e9ecef;
  }

  .username {
    font-size: 0.875rem;
    color: #333;
    font-weight: 500;
  }

  .user-menu {
    position: absolute;
    top: 100%;
    right: 0;
    background: white;
    border: 1px solid #ddd;
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    margin-top: 0.5rem;
    min-width: 150px;
    z-index: 1000;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.75rem 1rem;
    border: none;
    background: none;
    text-align: left;
    cursor: pointer;
    font-size: 0.875rem;
    color: #333;
  }

  .menu-item:hover {
    background-color: #f8f9fa;
  }

  .menu-icon {
    width: 16px;
    height: 16px;
  }

  @media (max-width: 768px) {
    .user-button {
      padding: 0.5rem;
    }
  }
</style>
