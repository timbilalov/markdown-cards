import { writable, derived, get } from 'svelte/store';
import type { CloudFile, SyncStatus } from '../types/cloud';
import { cloudService } from '../services/cloudService';
import { dbService } from '../services/dbService';
import { performanceMonitor } from '../services/performanceMonitor';
import { cacheManager } from '../services/cacheManager';
import { offlineQueue } from '../services/offlineQueue';
import { parseMarkdown } from '../utils/markdownParser';
import type { Card } from '../types';
import { browser } from '$app/environment';

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

// Offline status
export const isOffline = writable<boolean>(false);

// Performance metrics
export const cloudPerformance = writable<{
  operations: number;
  averageDuration: number;
  errorRate: number;
}>({
  operations: 0,
  averageDuration: 0,
  errorRate: 0
});

// Initialize authentication status by checking with the server
if (typeof window !== 'undefined') {
  // Check authentication status with server on initialization
  checkAuthStatus();
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

  const startTime = performanceMonitor.start('cloud');

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

    performanceMonitor.end('cloud', startTime, true);
  } catch (error) {
    console.error('Error syncing files from cloud:', error);
    syncStatus.update(status => ({
      ...status,
      isSyncing: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }));

    performanceMonitor.end('cloud', startTime, false);

    // Set offline status
    isOffline.set(true);
  }
}

// Load a card from cloud with local caching (enhanced version)
export async function loadCardFromCloud(file: CloudFile): Promise<Card | null> {
  const startTime = performanceMonitor.start('cloud');

  try {
    // First check if we have it in local cache
    const cachedCard = await dbService.getCard(file.name.replace('.md', ''));
    const cloudModified = new Date(file.modified).getTime();

    if (cachedCard) {
      // Check if the cached version is up to date
      const cachedModified = new Date(cachedCard.meta.modified).getTime();

      if (cachedModified >= cloudModified) {
        performanceMonitor.end('cloud', startTime, true);
        performanceMonitor.recordCacheHit('card', true);
        return cachedCard;
      }
    }

    // If not in cache or outdated, download from cloud
    // Use cloudService to handle CORS properly
    if (!file.file) {
      throw new Error('File download URL is not available');
    }
    const content = await cloudService.downloadFile(file.file);
    const parsedCard = parseMarkdown(content);
    const card: Card = {
      ...parsedCard,
      meta: {
        ...parsedCard.meta,
        modified: cloudModified,
      },
    };

    // Cache it locally
    await dbService.saveCard(card);

    performanceMonitor.end('cloud', startTime, true);
    performanceMonitor.recordCacheHit('card', false);
    return card;
  } catch (error) {
    console.error('Error loading card from cloud:', error);
    performanceMonitor.end('cloud', startTime, false);
    performanceMonitor.recordCacheHit('card', false);
    return null;
  }
}

// Save a card to both local cache and cloud (enhanced version with offline support)
export async function saveCardToCloud(card: Card, filename: string): Promise<boolean> {
  const startTime = performanceMonitor.start('sync');

  try {
    // Save to local cache first (immediate persistence)
    await dbService.saveCard(card);

    // Try to save to cloud
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
      // If cloud save fails, queue for later sync
      await offlineQueue.queueOperation('update', card);
      isOffline.set(true);
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // Update the file list to reflect the change
    await syncFilesFromCloud();

    performanceMonitor.end('sync', startTime, true);
    return true;
  } catch (error) {
    console.error('Error saving card to cloud:', error);
    performanceMonitor.end('sync', startTime, false);

    // Even if cloud save fails, we still have local persistence
    // The operation has been queued for later sync
    return false;
  }
}

// Initialize the application with cloud data
export async function initializeApp(): Promise<void> {
  // Initialize database
  await dbService.init();

  // Load cached files first for immediate display
  await loadCachedFiles();

  // Try to sync with cloud
  await syncFilesFromCloud();

  // Validate cache periodically
  setInterval(async () => {
    await cacheManager.validateCache();
  }, 60 * 60 * 1000); // Every hour

  // Process offline queue when online
  if (browser) {
    window.addEventListener('online', async () => {
      isOffline.set(false);
      await offlineQueue.processQueue();
    });

    window.addEventListener('offline', () => {
      isOffline.set(true);
    });
  }
}

// Set authentication status
export function setAuthenticationStatus(status: boolean): void {
  isAuthenticated.set(status);
}

// Logout function
export async function logout(): Promise<void> {
  try {
    const response = await fetch('/api/auth/logout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      }
    });

    if (response.ok) {
      // Update authentication status
      isAuthenticated.set(false);

      // Clear cloud files
      cloudFiles.set([]);
    } else {
      console.error('Logout failed');
    }
  } catch (error) {
    console.error('Logout error:', error);
  }
}

// Check authentication status with server
export async function checkAuthStatus(): Promise<boolean> {
  try {
    const response = await fetch('/api/auth/status');
    const data = await response.json();
    const isAuthenticatedStatus = data.authenticated;
    isAuthenticated.set(isAuthenticatedStatus);
    return isAuthenticatedStatus;
  } catch (error) {
    console.error('Error checking auth status:', error);
    isAuthenticated.set(false);
    return false;
  }
}

// Derived store for markdown files only
export const markdownFiles = derived(cloudFiles, ($cloudFiles) => {
  return $cloudFiles.filter(file => file.name.endsWith('.md'));
});

// Get cloud performance metrics
export function getCloudPerformanceMetrics() {
  // In a real implementation, you would track cloud service performance
  // For now, we'll return mock data
  return {
    operations: 0,
    averageDuration: 0,
    errorRate: 0
  };
}

// Reset cloud performance metrics
export function resetCloudPerformanceMetrics() {
  // Reset cloud performance metrics
}
