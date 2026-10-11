import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), refresh: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), auth: vi.fn() }));
vi.mock('../services/cardSyncRuntime', () => ({ startCardSyncWorker: mocks.start, subscribeSync: mocks.subscribe }));
vi.mock('../stores/cardStore', () => ({ refreshCurrentSyncStatus: mocks.refresh, isOffline: { set: vi.fn() } }));
vi.mock('../stores/cloudStore', async () => {
  const { writable } = await import('svelte/store');
  const isAuthenticated = writable(false);
  return { isAuthenticated, checkIsSessionAuthenticated: async () => {
    const authenticated = await mocks.auth();
    isAuthenticated.set(authenticated);
    return authenticated;
  } };
});
vi.mock('../services/cacheManager', () => ({ cacheManager: { validateCache: vi.fn() } }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  mocks.start.mockReturnValue(mocks.stop); mocks.subscribe.mockReturnValue(mocks.unsubscribe); mocks.auth.mockResolvedValue(true);
});
describe('application initialization and ownership', () => {
  it('coalesces concurrent DB initialization and does not leave monitoring timers', async () => {
    const { initDB } = await import('../stores/dbStore');
    const open = vi.spyOn(indexedDB, 'open');
    await Promise.all([initDB(), initDB(), initDB()]); await initDB();
    expect(open).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares one worker across mounts and cleans up timers and subscriptions on the last unmount', async () => {
    const { startApplication } = await import('../services/appLifecycle');
    const first = startApplication(); const second = startApplication();
    expect(first).toBeTypeOf('function'); expect(second).toBeTypeOf('function');
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    first(); expect(mocks.stop).not.toHaveBeenCalled();
    second(); expect(mocks.stop).toHaveBeenCalledTimes(1); expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start deferred work after unmount during initialization', async () => {
    const { initDB } = await import('../stores/dbStore'); await initDB();
    const ready = Promise.withResolvers<boolean>(); mocks.auth.mockReturnValue(ready.promise);
    const { startApplication } = await import('../services/appLifecycle');
    const stop = startApplication(); expect(stop).toBeTypeOf('function');
    stop(); ready.resolve(true); await Promise.resolve(); await Promise.resolve();
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.subscribe).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

it('reports failed initialization to the caller and permits a later retry', async () => {
  const { initDB, dbError, dbInitialized } = await import('../stores/dbStore');
  const { dbService } = await import('../services/dbService');
  const { get } = await import('svelte/store');
  vi.spyOn(dbService, 'init').mockRejectedValueOnce(new Error('blocked upgrade'));
  await expect(initDB()).rejects.toThrow('blocked upgrade');
  expect(get(dbInitialized)).toBe(false); expect(get(dbError)).toBe('blocked upgrade');
  await initDB(); expect(get(dbInitialized)).toBe(true); expect(get(dbError)).toBeNull();
});
