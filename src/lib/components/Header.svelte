<script lang="ts">
  import { goto } from '$app/navigation';
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
  </div>
</header>

<style>
  .header {
    background-color: #f8f9fa;
    border-bottom: 1px solid #e9ecef;
    padding: 0.5rem 1rem;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
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
</style>
