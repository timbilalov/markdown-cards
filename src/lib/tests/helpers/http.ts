import { expect, vi } from 'vitest';

type Responder = (init: RequestInit | undefined) => Response | Promise<Response>;

// Only the HTTP boundary is fake; stores, serialization, queue and DB stay real.
export function mockHttp({ authenticated = false }: { authenticated?: boolean } = {}) {
  const routes = new Map<string, Responder>();
  const unexpected: string[] = [];
  // Guest by default. Application fixtures explicitly choose their session;
  // browser ownership/locks are configured separately from the HTTP boundary.
  routes.set('GET /api/auth/status', () => Response.json({ authenticated }));
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const key = `${method} ${url}`;
    const respond = routes.get(key);
    if (!respond) {
      unexpected.push(key);
      throw new Error(`Unexpected HTTP request: ${key}`);
    }
    return respond(init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetch: fetchMock,
    on(method: string, url: string, respond: Responder) { routes.set(`${method} ${url}`, respond); },
    assertHandled() { expect(unexpected, 'Unhandled HTTP requests, even if production caught them').toEqual([]); }
  };
}
