// @vitest-environment node
import { onCloudUpload } from './helpers/cloudUploadHttp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { runHandle } from './helpers/serverRequest';
import { mockHttp } from './helpers/http';
import { byteLength, inputCredentials, inputOrigin as origin, inputSource, loginBodyAtSize,
  loginBodyLimit, multipartBody, multipartType, uploadBodyAtSize, uploadBodyLimit,
  uploadFilename } from './helpers/requestBodyFixtures';

vi.mock('$env/dynamic/private', () => ({ env: { ADMIN_USERNAME: 'test-user', ADMIN_PASSWORD_HASH: '$2b$04$dOefitQKRsCSxLbUpW2PDOmCn802Xp74FT5jKLLIqfCTxWQZs1cV6', CLOUD_STORAGE_PROVIDER: 'yandex', YANDEX_DISK_TOKEN: 'test-only-token', YANDEX_DISK_BASE_PATH: 'md-cards', SESSION_SECRET: '99'.repeat(32) } }));
vi.mock('../utils/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

type Endpoint = 'login' | 'upload';
const paths = { login: '/api/auth/login', upload: '/api/cloud/upload' };
const types = { login: 'application/json', upload: multipartType };
const limits = { login: loginBodyLimit, upload: uploadBodyLimit };
let handle: typeof import('../../hooks.server')['handle'];
let sessions: typeof import('../server/session');
let handlers: Record<Endpoint, RequestHandler>;
let http: ReturnType<typeof mockHttp>;
let validateCredentials: ReturnType<typeof vi.spyOn>;
let parseMarkdown: ReturnType<typeof vi.spyOn>;
let openDatabase: ReturnType<typeof vi.spyOn>;
let remote: string;
let writes: { filename: string; source: string; overwrite: boolean }[];

function cookieJar(endpoint: Endpoint) {
  const values = new Map(endpoint === 'upload' ? [['auth_token', sessions.issueSession('test-user').token]] : []);
  return { values, get: vi.fn((name: string) => values.get(name)),
    set: vi.fn((name: string, value: string) => { values.set(name, value); }),
    delete: vi.fn((name: string) => { values.delete(name); }) };
}

function request(endpoint: Endpoint, body: BodyInit, headers: HeadersInit = {}) {
  const requestHeaders = new Headers({ Origin: origin, 'Content-Type': types[endpoint] });
  new Headers(headers).forEach((value, key) => requestHeaders.set(key, value));
  // Native Node Request requires duplex for a real streaming request body.
  const init: RequestInit & { duplex?: 'half' } = { method: 'POST', headers: requestHeaders, body, duplex: 'half' };
  return new Request(`${origin}${paths[endpoint]}`, init);
}

async function through(endpoint: Endpoint, input: Request, jar = cookieJar(endpoint)) {
  const event = { url: new URL(input.url), request: input, cookies: jar, locals: {}, params: {},
    route: { id: paths[endpoint] }, getClientAddress: () => '127.0.0.1' } as unknown as RequestEvent;
  const response = await runHandle(handle, { event, resolve: current => Promise.resolve(handlers[endpoint](current)) });
  return { response, jar };
}

function validBody(endpoint: Endpoint): string {
  return endpoint === 'login' ? JSON.stringify(inputCredentials) : multipartBody();
}

function bodyAtSize(endpoint: Endpoint, bytes: number): string {
  return endpoint === 'login' ? loginBodyAtSize(bytes) : uploadBodyAtSize(bytes).body;
}

async function expectRefusal(endpoint: Endpoint, result: Awaited<ReturnType<typeof through>>, status: 400 | 413 | 415) {
  const { response, jar } = result;
  expect(response.status).toBe(status);
  expect(response.headers.get('Content-Type')).toContain('application/json');
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('Location')).toBeNull();
  const message = status === 413 ? 'Request body is too large.'
    : status === 415 ? 'Unsupported request media type.' : 'Invalid login request.';
  const error = status === 413 ? 'REQUEST_BODY_TOO_LARGE'
    : status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'INVALID_REQUEST_BODY';
  expect(await response.json()).toEqual(endpoint === 'login' ? { message } : { success: false, error });
  expect(jar.set).not.toHaveBeenCalled();
  expect(jar.delete).not.toHaveBeenCalled();
  expect(validateCredentials).not.toHaveBeenCalled();
  expect(parseMarkdown).not.toHaveBeenCalled();
  expect(http.fetch).not.toHaveBeenCalled();
  expect(writes).toEqual([]);
  expect(remote).toBe('Original remote source');
}

