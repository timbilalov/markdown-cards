import { pathToFileURL } from 'node:url';
import type { ProductionWorkerMessage, ProductionResponse } from './productionHttp';

// Child process: native Request/Response and the actual generated platform entry.
// Only external I/O is substituted; no framework, auth, route or config mocks.
let effects: ProductionResponse['effects'];
let requestNumber = 0;
function reset(remote: Record<string, string>) {
  effects = { requests: [], writes: [], remote: { ...remote }, unexpected: [], databaseOpens: 0 };
}
reset({});
globalThis.fetch = async (input, init) => {
  const address = input instanceof Request ? input.url : String(input);
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  effects.requests.push({ url: address, method });
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    effects.unexpected.push(`${method} ${address}`);
    throw new Error('Unexpected relative HTTP in production test');
  }
  // Explicit read fixtures for the private-cache suite; all data stays in memory.
  // Existing upload handling and rejection of every other external request remain.
  const providerHeaders = { 'Cache-Control': 'public, max-age=3600', ETag: '"provider-version"' };
  if (url.origin === 'https://cloud-api.yandex.net' && method === 'GET') {
    const path = url.searchParams.get('path') ?? '';
    if (url.pathname === '/v1/disk/resources/download' && path.startsWith('disk:/md-cards/')) {
      const key = path.slice('disk:/'.length);
      if (!Object.hasOwn(effects.remote, key)) return new Response(null, { status: 404 });
      const href = new URL('https://downloader.disk.yandex.ru/disk/private-cache');
      href.searchParams.set('path', key);
      return Response.json({ href: href.href, method: 'GET', templated: false }, { headers: providerHeaders });
    }
    if (url.pathname === '/v1/disk/resources' && path === 'disk:/md-cards') {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const items = Object.keys(effects.remote).filter(key => key.startsWith('md-cards/')).map(key => ({
        name: key.slice('md-cards/'.length), path: `disk:/${key}`, type: 'file'
      }));
      return Response.json({ type: 'dir', path, _embedded: { path, offset, limit, total: items.length,
        items: items.slice(offset, offset + limit) } }, { headers: providerHeaders });
    }
  }
  if (url.origin === 'https://downloader.disk.yandex.ru' && url.pathname === '/disk/private-cache' && method === 'GET') {
    const key = url.searchParams.get('path') ?? '';
    if (Object.hasOwn(effects.remote, key)) return new Response(effects.remote[key], { headers: providerHeaders });
  }
  if (url.origin === 'https://cloud-api.yandex.net' && url.pathname === '/v1/disk/resources/upload' && method === 'GET') {
    const isAdapter = url.searchParams.get('path')?.startsWith('disk:/');
    const href = new URL(isAdapter ? 'https://uploader1d.dst.yandex.net/upload-target/write' : 'https://upload.example.invalid/write');
    href.search = url.search;
    return Response.json({ href: href.href, method: 'PUT', templated: false });
  }
  if (method === 'PUT' && ((url.origin === 'https://upload.example.invalid' && url.pathname === '/write')
    || (url.origin === 'https://uploader1d.dst.yandex.net' && url.pathname === '/upload-target/write'))) {
    const providerPath = url.searchParams.get('path') ?? '';
    const path = providerPath.startsWith('disk:/') ? providerPath.slice('disk:/'.length) : providerPath;
    const overwrite = url.searchParams.get('overwrite') === 'true';
    const source = await new Response(init?.body).text();
    if (!overwrite && Object.hasOwn(effects.remote, path)) return new Response(null, { status: 409 });
    effects.writes.push({ path, source, overwrite });
    effects.remote[path] = source;
    return new Response(null, { status: 201 });
  }
  effects.unexpected.push(`${method} ${url.href}`);
  throw new Error('Unexpected external HTTP in production test');
};
Object.defineProperty(globalThis, 'indexedDB', { value: {
  open() { effects.databaseOpens++; throw new Error('Unexpected IndexedDB in production test'); }
}, configurable: true });

try {
  const application = (await import(pathToFileURL(process.argv[2]).href)).default as {
    fetch(request: Request): Promise<Response>;
  } | ((request: Request, context: { ip: string }) => Promise<Response>);
  let queue = Promise.resolve();
  process.on('message', (message: ProductionWorkerMessage) => {
    queue = queue.then(async () => {
      try {
        if ('reset' in message) {
          reset(message.reset);
          process.send?.({ id: message.id });
          return;
        }
        const input = message.request;
        const headers = new Headers(input.headers);
        // Keep rate limiting outside this contract; never reuse a test client IP.
        const clientNumber = ++requestNumber;
        const clientIP = `198.18.${Math.floor(clientNumber / 256)}.${clientNumber % 256}`;
        headers.set('x-forwarded-for', clientIP);
        let body: BodyInit | undefined = input.bodyBytes === undefined ? input.body : new Uint8Array(input.bodyBytes);
        if (input.form) {
          const form = new FormData();
          for (const [name, value] of Object.entries(input.form)) form.set(name, value);
          body = form;
        }
        const request = new Request(input.url, { method: input.method ?? 'GET', headers, body });
        const response = typeof application === 'function'
          ? await application(request, { ip: clientIP })
          : await application.fetch(request);
        const result: ProductionResponse = {
          status: response.status, headers: Object.fromEntries(response.headers),
          cookies: response.headers.getSetCookie(), text: await response.text(),
          bodyUsed: request.bodyUsed, effects
        };
        process.send?.({ id: message.id, result });
      } catch (error) {
        process.send?.({ id: message.id, error: error instanceof Error ? error.stack : String(error) });
      }
    });
  });
  process.send?.({ ready: true });
} catch (error) {
  process.send?.({ error: error instanceof Error ? error.stack : String(error) });
  process.exit(1);
}
