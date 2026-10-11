import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mockHttp } from './helpers/http';
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
let runtime: typeof import('svelte');
let component: ReturnType<typeof import('svelte')['mount']> | undefined;
let target: HTMLDivElement;
beforeEach(async () => {
  vi.resetModules(); const http = mockHttp();
  http.on('GET', '/api/auth/status', () => Response.json({ authenticated: false }));
  runtime = await import('svelte'); target = document.createElement('div'); document.body.append(target);
});
afterEach(async () => { if (component) await runtime.unmount(component); component = undefined; target.remove(); });
it('keeps the mobile menu aria-expanded in sync with its visible state', async () => {
  const Header = (await import('../components/Header.svelte')).default;
  component = runtime.mount(Header, { target }); runtime.flushSync();
  const button = target.querySelector<HTMLButtonElement>('.navbar-burger')!;
  button.click(); runtime.flushSync();
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(target.querySelector('.navbar-menu')?.classList.contains('is-active')).toBe(true);
  button.click(); runtime.flushSync();
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(target.querySelector('.navbar-menu')?.classList.contains('is-active')).toBe(false);
});