async function expectValidRetry(endpoint: Endpoint, contentType = types[endpoint], body = validBody(endpoint), expectedSource = inputSource) {
  const { response, jar } = await through(endpoint, request(endpoint, body, { 'Content-Type': contentType }));
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  if (endpoint === 'login') {
    expect(await response.json()).toEqual({ message: 'Login successful', user: { username: inputCredentials.username } });
    expect(sessions.verifySession(jar.values.get('auth_token'))).toMatchObject({ username: inputCredentials.username });
    expect(validateCredentials).toHaveBeenCalledExactlyOnceWith(inputCredentials.username, inputCredentials.password);
    expect(http.fetch).not.toHaveBeenCalled();
  } else {
    expect(await response.text()).toBe('File uploaded successfully');
    expect(writes).toEqual([{ filename: uploadFilename, source: expectedSource, overwrite: true }]);
    expect(remote).toBe(expectedSource);
    expect(http.fetch).toHaveBeenCalledTimes(2);
  }
}

// A finite byte source with no speculative queue: distinguish cancellation from
// reading the complete body and checking its size afterwards. No timer failures.
function byteStream(chunks: Uint8Array[], rejectCancellation = false) {
  let next = 0;
  const cancel = vi.fn(() => {
    if (rejectCancellation) return Promise.reject(new Error('synthetic cancellation failure'));
  });
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (next < chunks.length) controller.enqueue(chunks[next++]);
    else controller.close();
  });
  return { body: new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }), pull, cancel };
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(1790769600000);
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('VITE_YANDEX_DISK_TOKEN', 'test-only-token');
  http = mockHttp();
  remote = 'Original remote source';
  writes = [];
  const api = 'https://cloud-api.yandex.net/v1/disk/resources/upload'
    + `?path=${encodeURIComponent(`md-cards/${uploadFilename}`)}&overwrite=true`;
  const href = 'https://upload.example.invalid/input-envelope';
  // Serve the old unsafe success explicitly; a missing fake must not cause RED.
  onCloudUpload(http, api, href, async init => {
    remote = await new Response(init?.body).text();
    writes.push({ filename: uploadFilename, source: remote, overwrite: true });
    return new Response(null, { status: 201 });
  });
  validateCredentials = vi.spyOn(await import('../server/auth'), 'validateCredentials');
  parseMarkdown = vi.spyOn(await import('../domain/markdown'), 'parseMarkdownDocument');
  sessions = await import('../server/session');
  handle = (await import('../../hooks.server')).handle;
  const upload = (await import('../../routes/api/cloud/upload/+server')).POST;
  handlers = { login: (await import('../../routes/api/auth/login/+server')).POST,
    upload: current => upload({ ...current, params: {}, route: { id: '/api/cloud/upload' } }) };
  openDatabase = vi.spyOn(indexedDB, 'open');
});
afterEach(() => {
  http.assertHandled();
  expect(openDatabase).not.toHaveBeenCalled();
});

