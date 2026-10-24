// @vitest-environment node
import { productionStorageContext,productionFileRequests } from './helpers/productionHttp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createProductionHttp, readAuthCookie, type ProductionResponse } from './helpers/productionHttp';
import { initialInputRemote, inputCredentials, inputOrigin as origin, inputSource,
  loginBodyAtSize, loginBodyLimit, multipartBody, multipartType, uploadBodyAtSize,
  uploadBodyLimit, uploadFilename } from './helpers/requestBodyFixtures';

let server: Awaited<ReturnType<typeof createProductionHttp>>;
let cookie: string;

beforeAll(async () => {
  server = await createProductionHttp();
  const login = await server.request({ url: `${origin}/api/auth/login`, method: 'POST',
    headers: { 'X-Storage-Context': productionStorageContext, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(inputCredentials) });
  expect(login.status).toBe(200);
  cookie = readAuthCookie(login);
}, 90_000);
afterAll(async () => { await server?.close(); });
beforeEach(async () => { await server.reset(initialInputRemote); });
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

function expectNoEffects(response: ProductionResponse) {
  expect(response.cookies).toEqual([]);
  expect(response.effects.remote).toEqual(initialInputRemote);
  expect(response.effects.writes).toEqual([]);
  expect(productionFileRequests(response)).toEqual([]);
  expect(response.effects.unexpected).toEqual([]);
  expect(response.effects.databaseOpens).toBe(0);
}

function expectRefusal(endpoint: 'login' | 'upload', response: ProductionResponse, status: 400 | 413 | 415) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toContain('application/json');
  expect(response.headers.location).toBeUndefined();
  const message = status === 413 ? 'Request body is too large.'
    : status === 415 ? 'Unsupported request media type.' : 'Invalid login request.';
  const error = status === 413 ? 'REQUEST_BODY_TOO_LARGE'
    : status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'INVALID_REQUEST_BODY';
  expect(JSON.parse(response.text)).toEqual(endpoint === 'login' ? { message } : { success: false, error });
  expectPrivate(response);
  expectNoEffects(response);
}

async function validRetry(endpoint: 'login' | 'upload', atLimit = false) {
  if (endpoint === 'login') {
    const response = await server.request({ url: `${origin}/api/auth/login`, method: 'POST',
      headers: { 'X-Storage-Context': productionStorageContext, Origin: origin, 'Content-Type': 'Application/JSON; charset="UTF-8"' },
      body: atLimit ? loginBodyAtSize(loginBodyLimit) : JSON.stringify(inputCredentials) });
    expect(response.status).toBe(200);
    expectPrivate(response);
    const session = await server.request({ url: `${origin}/api/auth/status`, headers: { 'X-Storage-Context': productionStorageContext, Cookie: readAuthCookie(response) } });
    expect(JSON.parse(session.text)).toMatchObject({ authenticated: true });
    expect(productionFileRequests(session)).toEqual([]);
    expect(session.effects.writes).toEqual([]);
    return;
  }
  const payload = atLimit ? uploadBodyAtSize(uploadBodyLimit, '🗂') : { body: multipartBody(), source: inputSource };
  const response = await server.request({ url: `${origin}/api/cloud/upload`, method: 'POST',
    headers: { 'X-Storage-Context': productionStorageContext, Origin: origin, Cookie: cookie, 'Content-Type': multipartType }, body: payload.body });
  expect(response.status).toBe(200);
  expect(response.text).toBe('File uploaded successfully');
  expectPrivate(response);
  expect(response.effects.writes).toEqual([{ path: `md-cards/${uploadFilename}`, source: payload.source, overwrite: true }]);
  expect(response.effects.remote).toEqual({ ...initialInputRemote, [`md-cards/${uploadFilename}`]: payload.source });
  expect(productionFileRequests(response)).toHaveLength(2);
}

