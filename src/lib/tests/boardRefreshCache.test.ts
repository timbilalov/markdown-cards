import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardRefreshRecord } from '../application/loadBoard';
import { makeFile, NOW } from './helpers/fixtures';

const session = vi.hoisted(() => ({ contextId: 'main' as string | null }));
vi.mock('../services/storageSession', () => ({ getStorageSession: () => session.contextId
  ? { descriptor: { contextId: session.contextId } } : null }));
const locks = Object.getOwnPropertyDescriptor(navigator, 'locks');
beforeEach(() => {
  vi.resetModules(); session.contextId = 'main';
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
});
afterEach(() => {
  if (locks) Object.defineProperty(navigator, 'locks', locks);
  else Reflect.deleteProperty(navigator, 'locks');
});
const record: BoardRefreshRecord = { checkedAt: NOW, files: [makeFile()], failedFilenames: ['test-card'], cachedFilenames: ['test-card'], error: null };

describe('persistent board refresh hints', () => {
  it('clears ambiguous error badges from old snapshots without invalidating the refresh interval', async () => {
    localStorage.setItem('markdown-cards:board-refresh:v1:main', JSON.stringify(record));
    expect((await import('../services/boardRefreshCache')).boardRefreshCache()!.read())
      .toEqual({ ...record, failedFilenames: [] });
  });
  it('survives a module reload and isolates different storage contexts', async () => {
    let module = await import('../services/boardRefreshCache');
    module.boardRefreshCache()!.write(record);
    vi.resetModules(); module = await import('../services/boardRefreshCache');
    expect(module.boardRefreshCache()!.read()).toEqual(record);
    session.contextId = 'reserve';
    expect(module.boardRefreshCache()!.read()).toBeNull();
    module.boardRefreshCache()!.write({ ...record, checkedAt: NOW + 1 });
    session.contextId = 'main';
    expect(module.boardRefreshCache()!.read()?.checkedAt).toBe(NOW);
    session.contextId = null;
    expect(module.boardRefreshCache()).toBeNull();
  });

  it.each(['{', '{}', JSON.stringify({ ...record, checkedAt: 'yesterday' }),
    JSON.stringify({ ...record, files: [{ name: '../outside.md', path: '../outside.md' }] })])('ignores malformed local refresh hints %s', async value => {
    localStorage.setItem('markdown-cards:board-refresh:v1:main', value);
    expect((await import('../services/boardRefreshCache')).boardRefreshCache()!.read()).toBeNull();
  });

  it('keeps the interval within this app when localStorage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('blocked'); });
    const module = await import('../services/boardRefreshCache');
    module.boardRefreshCache()!.write(record);
    expect(module.boardRefreshCache()!.read()).toEqual(record);
  });

  it('serializes refreshes for one storage without Web Locks and releases the queue after a failure', async () => {
    const module = await import('../services/boardRefreshCache');
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const calls: string[] = [];
    const first = module.boardRefreshCache()!.run(async () => {
      calls.push('first'); started.resolve(); await gate.promise; throw new Error('provider failed');
    }, new AbortController().signal);
    const failure = expect(first).rejects.toThrow('provider failed');
    await started.promise;
    const second = module.boardRefreshCache()!.run(async () => { calls.push('second'); }, new AbortController().signal);
    expect(calls).toEqual(['first']);
    gate.resolve(); await Promise.all([failure, second]);
    expect(calls).toEqual(['first', 'second']);
  });

  it('does not start cancelled work', async () => {
    const module = await import('../services/boardRefreshCache');
    const controller = new AbortController(); controller.abort();
    const task = vi.fn();
    await module.boardRefreshCache()!.run(task, controller.signal);
    expect(task).not.toHaveBeenCalled();
  });
});
