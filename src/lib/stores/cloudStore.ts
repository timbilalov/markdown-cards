import { writable, derived, get } from 'svelte/store';
import type { CloudFile, SyncStatus } from '../types/cloud';
import { cloudService } from '../services/cloudService';
import { dbService } from '../services/dbService';
import { parseMarkdown } from '../utils/markdownParser';
import type { Card } from '../types';

// Cloud file list store
export const cloudFiles = writable<CloudFile[]>([]);

// Sync status store
export const syncStatus = writable<SyncStatus>({
  isSyncing: false,
  lastSync: null,
  error: null
});

// Authentication status
export const isAuthenticated = writable<boolean>(false);

// Initialize authentication status based on cloud service
if (typeof window !== 'undefined') {
  isAuthenticated.set(cloudService.isAuthenticated());
}

// Load files from IndexedDB cache
export async function loadCachedFiles(): Promise<void> {
  try {
    const files = await dbService.getAllCloudFiles();
    cloudFiles.set(files);
  } catch (error) {
    console.error('Error loading cached files:', error);
  }
}

// Sync files from cloud
export async function syncFilesFromCloud(): Promise<void> {
  // Check if we're authenticated
  const authStatus = get(isAuthenticated);
  if (!authStatus) {
    return;
  }

  syncStatus.update(status => ({ ...status, isSyncing: true, error: null }));

  try {
    const response = await fetch('/api/cloud/files');

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    cloudFiles.set(data._embedded.items);
    syncStatus.update(status => ({
      ...status,
      isSyncing: false,
      lastSync: Date.now(),
      error: null
    }));
  } catch (error) {
    console.error('Error syncing files from cloud:', error);
    syncStatus.update(status => ({
      ...status,
      isSyncing: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }));
  }
}

// Load a card from cloud with local caching
export async function loadCardFromCloud(file: CloudFile): Promise<Card | null> {
  try {
    // First check if we have it in local cache
    const cachedCard = await dbService.getCard(file.name.replace('.md', ''));
    if (cachedCard) {
      // Check if the cached version is up to date
      const cachedModified = new Date(cachedCard.meta.modified).getTime();
      const cloudModified = new Date(file.modified).getTime();

      if (cachedModified >= cloudModified) {
        return cachedCard;
      }
    }

    // If not in cache or outdated, download from cloud
    const response = await fetch(`/api/cloud/download?path=${encodeURIComponent(file.path)}`);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const content = await response.text();
    const card = parseMarkdown(content);

    // Cache it locally
    await dbService.saveCard(card);

    return card;
  } catch (error) {
    console.error('Error loading card from cloud:', error);
    return null;
  }
}

// Save a card to both local cache and cloud
export async function saveCardToCloud(card: Card, filename: string): Promise<boolean> {
  try {
    // Save to local cache first
    await dbService.saveCard(card);

    // Then save to cloud
    const { serializeCard } = await import('../utils/markdownSerializer');
    const markdown = serializeCard(card);

    const formData = new FormData();
    formData.append('path', filename);
    formData.append('content', markdown);
    formData.append('overwrite', 'true');

    const response = await fetch('/api/cloud/upload', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // Update the file list to reflect the change
    await syncFilesFromCloud();

    return true;
  } catch (error) {
    console.error('Error saving card to cloud:', error);
    return false;
  }
}

// Set access token and update authentication status (kept for backward compatibility)
export function setAccessToken(token: string | null): void {
  isAuthenticated.set(!!token);
}

// Derived store for markdown files only
export const markdownFiles = derived(cloudFiles, ($cloudFiles) => {
  return $cloudFiles.filter(file => file.name.endsWith('.md'));
});