describe('bounded request parsing through the generated production entry', () => {
  it('refuses plain-text login JSON before cookies and permits a correctly typed retry', async () => {
    const response = await server.request({ url: `${origin}/api/auth/login`, method: 'POST',
      headers: { 'X-Storage-Context': productionStorageContext, Origin: origin, 'Content-Type': 'text/plain' }, body: JSON.stringify(inputCredentials) });
    expectRefusal('login', response, 415);
    expect(response.bodyUsed).toBe(false);
    await validRetry('login');
  });

  it('rejects JSON upload with a private 415 before reading the body or contacting the provider', async () => {
    const response = await server.request({ url: `${origin}/api/cloud/upload`, method: 'POST',
      headers: { 'X-Storage-Context': productionStorageContext, Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
    expectRefusal('upload', response, 415);
    expect(response.bodyUsed).toBe(false);
    await validRetry('upload');
  });

  it('refuses a urlencoded upload before any successful old transport write', async () => {
    const response = await server.request({ url: `${origin}/api/cloud/upload`, method: 'POST',
      headers: { 'X-Storage-Context': productionStorageContext, Origin: origin, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ path: uploadFilename, content: inputSource, overwrite: 'true' }).toString() });
    expectRefusal('upload', response, 415);
    expect(response.bodyUsed).toBe(false);
    await validRetry('upload');
  });

  it('maps malformed multipart to a generic private 400 without reflecting its input', async () => {
    const response = await server.request({ url: `${origin}/api/cloud/upload`, method: 'POST',
      headers: { 'X-Storage-Context': productionStorageContext, Origin: origin, Cookie: cookie, 'Content-Type': 'multipart/form-data' }, body: 'private-invalid-form' });
    expectRefusal('upload', response, 400);
    await validRetry('upload');
  });

  it.each(['login', 'upload'] as const)('bounds actual %s bytes even with an understated Content-Length', async endpoint => {
    const path = endpoint === 'login' ? '/api/auth/login' : '/api/cloud/upload';
    const type = endpoint === 'login' ? 'application/json' : multipartType;
    const body = endpoint === 'login' ? loginBodyAtSize(loginBodyLimit + 1) : uploadBodyAtSize(uploadBodyLimit + 1, '🗂').body;
    const response = await server.request({ url: `${origin}${path}`, method: 'POST',
      headers: { 'X-Storage-Context': productionStorageContext, Origin: origin, Cookie: cookie, 'Content-Type': type, 'Content-Length': '1' }, body });
    expectRefusal(endpoint, response, 413);
    await validRetry(endpoint, true);
  });

  it.each(['login', 'upload'] as const)('retains auth/Origin precedence over the %s body guard', async endpoint => {
    const path = endpoint === 'login' ? '/api/auth/login' : '/api/cloud/upload';
    const body = endpoint === 'login' ? loginBodyAtSize(loginBodyLimit + 1) : multipartBody();
    if (endpoint === 'upload') {
      const unauthenticated = await server.request({ url: `${origin}${path}`, method: 'POST',
        headers: { 'X-Storage-Context': productionStorageContext, Origin: 'https://foreign.example.invalid', 'Content-Type': 'text/plain' }, body });
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.bodyUsed).toBe(false);
      expectNoEffects(unauthenticated);
      expectPrivate(unauthenticated);
    }
    const foreign = await server.request({ url: `${origin}${path}`, method: 'POST',
      headers: { 'X-Storage-Context': productionStorageContext, Cookie: cookie, Origin: 'https://foreign.example.invalid', 'Content-Type': 'text/plain' }, body });
    expect(foreign.status).toBe(403);
    expect(JSON.parse(foreign.text)).toEqual({ error: 'Forbidden', code: 'CSRF_ORIGIN_DENIED' });
    expect(foreign.bodyUsed).toBe(false);
    expectNoEffects(foreign);
    expectPrivate(foreign);
    // The missing behavior is this last same-origin refusal, not the existing guards above.
    const sameOrigin = await server.request({ url: `${origin}${path}`, method: 'POST',
      headers: { 'X-Storage-Context': productionStorageContext, Cookie: cookie, Origin: origin, 'Content-Type': 'text/plain' }, body });
    expectRefusal(endpoint, sameOrigin, 415);
    expect(sameOrigin.bodyUsed).toBe(false);
    await validRetry(endpoint);
  });
});
