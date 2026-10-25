import { prepareStorageSync,runStorageSync,readManualSyncState,verifyManualSync,dismissManualSync } from '../services/manualStorageSync';
import { loadStorageComparison } from '../services/storageManagement';
import { readLocalCaches,deleteLocalCache } from '../services/localCacheManagement';
import { get } from 'svelte/store';
import { appState } from './appState';
import { startApplication, initializeApplication } from '../services/appLifecycle';
import { createBoardLoader, type BoardLoadState } from '../application/loadBoard';
import * as cloud from './cloudStore';
import * as database from './dbStore';
import * as editor from './cardStore';
import { boardRefreshCache } from '../services/boardRefreshCache';

function boardLoader(publish: (state: BoardLoadState) => void, signal: AbortSignal) {
  return createBoardLoader({
    init: initializeApplication, readLocal: database.loadLocalCards,
    sync: cloud.syncFilesFromCloud, files: () => get(cloud.cloudFiles), load: cloud.loadCardFromCloud,
    checkIsOffline: () => !navigator.onLine, cloudError: () => get(cloud.syncStatus).error,
    clock: () => performance.now(), refreshCache: boardRefreshCache
  }, publish, signal);
}

// UI actions invoke application services. Named state views remain writable
// for editor form bindings; storage and delivery decisions belong to use cases.
export const app = {
  state: appState,
  loadStorageComparison,
  readLocalCaches,deleteLocalCache,
  prepareStorageSync,runStorageSync,readManualSyncState,verifyManualSync,dismissManualSync,
  start: startApplication,
  initialize: initializeApplication,
  createBoardLoader: boardLoader,
  async loadBoard(publish: (state: BoardLoadState) => void, signal: AbortSignal): Promise<void> {
    await boardLoader(publish, signal).load();
  },
  loadCard: editor.loadCard, openNewCard: editor.openNewCard, resetCard: editor.resetCardDocument,
  saveCard: editor.saveCard, migrateCard: editor.migrateCurrentCardFormat, retry: editor.processOfflineQueue,
  logout: () => cloud.logout(), checkIsAuthenticated: () => cloud.checkIsSessionAuthenticated()
};