describe('HTTP request media types before credential, Markdown or cloud work', () => {
  it.each([
    ['missing', null], ['plain text', 'text/plain'], ['form JSON disguise', 'application/x-www-form-urlencoded'],
    ['JSON suffix', 'application/problem+json'], ['lookalike', 'application/jsonp'],
    ['multiple types', 'application/json, text/plain'], ['unsupported charset', 'application/json; charset=iso-8859-1']
  ])('refuses login with %s Content-Type and permits a UTF-8 JSON retry', async (_name, type) => {
    const input = request('login', validBody('login'));
    if (type === null) input.headers.delete('Content-Type');
    else input.headers.set('Content-Type', type);
    await expectRefusal('login', await through('login', input), 415);
    expect(input.bodyUsed).toBe(false);
    await expectValidRetry('login', 'Application/JSON; charset="UTF-8"');
  });

  it.each([
    ['missing', null], ['JSON', 'application/json'], ['plain text', 'text/plain'],
    ['urlencoded', 'application/x-www-form-urlencoded'], ['mixed', 'multipart/mixed; boundary=example']
  ])('refuses upload with %s Content-Type before parsing and permits native FormData retry', async (_name, type) => {
    // URL-encoded form is currently accepted. Other media types currently become 500.
    const body = type === 'application/x-www-form-urlencoded'
      ? new URLSearchParams({ path: uploadFilename, content: inputSource, overwrite: 'true' }).toString()
      : validBody('upload');
    const input = request('upload', body);
    if (type === null) input.headers.delete('Content-Type');
    else input.headers.set('Content-Type', type);
    await expectRefusal('upload', await through('upload', input), 415);
    expect(input.bodyUsed).toBe(false);
    const form = new FormData();
    form.set('path', uploadFilename);
    form.set('content', inputSource);
    form.set('overwrite', 'true');
    const retry = new Request(`${origin}${paths.upload}`, { method: 'POST', headers: { Origin: origin }, body: form });
    const { response } = await through('upload', retry);
    expect(response.status).toBe(200);
    expect(writes).toEqual([{ filename: uploadFilename, source: inputSource, overwrite: true }]);
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['login', 'upload'] as const)('refuses a compressed %s declaration and permits identity', async endpoint => {
    const input = request(endpoint, validBody(endpoint), { 'Content-Encoding': 'gzip' });
    await expectRefusal(endpoint, await through(endpoint, input), 415);
    expect(input.bodyUsed).toBe(false);
    const { response } = await through(endpoint, request(endpoint, validBody(endpoint), { 'Content-Encoding': 'identity' }));
    expect(response.status).toBe(200);
  });
});

describe.each(['login', 'upload'] as const)('%s body limits apply to bytes of the complete HTTP body', endpoint => {
  it('rejects a declared oversized body before consuming it, even if the supplied bytes are short', async () => {
    const input = request(endpoint, validBody(endpoint), { 'Content-Length': String(limits[endpoint] + 1) });
    await expectRefusal(endpoint, await through(endpoint, input), 413);
    expect(input.bodyUsed).toBe(false);
    await expectValidRetry(endpoint);
  });

  it.each(['no length', 'understated length', 'single large chunk', 'failed cancellation'])
    ('stops on overflow with %s and accepts the exact byte limit on retry', async kind => {
      const bytes = new TextEncoder().encode(bodyAtSize(endpoint, limits[endpoint] + 1));
      const singleChunk = kind === 'single large chunk';
      const stream = byteStream([
        ...(singleChunk ? [bytes] : [bytes.subarray(0, limits[endpoint]), bytes.subarray(limits[endpoint])]),
        new TextEncoder().encode(' '.repeat(4096))
      ], kind === 'failed cancellation');
      const input = request(endpoint, stream.body, kind === 'understated length' ? { 'Content-Length': '1' } : {});
      await expectRefusal(endpoint, await through(endpoint, input), 413);
      expect(stream.pull).toHaveBeenCalledTimes(singleChunk ? 1 : 2);
      expect(stream.cancel).toHaveBeenCalledTimes(1);
      const atLimit = bodyAtSize(endpoint, limits[endpoint]);
      expect(byteLength(atLimit)).toBe(limits[endpoint]);
      await expectValidRetry(endpoint, types[endpoint], atLimit,
        endpoint === 'upload' ? uploadBodyAtSize(limits[endpoint]).source : inputSource);
    });

  it('counts UTF-8 bytes rather than string length and keeps valid chunked bodies readable', async () => {
    const tooLarge = endpoint === 'upload' ? uploadBodyAtSize(limits[endpoint] + 1, '🗂').body
      : JSON.stringify({ ...inputCredentials, password: '🗂'.repeat(loginBodyLimit / 4) });
    expect(tooLarge.length).toBeLessThan(limits[endpoint]);
    expect(byteLength(tooLarge)).toBeGreaterThan(limits[endpoint]);
    await expectRefusal(endpoint, await through(endpoint, request(endpoint, tooLarge)), 413);

    // Upload retry splits a real multibyte sequence and reaches the exact limit;
    // login retry splits ordinary credentials without changing their value.
    const accepted = endpoint === 'upload' ? uploadBodyAtSize(uploadBodyLimit, '🗂')
      : { body: JSON.stringify({ ...inputCredentials, rememberMe: false }), source: inputSource };
    const bytes = new TextEncoder().encode(accepted.body);
    const index = bytes.findIndex(value => value >= 0x80);
    const split = index < 0 ? 7 : index + 1;
    const stream = byteStream([bytes.subarray(0, split), bytes.subarray(split)]);
    const { response, jar } = await through(endpoint, request(endpoint, stream.body));
    expect(response.status).toBe(200);
    expect(stream.cancel).not.toHaveBeenCalled();
    if (endpoint === 'upload') expect(writes).toEqual([{ filename: uploadFilename, source: accepted.source, overwrite: true }]);
    else expect(sessions.verifySession(jar.values.get('auth_token'))).toMatchObject({ username: inputCredentials.username });
  });
});

describe('malformed multipart is a safe client refusal, not a reflected server error', () => {
  it.each([
    ['missing boundary', 'multipart/form-data', 'private-content'],
    ['wrong boundary', 'multipart/form-data; boundary=wrong', multipartBody()],
    ['truncated body', multipartType, multipartBody().slice(0, -45)]
  ])('returns 400 for %s and keeps the subsequent upload available', async (_name, type, body) => {
    await expectRefusal('upload', await through('upload', request('upload', body, { 'Content-Type': type })), 400);
    await expectValidRetry('upload');
  });

  it('returns a generic 400 on a request stream failure without exposing its message', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.error(new Error('private-stream-error-with-credentials'));
    } });
    await expectRefusal('upload', await through('upload', request('upload', body)), 400);
    await expectValidRetry('upload');
  });
});
