import { initializeStorageSession } from './storageSession';
import { initDB } from '../stores/dbStore';
import { checkIsSessionAuthenticated, isAuthenticated } from '../stores/cloudStore';
import { refreshCurrentSyncStatus, isOffline } from '../stores/cardStore';
import { startCardSyncWorker, subscribeSync } from './cardSyncRuntime';
import { cacheManager } from './cacheManager';

let mounts = 0;
let generation = 0;
let cleanup: (() => void) | undefined;
let initialization: Promise<void> | undefined;
export function initializeApplication(): Promise<void> {
  initialization ??= checkIsSessionAuthenticated()
    .then(authenticated => initializeStorageSession(authenticated))
    .then(() => initDB()).finally(() => { initialization = undefined; });
  return initialization;
}
export function startApplication(): () => void {
  if (++mounts === 1) {
    const current = ++generation;
    void initializeApplication().then(() => {
      if (!mounts || current !== generation) return;
      const updateConnection = () => isOffline.set(!navigator.onLine);
      updateConnection();
      window.addEventListener('online', updateConnection);
      window.addEventListener('offline', updateConnection);
      const unsubscribe = subscribeSync(() => { void refreshCurrentSyncStatus(); });
      let stopCloud: (() => void) | undefined;
      let authRevision = 0;
      const unsubscribeAuth = isAuthenticated.subscribe(authenticated => {
        const revision = ++authRevision;
        if (!authenticated) {
          stopCloud?.();
          stopCloud = undefined;
          void initializeStorageSession(false).catch(error => console.error(error));
          return;
        }
        if (stopCloud) return;
        void initializeStorageSession(true).then(session => {
        if (!session.verified || revision !== authRevision || !mounts || current !== generation || stopCloud) return;
        const controller = new AbortController();
        const stopWorker = startCardSyncWorker();
        const cacheTimer = setTimeout(() => { void cacheManager.validateCache(controller.signal); }, 5000);
        const cacheInterval = setInterval(() => { void cacheManager.validateCache(controller.signal); }, 60 * 60 * 1000);
        stopCloud = () => {
          controller.abort();
          clearTimeout(cacheTimer); clearInterval(cacheInterval); stopWorker();
        };
        }).catch(error => console.error('Storage context initialization failed:', error));
      });
      cleanup = () => {
        ++authRevision; unsubscribeAuth(); stopCloud?.(); unsubscribe();
        window.removeEventListener('online', updateConnection); window.removeEventListener('offline', updateConnection);
      };
    }).catch(error => console.error('Application initialization failed:', error));
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--mounts === 0) { generation++; cleanup?.(); cleanup = undefined; }
  };
}
