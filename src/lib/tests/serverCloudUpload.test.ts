import { yandexEnvironment, configuredCloudLocals } from './helpers/configuredCloud';
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHttp } from './helpers/http';
import { inputSource } from './helpers/requestBodyFixtures';

const environment = vi.hoisted(() => ({ values: {} as Record<string, string | undefined> }));
vi.mock('$env/dynamic/private', () => ({ get env() { return environment.values; } }));
const token = 'private-upload-test-token';
const root = 'notes/Мои карточки';
const filename = 'Заметка #1 & планы?.md';
const href = 'https://uploader1d.dst.yandex.net/upload-target/test?signature=test-only';
const settings = { ...yandexEnvironment(token, root) };
let http: ReturnType<typeof mockHttp>;
let openDatabase: ReturnType<typeof vi.spyOn>;

function apiUrl(overwrite = true, folder = root) {
  return `https://cloud-api.yandex.net/v1/disk/resources/upload?path=${encodeURIComponent(`disk:/${folder}/${filename}`)}&overwrite=${overwrite}`;
}
function serve(overwrite = true, status = 201, folder = root) {
  http.on('GET', apiUrl(overwrite, folder), () => Response.json({ href, method: 'PUT', templated: false }));
  http.on('PUT', href, () => new Response(null, { status }));
}
async function send(overwrite: string | null = 'true', source = inputSource, path = filename) {
  const form = new FormData();
  form.set('path', path);
  form.set('content', source);
  if (overwrite !== null) form.set('overwrite', overwrite);
  const request = new Request('https://app.example.invalid/api/cloud/upload', { method: 'POST', body: form });
  const { POST } = await import('../../routes/api/cloud/upload/+server');
  return POST({ request, url: new URL(request.url), params: {}, locals: configuredCloudLocals(environment.values), route: { id: '/api/cloud/upload' } } as unknown as Parameters<typeof POST>[0]);
}
async function expectError(response: Response, status: number, error: string, outcome?: 'not-written' | 'unknown') {
  expect(response.status).toBe(status);
  expect(response.headers.get('Content-Type')).toContain('application/json');
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ success: false, error, ...(outcome ? { outcome } : {}) });
}
beforeEach(() => {
  vi.resetModules();
  environment.values = { ...settings };
  vi.stubEnv('VITE_YANDEX_DISK_TOKEN', '');
  http = mockHttp();
  openDatabase = vi.spyOn(indexedDB, 'open');
});
afterEach(() => { http.assertHandled(); expect(openDatabase).not.toHaveBeenCalled(); });

