<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import LoginForm from '$lib/components/LoginForm.svelte';
  import { checkAuthStatus } from '$lib/stores/cloudStore';

  let error = '';
  let loading = false;

  // Check if user is already authenticated
  onMount(async () => {
    try {
      const response = await fetch('/api/auth/status');
      const data = await response.json();

      if (data.authenticated) {
        goto('/');
      }
    } catch (err) {
      console.error('Error checking auth status:', err);
    }
  });

  // Handle form submission
  async function handleLogin(event: CustomEvent<{ username: string; password: string; rememberMe: boolean }>) {
    const { username, password, rememberMe } = event.detail;

    error = '';
    loading = true;

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username,
          password,
          rememberMe
        })
      });

      const data = await response.json();

      if (response.ok) {
        // Redirect to home page on successful login
        goto('/');
        await checkAuthStatus();
      } else {
        // Display error message
        error = data.message || 'Login failed. Please try again.';
      }
    } catch (err) {
      error = 'An unexpected error occurred. Please try again.';
      console.error('Login error:', err);
    } finally {
      loading = false;
    }
  }
</script>

<div class="login-container">
  <div class="login-card">
    <div class="login-header">
      <h1>Welcome Back</h1>
      <p>Please sign in to your account</p>
    </div>

    <LoginForm {loading} {error} on:submit={handleLogin} />

    <div class="login-footer">
      <p>© 2025 Your Company. All rights reserved.</p>
    </div>
  </div>
</div>

<style>
  .login-container {
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 1rem;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  }

  .login-card {
    width: 100%;
    max-width: 400px;
    background: white;
    border-radius: 12px;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
    padding: 2rem;
    animation: slideUp 0.3s ease-out;
  }

  .login-header {
    text-align: center;
    margin-bottom: 2rem;
  }

  .login-header h1 {
    font-size: 1.75rem;
    font-weight: 600;
    color: #333;
    margin-bottom: 0.5rem;
  }

  .login-header p {
    color: #666;
    font-size: 1rem;
  }

  .login-footer {
    text-align: center;
    margin-top: 2rem;
    padding-top: 1.5rem;
    border-top: 1px solid #eee;
  }

  .login-footer p {
    color: #999;
    font-size: 0.75rem;
  }

  @keyframes slideUp {
    from {
      opacity: 0;
      transform: translateY(20px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @media (max-width: 480px) {
    .login-card {
      padding: 1.5rem;
    }

    .login-header h1 {
      font-size: 1.5rem;
    }
  }
</style>
