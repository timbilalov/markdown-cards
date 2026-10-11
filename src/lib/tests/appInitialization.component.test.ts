import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { isAuthenticated } from '../stores/cloudStore';
import LayoutHarness from './helpers/LayoutHarness.svelte';
import { mockHttp } from './helpers/http';

const mocks = vi.hoisted(() => ({ initialize: vi.fn(), start: vi.fn(), stop: vi.fn(), goto: vi.fn() }));
vi.mock('$app/state', () => ({ page: { url: new URL('https://app.example.invalid/') } }));
vi.mock('$app/navigation', () => ({ goto: mocks.goto }));
vi.mock('../stores/appFacade', () => ({ app: { initialize: mocks.initialize, start: mocks.start } }));
vi.mock('../stores/cloudStore', async () => {
  const { writable } = await import('svelte/store'); return { isAuthenticated: writable(false) };
});
let target: HTMLDivElement;
let component: ReturnType<typeof mount> | undefined;
let http: ReturnType<typeof mockHttp>;
beforeEach(() => {
  vi.clearAllMocks(); mocks.start.mockReturnValue(mocks.stop);
  mocks.initialize.mockRejectedValueOnce(new Error('IndexedDB blocked')).mockResolvedValue(undefined);
  (isAuthenticated as import('svelte/store').Writable<boolean>).set(false);
  http = mockHttp(); http.on('GET', '/api/auth/user', () => Response.json({ username: 'test-user' }));
  target = document.createElement('div'); document.body.append(target);
});
afterEach(async () => { if (component) await unmount(component); component = undefined; target.remove(); http.assertHandled(); });

it('redirects a guest after initialization fails and exposes a readable error', async () => {
  component = mount(LayoutHarness, { target }); flushSync();
  await vi.waitFor(() => { flushSync(); expect(target.querySelector('[role="alert"]')).not.toBeNull(); });
  expect(mocks.goto).toHaveBeenCalledWith('/login', { replaceState: true });
  expect(target.textContent).toContain('IndexedDB blocked');
  expect(target.textContent).not.toContain('Protected page content');
});

it('retries failed initialization and restarts application ownership before showing the page', async () => {
  (isAuthenticated as import('svelte/store').Writable<boolean>).set(true);
  component = mount(LayoutHarness, { target }); flushSync();
  await vi.waitFor(() => { flushSync(); expect(target.querySelector('[role="alert"]')).not.toBeNull(); });
  expect(target.textContent).not.toContain('Protected page content');
  const ready = Promise.withResolvers<void>(); mocks.initialize.mockReturnValueOnce(ready.promise);
  target.querySelector<HTMLButtonElement>('button[data-retry-initialization]')!.click();
  flushSync(); expect(target.textContent).not.toContain('Protected page content');
  ready.resolve();
  await vi.waitFor(() => { flushSync(); expect(target.textContent).toContain('Protected page content'); });
  expect(mocks.start).toHaveBeenCalledTimes(2);
  expect(mocks.stop).toHaveBeenCalledTimes(1);
  expect(target.querySelector('[role="alert"]')).toBeNull();
});