describe('POST /api/cloud/upload through private composition and the real adapter', () => {
  it.each(['true', 'false', null])('maps overwrite=%j to ordinary/create-only write with exact bytes and no public token', async overwrite => {
    serve(overwrite === 'true');
    const response = await send(overwrite);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('File uploaded successfully');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(http.fetch.mock.calls).toEqual([
      [apiUrl(overwrite === 'true'), { method: 'GET', signal: expect.any(AbortSignal), redirect: 'error', headers: { Accept: 'application/json', Authorization: `OAuth ${token}` } }],
      [href, { method: 'PUT', signal: expect.any(AbortSignal), redirect: 'error', headers: { 'Content-Type': 'application/octet-stream' }, body: new TextEncoder().encode(inputSource) }]
    ]);
  });

  it('reads private configuration on each request', async () => {
    serve();
    expect((await send()).status).toBe(200);
    environment.values = { ...settings, ...yandexEnvironment('next-private-test-token', 'next-root') };
    serve(true, 201, 'next-root');
    expect((await send()).status).toBe(200);
    expect(http.fetch.mock.calls[2]).toEqual([apiUrl(true, 'next-root'), {
      method: 'GET', signal: expect.any(AbortSignal), redirect: 'error', headers: { Accept: 'application/json', Authorization: 'OAuth next-private-test-token' }
    }]);
    expect(http.fetch).toHaveBeenCalledTimes(4);
  });

  it.each(['CLOUD_STORAGES', 'CLOUD_STORAGE_ACTIVE'])('refuses missing %s despite a configured legacy token', async key => {
    environment.values = { ...settings, [key]: undefined };
    vi.stubEnv('VITE_YANDEX_DISK_TOKEN', 'legacy-upload-test-token');
    // Let legacy upload succeed so RED exposes the actual configuration bypass.
    const oldUrl = `https://cloud-api.yandex.net/v1/disk/resources/upload?path=${encodeURIComponent(`md-cards/${filename}`)}&overwrite=true`;
    http.on('GET', oldUrl, () => Response.json({ href, method: 'PUT', templated: false }));
    http.on('PUT', href, () => new Response(null, { status: 201 }));
    await expectError(await send(), 503, 'CLOUD_NOT_CONFIGURED', 'not-written');
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it.each([['provider', yandexEnvironment(token, root, { provider: 'unknown' })], ['root', yandexEnvironment(token, '../outside')]] as const)('safely rejects invalid %s configuration', async (_name, change) => {
    environment.values = { ...settings, ...change };
    await expectError(await send(), 503, 'CLOUD_NOT_CONFIGURED', 'not-written');
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 429, 500])('maps link HTTP %i without response details or retries', async status => {
    http.on('GET', apiUrl(), () => new Response(`private diagnostics ${token} ${root}`, { status }));
    await expectError(await send(), 502, status === 401 || status === 403 ? 'CLOUD_AUTH_FAILED' : 'CLOUD_REMOTE_ERROR', 'not-written');
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it('reports a pre-upload network failure as not-written and allows a later request', async () => {
    http.on('GET', apiUrl(), () => { throw new Error(`secret ${token}`); });
    await expectError(await send(), 503, 'CLOUD_UNAVAILABLE', 'not-written');
    expect(http.fetch).toHaveBeenCalledTimes(1);
    serve();
    expect((await send()).status).toBe(200);
    expect(http.fetch).toHaveBeenCalledTimes(3);
  });

  it.each(['json', 'schema', 'foreign URL'])('rejects %s from the upload-link endpoint before sending content', async kind => {
    http.on('GET', apiUrl(), () => kind === 'json' ? new Response('{') : Response.json({
      href: kind === 'foreign URL' ? 'https://attacker.invalid/upload' : href,
      method: kind === 'schema' ? 'GET' : 'PUT', templated: false
    }));
    await expectError(await send(), 502, 'CLOUD_INVALID_RESPONSE', 'not-written');
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['link', 'PUT'])('reports a provider conflict at %s without retrying or overwriting again', async phase => {
    serve(false, 409);
    if (phase === 'link') http.on('GET', apiUrl(false), () => new Response(null, { status: 409 }));
    await expectError(await send('false'), 409, 'CLOUD_CONFLICT');
    expect(http.fetch).toHaveBeenCalledTimes(phase === 'link' ? 1 : 2);
  });

  it.each([200, 202, 204, 302, 401, 404, 412, 500])('never acknowledges uncertain PUT HTTP %i as saved', async status => {
    serve(true, status);
    await expectError(await send(), 503, 'CLOUD_WRITE_UNKNOWN', 'unknown');
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it('reports a lost response after the write as unknown without repeating PUT', async () => {
    let remote = 'previous';
    serve();
    http.on('PUT', href, init => {
      remote = new TextDecoder().decode(init?.body as Uint8Array);
      throw new Error(`secret lost response ${token}`);
    });
    await expectError(await send(), 503, 'CLOUD_WRITE_UNKNOWN', 'unknown');
    expect(remote).toBe(inputSource);
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['filename', '../outside.md', inputSource, 'true', 400, 'CLOUD_INVALID_PATH'],
    ['flag', filename, inputSource, 'TRUE', 400, 'INVALID_UPLOAD_FIELDS'],
    ['empty source', filename, '', 'true', 400, 'INVALID_MARKDOWN_CONTENT']
  ] as const)('validates %s before missing configuration', async (_name, path, source, overwrite, status, error) => {
    environment.values = {};
    await expectError(await send(overwrite, source, path), status, error);
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('rejects legacy format with private JSON even when storage configuration is missing', async () => {
    environment.values = {};
    const response = await send('true', '# Legacy');
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ success: false, error: 'MARKDOWN_UNSUPPORTED', reason: 'missing-version' });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(http.fetch).not.toHaveBeenCalled();
  });
});
