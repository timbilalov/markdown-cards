import { stateField } from './appState';
import { get } from 'svelte/store';
import type { CloudFile } from '../types/cloud';
import { cloudService } from '../services/cloudService';
import { performanceMonitor } from '../services/performanceMonitor';
import { getCardSync } from '../services/cardSyncRuntime';
import { parseMarkdownDocument } from '../domain/markdown';
import { parseCloudModifiedTime } from '../utils/cloudMetadata';
import type { Card } from '../domain/types';
import { isAuthenticated, sessionGeneration, setAuthenticationStatus, confirmAuthenticationStatus } from './sessionState';
export { isAuthenticated, setAuthenticationStatus } from './sessionState';

export const cloudFiles = stateField('files');
export const syncStatus = stateField('cloudStatus');
let listingRequest = 0;

// Sync files from cloud
export async function syncFilesFromCloud(signal?: AbortSignal): Promise<void> {
  // Check if we're authenticated
  const authStatus = get(isAuthenticated);
  if (!authStatus || signal?.aborted) {
    return;
  }
  const generation = sessionGeneration();
  const request = ++listingRequest;
  const checkIsCurrent = () => request === listingRequest && generation === sessionGeneration() && get(isAuthenticated);

  syncStatus.update(status => ({ ...status, isSyncing: true, error: null }));

  const startTime = performanceMonitor.start('cloud');
  let success = false;

  try {
    const data = await cloudService.listFiles(signal);
    // The HTTP read succeeded even if a newer request now owns publication.
    success = true;
    if (!checkIsCurrent() || signal?.aborted) return;
    cloudFiles.set(data._embedded.items);
    syncStatus.update(status => ({
      ...status,
      isSyncing: false,
      lastSync: Date.now(),
      error: null
    }));

  } catch (error) {
    if (!checkIsCurrent() || signal?.aborted) return;
    console.error('Error syncing files from cloud:', error);
    syncStatus.update(status => ({
      ...status,
      isSyncing: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }));

  } finally {
    if (checkIsCurrent() && signal?.aborted) syncStatus.update(status => ({ ...status, isSyncing: false }));
    if (!signal?.aborted) performanceMonitor.end('cloud', startTime, success);
  }
}

// Read a display Card from either a protected local version or the provider.
export async function loadCardFromCloud(file: CloudFile, signal?: AbortSignal): Promise<Card | null> {
  const startTime = performanceMonitor.start('cloud');
  let success = false;
  let cacheHit = false;

  try {
    const loaded = await (await getCardSync()).load(file.name, {
      projectCard: true, listed: true, modifiedAt: parseCloudModifiedTime(file.modified), signal
    });
    if ('projection' in loaded && loaded.projection) { success = true; cacheHit = true; return loaded.projection; }
    if (!('source' in loaded)) return null;
    cacheHit = loaded.origin === 'local';
    const parsed = parseMarkdownDocument(loaded.source);
    if (parsed.status !== 'success') return null;
    const card = parsed.document.card;

    success = true;
    return card;
  } catch (error) {
    console.error('Error loading card from cloud:', error);
    return null;
  } finally {
    // Voluntary cancellation is excluded from completed-read statistics.
    if (!signal?.aborted) {
      performanceMonitor.end('cloud', startTime, success);
      performanceMonitor.recordCacheHit('card', cacheHit);
    }
  }
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
      setAuthenticationStatus(false);

      // Clear cloud files
      cloudFiles.set([]);
      syncStatus.set({ isSyncing: false, lastSync: null, error: null });
    } else {
      console.error('Logout failed');
    }
  } catch (error) {
    console.error('Logout error:', error);
  }
}

// Check authentication status with server
export async function checkIsSessionAuthenticated(): Promise<boolean> {
  const generation = sessionGeneration();
  try {
    const response = await fetch('/api/auth/status');
    const data = await response.json();
    if (generation !== sessionGeneration()) return get(isAuthenticated);
    const isAuthenticatedStatus = response.ok && data?.authenticated === true;
    confirmAuthenticationStatus(isAuthenticatedStatus);
    return isAuthenticatedStatus;
  } catch (error) {
    console.error('Error checking auth status:', error);
    if (generation !== sessionGeneration()) return get(isAuthenticated);
    confirmAuthenticationStatus(false);
    return false;
  }
}
