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
  initialization ??= Promise.allSettled([initDB(), checkIsSessionAuthenticated()]).then(results => {
    // Session confirmation must finish even if local storage failed, so the
    // layout can distinguish a guest from an authenticated storage failure.
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }).finally(() => {
    initialization = undefined;
  });
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
      const unsubscribeAuth = isAuthenticated.subscribe(authenticated => {
        if (!authenticated) {
          stopCloud?.();
          stopCloud = undefined;
          return;
        }
        if (stopCloud) return;
        const controller = new AbortController();
        const stopWorker = startCardSyncWorker();
        const cacheTimer = setTimeout(() => { void cacheManager.validateCache(controller.signal); }, 5000);
        const cacheInterval = setInterval(() => { void cacheManager.validateCache(controller.signal); }, 60 * 60 * 1000);
        stopCloud = () => {
          controller.abort();
          clearTimeout(cacheTimer); clearInterval(cacheInterval); stopWorker();
        };
      });
      cleanup = () => {
        unsubscribeAuth(); stopCloud?.(); unsubscribe();
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
