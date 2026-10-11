import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mockHttp } from './helpers/http';

vi.mock('$app/environment', () => ({ browser: true }));
let http: ReturnType<typeof mockHttp>;
let runtime: typeof import('svelte');
let component: ReturnType<typeof import('svelte')['mount']> | undefined;
let target: HTMLDivElement;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('VITE_YANDEX_DISK_TOKEN', '');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  http = mockHttp();
  http.on('GET', '/api/auth/status', () => Response.json({ authenticated: false }));
  runtime = await import('svelte');
  await (await import('../stores/cloudStore')).checkIsSessionAuthenticated();
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(async () => {
  if (component) await runtime.unmount(component);
  component = undefined;
  target?.remove();
  http.assertHandled();
});

it('offers sign-in on the empty signed-out board without asking for a browser token', async () => {
  const MainPage = (await import('../../routes/+page.svelte')).default;
  component = runtime.mount(MainPage, { target });
  await vi.waitFor(() => {
    runtime.flushSync();
    expect(target.querySelector('.status-bar')?.textContent).toContain('Loaded from');
  });
  const hint = target.querySelector('.no-cards');
  expect(hint?.querySelector('a[href="/login"]'), 'An actionable session sign-in link').not.toBeNull();
  expect(hint?.textContent?.trim().length).toBeGreaterThan(0);
  expect(hint?.textContent).not.toMatch(/VITE_|YANDEX_DISK_TOKEN|\.env/);
  expect(http.fetch.mock.calls.every(([url]) => String(url) === '/api/auth/status')).toBe(true);
});
