import { loadCard, createNewCard } from '$lib/stores/cardStore';
import { cardStore } from '$lib/stores/cardStore';

export async function load({ params }: { params: { slug: string } }) {
  if (params.slug === 'new') {
    // For new cards, we don't load from file, just initialize the store
    const newCard = createNewCard('New Card');
    cardStore.set(newCard);
  } else {
    await loadCard(params.slug);
  }
  return {};
}
