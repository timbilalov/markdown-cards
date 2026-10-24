import { productionStorageContext,productionFileRequests } from './helpers/productionHttp';
// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  createProductionHttp, productionOrigin as origin, productionCredentials, readAuthCookie,
  type ProductionRequest, type ProductionResponse
} from './helpers/productionHttp';
import { expectFallbackCsp, expectPageCsp, expectSecurityHeaders } from './helpers/securityPolicy';
import { v1 } from './helpers/markdownReadFixtures';

let server: Awaited<ReturnType<typeof createProductionHttp>> | undefined;
let cookie: string;
let assets: { path: string; content: string }[];
const initialRemote = { 'md-cards/note.md': v1 };

beforeAll(async () => {
  server = await createProductionHttp();
  const login = await server.request({ url: `${origin}/api/auth/login`, method: 'POST',
    headers: { 'X-Storage-Context': productionStorageContext, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(productionCredentials) });
  expect(login.status).toBe(200);
  cookie = readAuthCookie(login);
  assets = await server.readClientAssets();
}, 90_000);
beforeEach(async () => { await server!.reset(initialRemote); });
afterAll(async () => { await server?.close(); });

async function request(path: string, options: Omit<ProductionRequest, 'url'> = {}) {
  return server!.request({ ...options, url: new URL(path, origin).href,
    headers: { 'X-Storage-Context': productionStorageContext, Cookie: cookie, ...options.headers } });
}

function expectNoCloudEffects(response: ProductionResponse) {
  expect({...response.effects,requests:productionFileRequests(response)}).toEqual({ requests: [], writes: [], remote: initialRemote, unexpected: [], databaseOpens: 0 });
}

function documentOf(response: ProductionResponse): Document {
  // No resource loading or script execution; inspect actual generated markup.
  return new DOMParser().parseFromString(response.text, 'text/html');
}

function expectAuthorizedMarkup(response: ProductionResponse) {
  const document = documentOf(response);
  const policy = expectPageCsp(new Headers(response.headers));
  const scripts = [...document.querySelectorAll('script')].filter(script =>
    !script.src && (!script.type || script.type === 'module') && script.textContent?.trim());
  expect(scripts.length, 'The application must still have an executable bootstrap').toBeGreaterThan(0);
  const nonces = new Set<string>();
  for (const script of scripts) {
    const nonce = script.getAttribute('nonce') ?? '';
    expect.soft(nonce.length, 'Every inline bootstrap needs a generated nonce').toBeGreaterThan(0);
    if (nonce) {
      expect.soft(Buffer.from(nonce, 'base64').byteLength).toBeGreaterThanOrEqual(16);
      expect.soft(policy.get('script-src')).toContain(`'nonce-${nonce}'`);
      nonces.add(nonce);
    }
  }
  expect.soft(nonces.size).toBe(1);
  for (const script of document.querySelectorAll('script[src]')) {
    expect.soft(new URL(script.getAttribute('src')!, origin).origin).toBe(origin);
  }
  for (const style of document.querySelectorAll('style')) {
    const nonce = style.getAttribute('nonce');
    const hash = createHash('sha256').update(style.textContent ?? '').digest('base64');
    const allowed = policy.get('style-src') ?? [];
    expect.soft(allowed.includes(`'nonce-${nonce}'`) || allowed.includes(`'sha256-${hash}'`),
      'Any generated inline style must be authorized').toBe(true);
  }
  expect.soft([...document.querySelectorAll('[style]')].map(element => element.outerHTML.slice(0, 120))).toEqual([]);
  expect.soft([...document.querySelectorAll('*')].flatMap(element => [...element.attributes]
    .filter(attribute => /^on/i.test(attribute.name)).map(attribute => attribute.name))).toEqual([]);
  return nonces;
}

describe('CSP and security headers through the generated production entry', () => {
  it.each(['/login', '/', '/card/new', '/card/note'])('authorizes the Svelte bootstrap on %s with a fresh per-response nonce and no unsafe sources', async path => {
    const first = await request(path);
    const second = await request(path);
    const head = await request(path, { method: 'HEAD' });
    for (const response of [first, second, head]) {
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expectNoCloudEffects(response);
      expectSecurityHeaders(new Headers(response.headers));
      expectPageCsp(new Headers(response.headers));
    }
    // This fixture calls the generated Request/Response entry, not the outer
    // HTTP server that strips HEAD bodies. Check its headers/status here.
    const firstNonces = expectAuthorizedMarkup(first);
    const secondNonces = expectAuthorizedMarkup(second);
    expect.soft([...firstNonces].some(nonce => secondNonces.has(nonce))).toBe(false);
    expect.soft(first.headers['content-security-policy']).not.toBe(second.headers['content-security-policy']);
  });

  it.each([
    ['HTTPS redirect', 'http://app.example.invalid/card/note', {}, 301, false],
    ['auth redirect', '/card/note', { headers: { 'X-Storage-Context': productionStorageContext, Cookie: '' } }, 302, true],
    ['unauthenticated API', '/api/cloud/files', { headers: { 'X-Storage-Context': productionStorageContext, Cookie: '' } }, 401, true],
    ['Origin refusal', '/api/cloud/upload', { method: 'POST', headers: { 'X-Storage-Context': productionStorageContext, Origin: 'https://foreign.example.invalid' }, body: 'unread' }, 403, true],
    ['retired API', '/api/save', { method: 'POST', headers: { 'X-Storage-Context': productionStorageContext, Origin: origin } }, 404, true],
    ['method refusal', '/api/cloud/download', { method: 'POST', headers: { 'X-Storage-Context': productionStorageContext, Origin: origin } }, 405, true],
    ['unknown API', '/api/unknown', { headers: { 'X-Storage-Context': productionStorageContext, Accept: 'application/json' } }, 404, true]
  ] as const)('protects %s without removing status, cache or auth behavior', async (_name, path, options, status, secure) => {
    const response = await request(path, options);
    expect(response.status).toBe(status);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expectNoCloudEffects(response);
    if (status === 301) expect(response.headers.location).toBe(`${origin}/card/note`);
    if (status === 302) expect(response.headers.location).toBe('/login');
    if (status === 403) expect(response.bodyUsed).toBe(false);
    expectSecurityHeaders(new Headers(response.headers), secure);
    expectFallbackCsp(new Headers(response.headers));
  });

  it('keeps a rendered 404 page under the same CSP instead of weakening the error response', async () => {
    const response = await request('/card/note/missing', { headers: { 'X-Storage-Context': productionStorageContext, Accept: 'text/html' } });
    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expectNoCloudEffects(response);
    expectSecurityHeaders(new Headers(response.headers));
    expectAuthorizedMarkup(response);
  });

  it('keeps login, same-origin Save/read and logout working with the enforced response policy', async () => {
    const login = await request('/api/auth/login', { method: 'POST', headers: { 'X-Storage-Context': productionStorageContext, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(productionCredentials) });
    expect(login.status).toBe(200);
    const sessionCookie = readAuthCookie(login);
    expect(login.cookies.join(';')).toContain('HttpOnly');
    expect(login.cookies.join(';')).toContain('SameSite=Strict');
    const source = v1.replace(/\r?\n/g, '\r\n');
    const save = await request('/api/cloud/upload', { method: 'POST', headers: { 'X-Storage-Context': productionStorageContext, Cookie: sessionCookie, Origin: origin },
      form: { path: 'note.md', content: source, overwrite: 'true' } });
    expect(save.status).toBe(200);
    expect(save.effects.writes).toEqual([{ path: 'md-cards/note.md', source, overwrite: true }]);
    const read = await request('/api/cloud/download?path=note.md', { headers: { 'X-Storage-Context': productionStorageContext, Cookie: sessionCookie } });
    expect(read.status).toBe(200);
    expect(read.text).toBe(source);
    expect(read.effects.unexpected).toEqual([]);
    expect(read.effects.databaseOpens).toBe(0);
    const logout = await request('/api/auth/logout', { method: 'POST', headers: { 'X-Storage-Context': productionStorageContext, Cookie: sessionCookie, Origin: origin } });
    expect(logout.status).toBe(200);
    expect(logout.cookies.every(value => value.includes('Max-Age=0'))).toBe(true);
    const denied = await request('/api/cloud/files', { headers: { 'X-Storage-Context': productionStorageContext, Cookie: '' } });
    expect(denied.status).toBe(401);
    for (const response of [login, save, read, logout, denied]) {
      expect(response.headers['cache-control']).toBe('private, no-store');
      expectSecurityHeaders(new Headers(response.headers));
      expectFallbackCsp(new Headers(response.headers));
    }
  });
});

describe('essential styling and icons are emitted locally, without a CDN runtime', () => {
  it.each(['/login', '/', '/card/new'])('provides local CSS, icon glyphs and font bytes for %s', async path => {
    const response = await request(path);
    expect(response.status).toBe(200);
    const document = documentOf(response);
    const stylesheets = [...document.querySelectorAll('link[rel="stylesheet"]')].map(link => new URL(link.getAttribute('href')!, new URL(path, origin)));
    expect(stylesheets.length).toBeGreaterThan(0);
    expect.soft(stylesheets.filter(url => url.origin !== origin).map(url => url.href), 'No external CSS after the page is loaded').toEqual([]);
    expect.soft([...document.querySelectorAll('script[src]')].filter(script => new URL(script.getAttribute('src')!, origin).origin !== origin).map(script => script.getAttribute('src'))).toEqual([]);

    const css: string[] = [];
    const seen = new Set<string>();
    const fonts: URL[] = [];
    async function visit(url: URL): Promise<void> {
      if (url.origin !== origin || seen.has(url.href)) return;
      seen.add(url.href);
      const asset = assets.find(candidate => candidate.path === decodeURIComponent(url.pathname.slice(1)));
      expect(asset, `Referenced local stylesheet exists: ${url.pathname}`).toBeDefined();
      if (!asset) return;
      css.push(asset.content);
      for (const match of asset.content.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/g)) {
        const dependency = new URL(match[1], url);
        expect.soft(dependency.origin, 'CSS @import must be local').toBe(origin);
        await visit(dependency);
      }
      for (const match of asset.content.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/g)) {
        if (match[1].startsWith('data:') || match[1].startsWith('#')) continue;
        const dependency = new URL(match[1], url);
        expect.soft(dependency.origin, 'CSS resources must be local').toBe(origin);
        if (/\.css$/.test(dependency.pathname)) await visit(dependency);
        else if (dependency.origin === origin) {
          const relative = decodeURIComponent(dependency.pathname.slice(1));
          expect(assets.some(asset => asset.path === relative), `Emitted CSS dependency ${relative}`).toBe(true);
          if (/\.woff2$/.test(dependency.pathname)) fonts.push(dependency);
        }
      }
    }
    for (const stylesheet of stylesheets) await visit(stylesheet);
    const content = css.join('\n');
    // Existing Bulma classes still need actual bundled framework definitions.
    expect.soft(content).toContain('--bulma-');
    expect.soft(content).toMatch(/\.button[\s\S]*?\{/);
    const rules = [...content.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    for (const icon of ['fa-user', 'fa-lock', 'fa-sign-in', 'fa-sign-out', 'fa-strikethrough', 'fa-trash',
      'fa-spinner', 'fa-floppy-o', 'fa-cloud', 'fa-refresh', 'fa-file']) {
      const selector = new RegExp(`\\.${icon}(?=[\\s.:,#\\[]|$)`);
      const definitions = rules.filter(rule => selector.test(rule[1])).map(rule => rule[2]);
      // CSS minifiers may keep escapes or emit the equivalent private-use glyph.
      expect.soft(definitions.some(rule => /(?:content|--fa)\s*:\s*["']?(?:\\[0-9a-f]+|[\uE000-\uF8FF])/i.test(rule)), `Local glyph for ${icon}`).toBe(true);
    }
    expect.soft(content).toMatch(/@font-face\s*\{/);
    expect.soft(fonts.length, 'Local icons must reference a real emitted WOFF2').toBeGreaterThan(0);
    for (const font of fonts) {
      const bytes = await server!.readClientAssetBytes(decodeURIComponent(font.pathname.slice(1)));
      expect(bytes.byteLength).toBeGreaterThan(100);
      expect(Buffer.from(bytes.subarray(0, 4)).toString('ascii')).toBe('wOF2');
    }
    expectNoCloudEffects(response);
  });
});
