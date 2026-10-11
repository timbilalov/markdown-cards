// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { mockHttp } from './helpers/http';
import { runHandle } from './helpers/serverRequest';

vi.mock('$env/dynamic/private', () => ({ env: { SESSION_SECRET: '11'.repeat(32) } }));

vi.mock('../server/auth', () => ({ validateCredentials: vi.fn() }));
vi.mock('../utils/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

let http: ReturnType<typeof mockHttp>;
let handle: typeof import('../../hooks.server')['handle'];
let download: typeof import('../../routes/api/cloud/download/+server')['GET'];

function event(path: string, cookies: Record<string, string> = {}, method = 'GET'): RequestEvent {
  const url = new URL(path, 'https://app.example.invalid');
  // Only framework-provided request/cookie plumbing is substituted.
  return {
    url, request: new Request(url, { method }),
    cookies: { get: vi.fn((name: string) => cookies[name]), set: vi.fn() },
    getClientAddress: () => '127.0.0.1', params: {}, locals: {}, route: { id: path }
  } as unknown as RequestEvent;
}

async function resolveDownload(request: RequestEvent) {
  return download({ ...request, route: { id: '/api/cloud/download' }, params: {} });
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers(); // hooks.server starts a cleanup interval on import.
  vi.stubEnv('VITE_YANDEX_DISK_TOKEN', 'test-only-token');
  http = mockHttp();
  handle = (await import('../../hooks.server')).handle;
  download = (await import('../../routes/api/cloud/download/+server')).GET;
});

afterEach(() => http.assertHandled());

describe('Existing server boundary — characterization, not security acceptance', () => {
  it('redirects a protected request with no auth cookie', async () => {
    const resolve = vi.fn(async () => new Response('private'));
    const response = await runHandle(handle, { event: event('/'), resolve });
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/login');
    expect(resolve).not.toHaveBeenCalled();
  });

  // Unsigned-cookie acceptance moved to the session integration RED suite.

  it('rejects a foreign download URL with no allowed substring', async () => {
    const request = event('/api/cloud/download?url=' + encodeURIComponent('https://example.invalid/file'));
    expect((await resolveDownload(request)).status).toBe(400);
    expect(http.fetch).not.toHaveBeenCalled();
  });

  // Server download rejection before provider I/O is covered in serverCloudDownload.test.ts.
  // Session and Origin validation are covered in csrfOrigin.workflow.test.ts.
});
