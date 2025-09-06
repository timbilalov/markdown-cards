<script lang="ts">
  export let data: { cards: { id: string; title: string }[] };
  const { cards } = data;
</script>

<div class="container">
  <h1>Markdown Cards</h1>
  <div class="card-list">
    {#if cards.length > 0}
      {#each cards as card}
        <a href={`/card/${card.id}`} class="card">
          <h2>{card.title}</h2>
        </a>
      {/each}
    {:else}
      <div class="no-cards">
        <p>No cards available. If you expect to see cards here, please ensure you're properly authenticated.</p>
      </div>
    {/if}
    <a href="/card/new" class="card new-card">
      <h2>+ New Card</h2>
    </a>
  </div>
</div>

<style>
  .container {
    max-width: 800px;
    margin: 0 auto;
    padding: 2rem;
  }

  .card-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1rem;
    margin-top: 2rem;
  }

  .card {
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    padding: 1.5rem;
    text-decoration: none;
    color: inherit;
    transition: transform 0.2s, box-shadow 0.2s;
  }

  .card:hover {
    transform: translateY(-5px);
    box-shadow: 0 5px 15px rgba(0,0,0,0.1);
  }

  .new-card {
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: #f8f9fa;
    color: #6c757d;
    font-weight: bold;
  }

  .new-card:hover {
    background-color: #e9ecef;
    color: #495057;
  }

  .no-cards {
    grid-column: 1 / -1;
    text-align: center;
    padding: 2rem;
    background-color: #f8f9fa;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    color: #6c757d;
  }
</style>
