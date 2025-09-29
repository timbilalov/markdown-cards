import { writable, get } from 'svelte/store';
import { parseMarkdown } from '$lib/utils/markdownParser';
import { serializeCard } from '../utils/markdownSerializer';
import { browser } from '$app/environment';
import type { Card } from '../utils/markdownSerializer';
import { cloudService } from '../services/cloudService';
import { dbService } from '../services/dbService';
import { performanceMonitor } from '../services/performanceMonitor';
import { offlineQueue } from '../services/offlineQueue';
import { loadCardFromCloud, saveCardToCloud } from './cloudStore';

// Card store with additional metadata
export interface CardWithMetadata extends Card {
  _metadata?: {
    source: 'indexeddb' | 'cloud' | 'memory';
    loadTime: number;
  };
}

export const cardStore = writable<CardWithMetadata | null>(null);

// Loading status
export const cardLoading = writable<boolean>(false);
export const cardLoadSource = writable<'indexeddb' | 'cloud' | 'memory' | null>(null);
export const cardLoadTime = writable<number>(0);

// Save status
export const cardSaving = writable<boolean>(false);
export const cardSaveError = writable<string | null>(null);
export const isOffline = writable<boolean>(false);

export async function loadCard(filename: string) {
  if (!browser) return;

  cardLoading.set(true);
  cardLoadSource.set(null);
  const startTime = performance.now();

  try {
    // First try to load from IndexedDB for instant display
    const cachedCard = await dbService.getCard(filename);
    if (cachedCard) {
      const cardWithMetadata: CardWithMetadata = {
        ...cachedCard,
        _metadata: {
          source: 'indexeddb',
          loadTime: performance.now() - startTime
        }
      };

      cardStore.set(cardWithMetadata);
      cardLoadSource.set('indexeddb');
      cardLoadTime.set(performance.now() - startTime);

      // If we're online, check if there's a newer version in the cloud
      if (cloudService.isAuthenticated() && navigator.onLine) {
        try {
          // We need to find the cloud file first
          const response = await fetch('/api/cloud/files');

          if (response.ok) {
            const files = await response.json();
            const file = files._embedded.items.find((f: any) => f.name === `${filename}.md`);

            if (file) {
              const cloudModified = new Date(file.modified).getTime();

              if (cloudModified > cachedCard.meta.modified) {
                // Load updated version from cloud
                const cloudCard = await loadCardFromCloud(file);
                if (cloudCard) {
                  const updatedCardWithMetadata: CardWithMetadata = {
                    ...cloudCard,
                    _metadata: {
                      source: 'cloud',
                      loadTime: performance.now() - startTime
                    }
                  };

                  cardStore.set(updatedCardWithMetadata);
                  cardLoadSource.set('cloud');
                  cardLoadTime.set(performance.now() - startTime);

                  await dbService.saveCard(cloudCard);
                }
              }
            }
          }
        } catch (cloudError) {
          console.warn('Could not check cloud for updated version:', cloudError);
        }
      }

      cardLoading.set(false);
      return;
    }

    // If not in IndexedDB, try cloud if authenticated
    if (cloudService.isAuthenticated()) {
      try {
        // We need to find the cloud file first
        const response = await fetch('/api/cloud/files');

        if (response.ok) {
          const files = await response.json();
          const file = files._embedded.items.find((f: any) => f.name === `${filename}.md`);

          if (file) {
            // Load card from cloud with local caching
            const card = await loadCardFromCloud(file);
            if (card) {
              const cardWithMetadata: CardWithMetadata = {
                ...card,
                _metadata: {
                  source: 'cloud',
                  loadTime: performance.now() - startTime
                }
              };

              cardStore.set(cardWithMetadata);
              cardLoadSource.set('cloud');
              cardLoadTime.set(performance.now() - startTime);
              cardLoading.set(false);
              return;
            }
          }
        }
      } catch (cloudError) {
        console.warn('Could not load card from cloud:', cloudError);
      }
    }

    // If not found anywhere, create a new card
    const newCard = createNewCard(filename);
    const newCardWithMetadata: CardWithMetadata = {
      ...newCard,
      _metadata: {
        source: 'memory',
        loadTime: performance.now() - startTime
      }
    };

    cardStore.set(newCardWithMetadata);
    cardLoadSource.set('memory');
    cardLoadTime.set(performance.now() - startTime);
    cardLoading.set(false);
  } catch (error) {
    console.error('Error loading card:', error);
    cardStore.set(null);
    cardLoading.set(false);
  }
}

export async function saveCard(filename: string, card: Card) {
  if (!browser) return;

  cardSaving.set(true);
  cardSaveError.set(null);

  // Update the modified timestamp
  const updatedCard = {
    ...card,
    meta: {
      ...card.meta,
      modified: Date.now()
    }
  };

  try {
    // Then try to save to cloud
    const success = await saveCardToCloud(updatedCard, `${filename}.md`);
    if (!success) {
      // Even if cloud save fails, we have local persistence
      isOffline.set(true);
      // The operation has been queued for later sync
    }

    // Update the store with the saved card
    const cardWithMetadata: CardWithMetadata = {
      ...updatedCard,
      _metadata: {
        source: 'indexeddb', // After save, card is in IndexedDB
        loadTime: 0
      }
    };

    cardStore.set(cardWithMetadata);
    cardSaving.set(false);
  } catch (error) {
    console.error('Error saving card:', error);
    cardSaveError.set(error instanceof Error ? error.message : 'Failed to save card');

    // Since we already saved to IndexedDB, we don't need to do it again
    // Just update the UI to reflect offline status
    const cardWithMetadata: CardWithMetadata = {
      ...updatedCard,
      _metadata: {
        source: 'indexeddb',
        loadTime: 0
      }
    };

    cardStore.set(cardWithMetadata);
    isOffline.set(true);

    cardSaving.set(false);
  }

  // Save to IndexedDB after cloud save
  updatedCard.meta.modified = Date.now();
  await dbService.saveCard(updatedCard);
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

// Process offline queue
export async function processOfflineQueue(): Promise<void> {
  if (cloudService.isAuthenticated() && navigator.onLine) {
    await offlineQueue.processQueue();
  }
}

// Get card load performance metrics
export function getCardLoadMetrics() {
  return {
    source: get(cardLoadSource),
    loadTime: get(cardLoadTime)
  };
}
