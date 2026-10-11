// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createProductionHttp, productionOrigin as origin, productionCredentials,
  readAuthCookie, type ProductionResponse } from './helpers/productionHttp';
import { v1 } from './helpers/markdownReadFixtures';

let server: Awaited<ReturnType<typeof createProductionHttp>>;
let cookie: string;
const source = '\uFEFF' + v1.replace(/\r?\n/g, '\r\n');
// Upload's existing strict format rejects a leading BOM; do not change that contract.
const uploadSource = v1.replace(/\r?\n/g, '\r\n');
const initialRemote = { 'md-cards/existing-note.md': source };

beforeAll(async () => {
  server = await createProductionHttp();
  const login = await server.request({ url: `${origin}/api/auth/login`, method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(productionCredentials) });
  expect(login.status).toBe(200);
  cookie = readAuthCookie(login);
}, 90_000);
afterAll(async () => { await server?.close(); });
beforeEach(async () => { await server.reset(initialRemote); });
afterEach(async () => {
  if (!server) return;
  const response = await server.request({ url: `${origin}/api/auth/status` });
  expect(response.effects.unexpected).toEqual([]);
  expect(response.effects.databaseOpens).toBe(0);
});

function expectPrivate(response: ProductionResponse) {
  expect(response.headers['cache-control']).toBe('private, no-store');
  for (const header of ['cdn-cache-control', 'vercel-cdn-cache-control', 'surrogate-control', 'expires', 'etag', 'last-modified']) {
    expect(response.headers[header], header).toBeUndefined();
  }
}

function expectNoWrites(response: ProductionResponse) {
  expect(response.effects.remote).toEqual(initialRemote);
  expect(response.effects.writes).toEqual([]);
  expect(response.effects.unexpected).toEqual([]);
  expect(response.effects.databaseOpens).toBe(0);
}

async function get(path: string, method = 'GET', extraHeaders: Record<string, string> = {}) {
  return server.request({ url: `${origin}${path}`, method,
    headers: { Cookie: cookie, ...extraHeaders } });
}

describe('Private cache contract through the built production adapter', () => {
  it.each(['/', '/card/existing-note', '/card/new'])
    ('protects HTML and HEAD on %s while keeping navigation data private', async path => {
      const page = await get(path);
      const head = await get(path, 'HEAD');
      const data = await get(`${path === '/' ? '' : path}/__data.json`);
      expect(page.status).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.text.toLowerCase()).toContain('<!doctype html>');
      expect(head.status).toBe(200);
      expect(data.status).toBe(200);
      expect(data.text).toContain('"type":"data"');
      expectPrivate(data);
      expectNoWrites(page);
      expect(page.effects.requests).toEqual([]);
      expectPrivate(page);
      expectPrivate(head);
    });

  it.each(['/', '/card/existing-note'])
    ('does not authorize HTTP cache reuse with an ETag on %s', async path => {
      const first = await get(path);
      const previousTag = first.headers.etag ?? '"previous-deployment-tag"';
      const retry = await get(path, 'GET', { 'If-None-Match': previousTag });
      expect(first.status).toBe(200);
      expect(retry.status).toBe(200);
      // SSR may generate per-response identifiers, so bytes need not be identical.
      expect(retry.headers['content-type']).toContain('text/html');
      expect(retry.text.toLowerCase()).toContain('<!doctype html>');
      expectNoWrites(retry);
      expect(retry.effects.requests).toEqual([]);
      expectPrivate(first);
      expectPrivate(retry);
    });

  it.each([false, true])('protects a successful upload response with overwrite=%s and preserves exact source', async overwrite => {
    const name = overwrite ? 'existing-note.md' : 'new-note.md';
    const response = await server.request({ url: `${origin}/api/cloud/upload`, method: 'POST',
      headers: { Cookie: cookie, Origin: origin }, form: { path: name, content: uploadSource, overwrite: String(overwrite) } });
    expect(response.status).toBe(200);
    expect(response.text).toBe('File uploaded successfully');
    expect(response.effects.writes).toEqual([{ path: `md-cards/${name}`, source: uploadSource, overwrite }]);
    expect(response.effects.remote).toEqual({ ...initialRemote, [`md-cards/${name}`]: uploadSource });
    expect(response.effects.requests).toHaveLength(2);
    expectPrivate(response);
  });

  it.each([
    ['missing fields', { path: 'existing-note.md' }, 400],
    ['unsupported Markdown', { path: 'existing-note.md', content: '# legacy' }, 422]
  ] as const)('protects upload refusal for %s without touching the remote', async (_name, form, status) => {
    const response = await server.request({ url: `${origin}/api/cloud/upload`, method: 'POST',
      headers: { Cookie: cookie, Origin: origin }, form });
    expect(response.status).toBe(status);
    expectNoWrites(response);
    expect(response.effects.requests).toEqual([]);
    expectPrivate(response);
  });

  // JSON-upload rejection and absence of provider I/O are covered in requestBody.production.test.ts.

  it.each([
    ['/markdown/existing-note', 'GET', 404],
    ['/api/save', 'POST', 404],
    ['/api/cloud/download', 'POST', 405],
    ['/api/unknown-private-route', 'GET', 404],
    ['/card/existing-note/missing', 'GET', 404]
  ] as const)('protects %s %s status %s from implicit caching', async (path, method, status) => {
    const response = await server.request({ url: `${origin}${path}`, method,
      headers: { Cookie: cookie, Origin: origin, Accept: 'application/json' } });
    expect(response.status).toBe(status);
    expectNoWrites(response);
    expect(response.effects.requests).toEqual([]);
    expectPrivate(response);
  });

  it('keeps the page/list/source journey private and rechecks auth after logout without rewriting the note', async () => {
    const page = await get('/card/existing-note');
    const list = await get('/api/cloud/files');
    const legacyList = await get('/api/files');
    const download = await get('/api/cloud/download?path=existing-note.md');
    expect(page.status).toBe(200);
    expect(JSON.parse(list.text)).toEqual({ _embedded: { items: [{ name: 'existing-note.md', path: 'existing-note.md' }] } });
    expect(legacyList.status).toBe(404);
    // Response.text follows native BOM decoding; the read adapter's byte-level
    // preservation remains covered by the existing download workflow tests.
    expect(download.status).toBe(200);
    expect(download.text).toBe(source.slice(1));
    expectPrivate(list);
    expectPrivate(legacyList);
    expectPrivate(download);
    expect(download.effects.requests).toHaveLength(3);
    expectNoWrites(download);

    const logout = await server.request({ url: `${origin}/api/auth/logout`, method: 'POST',
      headers: { Cookie: cookie, Origin: origin } });
    expect(logout.status).toBe(200);
    expect(logout.cookies.every(value => value.includes('Max-Age=0'))).toBe(true);
    // Model the browser applying the cleared cookies, not revocation of a copied token.
    const denied = await server.request({ url: `${origin}/api/cloud/download?path=existing-note.md` });
    const redirected = await server.request({ url: `${origin}/card/existing-note` });
    const redirectedData = await server.request({ url: `${origin}/card/existing-note/__data.json` });
    expect(denied.status).toBe(401);
    expect(redirected.status).toBe(302);
    expect(redirected.headers.location).toBe('/login');
    expect(redirectedData.status).toBe(200);
    expect(JSON.parse(redirectedData.text)).toEqual({ type: 'redirect', location: '/login' });
    for (const response of [logout, denied, redirected, redirectedData]) {
      expectPrivate(response);
      expectNoWrites(response);
      expect(response.effects.requests).toEqual(download.effects.requests);
    }
    expectPrivate(page);
  });
});
