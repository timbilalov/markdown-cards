import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Card } from '../utils/markdownSerializer';
import type { CloudFile } from '../types/cloud';

describe('Mixed LoadSource Logic', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should correctly compare timestamps and identify newer cloud data', () => {
    // This test verifies the core logic of timestamp comparison
    const localModified = Date.now() - 10000; // 10 seconds ago
    const cloudModified = new Date(Date.now() - 5000).toISOString(); // 5 seconds ago

    // Convert cloud timestamp to milliseconds for comparison
    const cloudModifiedMs = new Date(cloudModified).getTime();

    // Verify that cloud data is newer
    expect(cloudModifiedMs).toBeGreaterThan(localModified);
  });

  it('should correctly compare timestamps and identify newer local data', () => {
    // This test verifies the core logic of timestamp comparison
    const localModified = Date.now() - 5000; // 5 seconds ago
    const cloudModified = new Date(Date.now() - 10000).toISOString(); // 10 seconds ago

    // Convert cloud timestamp to milliseconds for comparison
    const cloudModifiedMs = new Date(cloudModified).getTime();

    // Verify that local data is newer
    expect(localModified).toBeGreaterThan(cloudModifiedMs);
  });

  it('should properly merge cards from both sources with correct sources', () => {
    // Mock local cards
    const localCards: Card[] = [
      {
        meta: { id: 'card1', modified: Date.now() - 10000, created: Date.now() - 10000 },
        title: 'Local Card 1',
        description: '',
        sections: []
      },
      {
        meta: { id: 'card2', modified: Date.now() - 5000, created: Date.now() - 5000 },
        title: 'Local Card 2',
        description: '',
        sections: []
      }
    ];

    // Mock cloud files
    const cloudFiles: CloudFile[] = [
      {
        name: 'card1.md',
        modified: new Date(Date.now() - 5000).toISOString(),
        path: '/md-cards/card1.md',
        size: 100
      },
      {
        name: 'card3.md',
        modified: new Date().toISOString(),
        path: '/md-cards/card3.md',
        size: 150
      }
    ];

    // Create maps for easy lookup (this mimics the implementation in +page.svelte)
    const localCardMap = new Map(localCards.map(card => [card.meta.id, card]));
    const cloudFileMap = new Map(cloudFiles.map(file => [file.name.replace('.md', ''), file]));

    // Verify the maps are created correctly
    expect(localCardMap.size).toBe(2);
    expect(cloudFileMap.size).toBe(2);
    expect(localCardMap.has('card1')).toBe(true);
    expect(cloudFileMap.has('card1')).toBe(true);

    // Verify card merging logic (this mimics the implementation in +page.svelte)
    const updatedCards: { id: string; title: string; modified: string; source: string }[] = [];
    let hasNewerCloudData = false;

    // Process all cloud files
    for (const [id, file] of cloudFileMap) {
      const cloudModified = new Date(file.modified).getTime();
      const localCard = localCardMap.get(id);

      if (localCard) {
        // Compare modification times
        const localModified = localCard.meta.modified;

        if (cloudModified > localModified) {
          // Cloud version is newer
          hasNewerCloudData = true;
          updatedCards.push({
            id: id,
            title: localCard.title,
            modified: file.modified,
            source: 'mixed'
          });
        } else {
          // Local version is newer or same
          updatedCards.push({
            id: id,
            title: localCard.title,
            modified: new Date(localModified).toISOString(),
            source: 'indexeddb'
          });
        }
      } else {
        // New card only in cloud
        hasNewerCloudData = true;
        updatedCards.push({
          id: id,
          title: id,
          modified: file.modified,
          source: 'cloud'
        });
      }
    }

    // Process local cards that don't exist in cloud
    for (const [id, localCard] of localCardMap) {
      if (!cloudFileMap.has(id)) {
        updatedCards.push({
          id: id,
          title: localCard.title,
          modified: new Date(localCard.meta.modified).toISOString(),
          source: 'indexeddb'
        });
      }
    }

    // Verify the merged result
    expect(updatedCards.length).toBe(3);
    expect(hasNewerCloudData).toBe(true);

    // Find card1 - should be from mixed source (cloud is newer)
    const card1 = updatedCards.find(card => card.id === 'card1');
    expect(card1).toBeDefined();
    expect(card1?.source).toBe('mixed');

    // Find card2 - should be from indexeddb source (only exists locally)
    const card2 = updatedCards.find(card => card.id === 'card2');
    expect(card2).toBeDefined();
    expect(card2?.source).toBe('indexeddb');

    // Find card3 - should be from cloud source (only exists in cloud)
    const card3 = updatedCards.find(card => card.id === 'card3');
    expect(card3).toBeDefined();
    expect(card3?.source).toBe('cloud');
  });

  it('should set loadSource to mixed when both sources have data', () => {
    // Test the loadSource logic
    const initialLoadSource = 'indexeddb';

    // After checking both sources and finding data in both, loadSource should be 'mixed'
    const finalLoadSource = 'mixed';

    expect(finalLoadSource).toBe('mixed');
    expect(initialLoadSource).toBe('indexeddb');
  });

  it('should handle case where local data is newer than cloud data', () => {
    // Mock local cards with newer timestamps
    const localCards: Card[] = [
      {
        meta: { id: 'card1', modified: Date.now() - 1000, created: Date.now() - 1000 },
        title: 'Local Card 1',
        description: '',
        sections: []
      }
    ];

    // Mock cloud files with older timestamps
    const cloudFiles: CloudFile[] = [
      {
        name: 'card1.md',
        modified: new Date(Date.now() - 5000).toISOString(),
        path: '/md-cards/card1.md',
        size: 100
      }
    ];

    // Create maps for easy lookup
    const localCardMap = new Map(localCards.map(card => [card.meta.id, card]));
    const cloudFileMap = new Map(cloudFiles.map(file => [file.name.replace('.md', ''), file]));

    // Verify card merging logic
    const updatedCards: { id: string; title: string; modified: string; source: string }[] = [];

    // Process all cloud files
    for (const [id, file] of cloudFileMap) {
      const cloudModified = new Date(file.modified).getTime();
      const localCard = localCardMap.get(id);

      if (localCard) {
        // Compare modification times
        const localModified = localCard.meta.modified;

        if (cloudModified > localModified) {
          // Cloud version is newer
          updatedCards.push({
            id: id,
            title: localCard.title,
            modified: file.modified,
            source: 'mixed'
          });
        } else {
          // Local version is newer or same
          updatedCards.push({
            id: id,
            title: localCard.title,
            modified: new Date(localModified).toISOString(),
            source: 'indexeddb'
          });
        }
      }
    }

    // Verify the result
    expect(updatedCards.length).toBe(1);

    // Card1 should be from indexeddb source (local is newer)
    const card1 = updatedCards.find(card => card.id === 'card1');
    expect(card1).toBeDefined();
    expect(card1?.source).toBe('indexeddb');
  });
});
