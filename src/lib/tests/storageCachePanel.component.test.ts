import { afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import StorageCacheHarness from './helpers/StorageCacheHarness.svelte';
import type { StorageComparison } from '../services/storageManagement';

const actions = vi.hoisted(() => ({ readLocalCaches: vi.fn() }));
vi.mock('../stores/appFacade', () => ({ app: actions }));

let component: ReturnType<typeof mount> | undefined;
const target = document.createElement('div');
const model: StorageComparison = {
  catalogError: null,
  columns: [],
  snapshots: [],
  rows: [],

  storages: new Map()
};

afterEach(async () => {
  if (component) await unmount(component);
  target.remove();
});

it('clears a previous cache read error after the refreshed comparison loads successfully', async () => {
  document.body.append(target);
  actions.readLocalCaches.mockRejectedValueOnce(new Error('storage unavailable'));
  actions.readLocalCaches.mockResolvedValue([]);
  component = mount(StorageCacheHarness, { target, props: { model, oncomplete: async () => {} } });
  flushSync();
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('Не удалось проверить');
  });

  target.querySelector<HTMLButtonElement>('button')!.click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector('[role="alert"]')).toBeNull();
    expect(target.querySelector('[role="status"]')).toBeNull();
  });
});
