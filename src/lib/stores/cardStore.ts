import { writable } from 'svelte/store';
import { parseMarkdown } from '$lib/utils/markdownParser';
import { serializeCard } from '../utils/markdownSerializer';
import { browser } from '$app/environment';
import type { Card } from '../types';

export const cardStore = writable<Card | null>(null);

export async function loadCard(filename: string) {
  if (!browser) return;

  try {
    // For browser environment, we need to handle authentication
    // This will be handled by the browser's built-in Basic Auth dialog
    const response = await fetch(`/markdown/${filename}`);
    if (!response.ok) {
      throw new Error(`Failed to load card: ${response.status} ${response.statusText}`);
    }
    const markdown = await response.text();
    const parsedCard = parseMarkdown(markdown);
    cardStore.set(parsedCard);
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
    const markdown = serializeCard(updatedCard);
    const response = await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, content: markdown })
    });

    if (!response.ok) {
      throw new Error('Failed to save card');
    }
  } catch (error) {
    console.error('Error saving card:', error);
  }
}

export function createNewCard(title: string): Card {
  return {
    title,
    meta: {
      id: generateRandomId(),
      created: Date.now(),
      modified: Date.now()
    },
    description: '',
    sections: []
  };
}

function generateRandomId(): string {
  return 'card-' + Math.random().toString(36).substr(2, 9);
}
