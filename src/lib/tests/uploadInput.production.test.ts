// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createProductionHttp, productionCredentials, readAuthCookie, type ProductionResponse } from './helpers/productionHttp';
import { inputSource } from './helpers/requestBodyFixtures';
import { adapterUploadUrl } from './helpers/cloudUploadHttp';
import { existingFilename, initialUploadRemote, newFilename, productionUploadBody,
  unicodeFilename, uploadFields, uploadInputOrigin as origin, type UploadField } from './helpers/uploadInputFixtures';

let server: Awaited<ReturnType<typeof createProductionHttp>>;
let cookie: string;

beforeAll(async () => {
  server = await createProductionHttp();
  const login = await server.request({ url: `${origin}/api/auth/login`, method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(productionCredentials) });
  expect(login.status).toBe(200);
  cookie = readAuthCookie(login);
}, 90_000);
afterAll(async () => { await server?.close(); });
beforeEach(async () => { await server.reset(initialUploadRemote); });
afterEach(async () => {
  if (!server) return;
  const response = await server.request({ url: `${origin}/api/auth/status` });
  expect(response.effects.unexpected).toEqual([]);
  expect(response.effects.databaseOpens).toBe(0);
});

function expectPrivate(response: ProductionResponse) {
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.headers.location).toBeUndefined();
  for (const name of ['cdn-cache-control', 'vercel-cdn-cache-control', 'surrogate-control', 'expires', 'etag', 'last-modified']) {
    expect(response.headers[name], name).toBeUndefined();
  }
}

function expectNoEffects(response: ProductionResponse) {
  expect(response.cookies).toEqual([]);
  expect(response.effects.requests).toEqual([]);
  expect(response.effects.writes).toEqual([]);
  expect(response.effects.remote).toEqual(initialUploadRemote);
  expect(response.effects.databaseOpens).toBe(0);
  expect(response.effects.unexpected).toEqual([]);
}

async function send(fields: readonly UploadField[], overrides: Record<string, string> = {}) {
  const { body, contentType } = await productionUploadBody(fields);
  return server.request({ url: `${origin}/api/cloud/upload`, method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': contentType, ...overrides }, body });
}

function expectRefusal(response: ProductionResponse, error: string) {
  expect(response.status).toBe(400);
  expect(response.headers['content-type']).toContain('application/json');
  expect(JSON.parse(response.text)).toEqual({ success: false, error });
  expectPrivate(response);
  expectNoEffects(response);
}

async function expectValidRetry(filename = unicodeFilename, overwrite: string | null = 'false') {
  const response = await send(uploadFields(filename, overwrite));
  expect(response.status).toBe(200);
  expect(response.text).toBe('File uploaded successfully');
  expectPrivate(response);
  expect(response.effects.writes).toEqual([{ path: `md-cards/${filename}`, source: inputSource, overwrite: overwrite === 'true' }]);
  expect(response.effects.remote).toEqual({ ...initialUploadRemote, [`md-cards/${filename}`]: inputSource });
  expect(response.effects.requests).toHaveLength(2);
  const legacyApi = `https://cloud-api.yandex.net/v1/disk/resources/upload?path=${encodeURIComponent(`md-cards/${filename}`)}&overwrite=${overwrite === 'true'}`;
  expect([legacyApi, adapterUploadUrl(legacyApi)].map(url => ({ method: 'GET', url })))
    .toContainEqual(response.effects.requests[0]);
}

describe('upload field and filename validation through the generated production entry', () => {
  it.each(['../outside.md', 'note%2fother.md'])('refuses unsafe filename %s and preserves a Unicode retry exactly', async filename => {
    expectRefusal(await send(uploadFields(filename)), 'CLOUD_INVALID_PATH');
    await expectValidRetry();
  });

  it('refuses File as path instead of sending its string coercion to the provider', async () => {
    expectRefusal(await send([['path', new Blob(['not a filename'])], ['content', inputSource]]), 'CLOUD_INVALID_PATH');
    await expectValidRetry('new.md', null);
  });

  it('refuses duplicate path values before the first destination can be overwritten', async () => {
    const fields: UploadField[] = [...uploadFields(existingFilename), ['path', newFilename]];
    expectRefusal(await send(fields), 'INVALID_UPLOAD_FIELDS');
    await expectValidRetry(existingFilename, 'true');
  });

  it('refuses duplicate content before the first value can select the Markdown error', async () => {
    const fields: UploadField[] = [...uploadFields(newFilename, 'false', '# legacy'), ['content', inputSource]];
    expectRefusal(await send(fields), 'INVALID_UPLOAD_FIELDS');
    await expectValidRetry();
  });

  it.each(['TRUE', new Blob(['true'])])('refuses non-contract overwrite=%j', async value => {
    expectRefusal(await send([...uploadFields(newFilename, null), ['overwrite', value]]), 'INVALID_UPLOAD_FIELDS');
    await expectValidRetry(newFilename, null);
  });

  it('refuses extra root/provider controls without touching either the original or a new remote file', async () => {
    const fields: UploadField[] = [...uploadFields(), ['root', 'outside'], ['provider', 'memory']];
    expectRefusal(await send(fields), 'INVALID_UPLOAD_FIELDS');
    await expectValidRetry(existingFilename, 'true');
  });

  it('returns private JSON for missing content and keeps a corrected request available', async () => {
    expectRefusal(await send([['path', newFilename]]), 'INVALID_UPLOAD_FIELDS');
    await expectValidRetry();
  });

  it('checks session and Origin before field validation, then refuses the authenticated same-origin unsafe path', async () => {
    const fields = uploadFields('../outside.md');
    const unauthenticated = await send(fields, { Cookie: '', Origin: 'https://foreign.example.invalid' });
    expect(unauthenticated.status).toBe(401);
    expect(JSON.parse(unauthenticated.text)).toEqual({ error: 'Not authenticated' });
    expect(unauthenticated.bodyUsed).toBe(false);
    expectPrivate(unauthenticated);
    expectNoEffects(unauthenticated);
    const foreign = await send(fields, { Origin: 'https://foreign.example.invalid' });
    expect(foreign.status).toBe(403);
    expect(JSON.parse(foreign.text)).toEqual({ error: 'Forbidden', code: 'CSRF_ORIGIN_DENIED' });
    expect(foreign.bodyUsed).toBe(false);
    expectPrivate(foreign);
    expectNoEffects(foreign);
    // The previously working guards above cannot by themselves make this case green.
    expectRefusal(await send(fields), 'CLOUD_INVALID_PATH');
    await expectValidRetry();
  });
});
