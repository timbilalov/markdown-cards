import { writable } from 'svelte/store';
import { parseMarkdown } from '$lib/utils/markdownParser';
import { serializeCard } from '../utils/markdownSerializer';
import { browser } from '$app/environment';
import type { Card } from '../utils/markdownSerializer';
import { cloudService } from '../services/cloudService';
import { dbService } from '../services/dbService';
import { loadCardFromCloud, saveCardToCloud } from './cloudStore';

export const cardStore = writable<Card | null>(null);

export async function loadCard(filename: string) {
  if (!browser) return;

  try {
    // First try to load from cloud with local caching
    if (cloudService.isAuthenticated()) {
      // We need to find the cloud file first
      const response = await fetch('/api/cloud/files');

      if (response.ok) {
        const files = await response.json();
        const file = files._embedded.items.find((f: any) => f.name === `${filename}.md`);

        if (file) {
          // Load card from cloud with local caching
          const card = await loadCardFromCloud(file);
          if (card) {
            cardStore.set(card);
            return;
          }
        }
      }
    }

    // Fallback to local cache
    const cachedCard = await dbService.getCard(filename);
    if (cachedCard) {
      cardStore.set(cachedCard);
      return;
    }

    // If not found anywhere, create a new card
    const newCard = createNewCard(filename);
    cardStore.set(newCard);
  } catch (error) {
    console.error('Error loading card:', error);
    cardStore.set(null);
  }
}

export async function saveCard(filename: string, card: Card) {
  if (!browser) return;

  // Update the modified timestamp
  const updatedCard = {
    ...card,
    meta: {
      ...card.meta,
      modified: Date.now()
    }
  };

  try {
    // Save to both local cache and cloud
    const success = await saveCardToCloud(updatedCard, `${filename}.md`);
    if (!success) {
      throw new Error('Failed to save card to cloud');
    }
    cardStore.set(updatedCard);
  } catch (error) {
    console.error('Error saving card:', error);
    // Even if cloud save fails, try to save locally
    try {
      await dbService.saveCard(updatedCard);
      cardStore.set(updatedCard);
    } catch (localError) {
      console.error('Error saving card locally:', localError);
    }
  }
}

export function createNewCard(title: string): Card {
  // Use title as ID if it looks like a valid ID, otherwise generate one
  const id = title && /^[a-zA-Z0-9-_]+$/.test(title) ? title : generateRandomId();

  return {
    title,
    meta: {
      id: id,
      created: Date.now(),
      modified: Date.now()
    },
    description: '',
    status: undefined,
    tags: undefined,
    image: undefined,
    sections: []
  };
}

function generateRandomId(): string {
  return 'card-' + Math.random().toString(36).substr(2, 9);
}

