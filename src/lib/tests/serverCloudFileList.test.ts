import { yandexEnvironment, configuredCloudLocals } from './helpers/configuredCloud';
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { mockHttp } from './helpers/http';

const privateEnvironment = vi.hoisted(() => {
  const state: { values: Readonly<Record<string, string | undefined>> } = { values: {} };
  return state;
});
// Only the framework env and HTTP boundaries are substituted. The route,
// composition root, factory and Yandex adapter must work together.
vi.mock('$env/dynamic/private', () => ({ get env() { return privateEnvironment.values; } }));

const token = 'route-private-test-token';
const root = 'notes/Мои карточки';
const settings = { ...yandexEnvironment(token, root) };
let http: ReturnType<typeof mockHttp>;
let openDatabase: ReturnType<typeof vi.spyOn>;

function listUrl(offset = 0, folder = root): string {
  return 'https://cloud-api.yandex.net/v1/disk/resources'
    + `?path=${encodeURIComponent(`disk:/${folder}`)}&limit=100&offset=${offset}&sort=name`;
}

function resource(name: string, type = 'file', folder = root) {
  return {
    name, type, path: `disk:/${folder}/${name}`,
    file: 'https://downloader.disk.yandex.ru/private-test-download',
    modified: '2026-09-29T12:00:00Z', revision: 'provider-only-test-value'
  };
}

function page(items: unknown[], offset = 0, total = items.length, folder = root) {
  const path = `disk:/${folder}`;
  return { type: 'dir', path, _embedded: { path, items, limit: 100, offset, total } };
}

async function getFiles(query = ''): Promise<Response> {
  // Reload only in beforeEach; consecutive calls must exercise the same module.
  const { GET } = await import('../../routes/api/cloud/files/+server');
  const request = new Request(`https://app.example.invalid/api/cloud/files${query}`);
  const event = {
    request, url: new URL(request.url), params: {}, locals: configuredCloudLocals(privateEnvironment.values),
    getClientAddress: () => '127.0.0.1'
  } as unknown as RequestEvent;
  return GET({ ...event, params: {}, route: { id: '/api/cloud/files' } });
}

async function expectResponse(response: Response, status: number, body: unknown): Promise<void> {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual(status === 200 && Array.isArray(body) ? { _embedded: { items: body.map(name => ({
    name, path: name, modified: '2026-09-29T12:00:00.000Z'
  })) } } : body);
  expect(response.headers.get('Content-Type')).toContain('application/json');
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
}

function expectListRequest(offset = 0, folder = root, accessToken = token): void {
  expect(http.fetch).toHaveBeenCalledWith(listUrl(offset, folder), {
    method: 'GET', signal: expect.any(AbortSignal), redirect: 'error',
    headers: { Accept: 'application/json', Authorization: `OAuth ${accessToken}` }
  });
}

beforeEach(() => {
  vi.resetModules();
  privateEnvironment.values = { ...settings };
  vi.stubEnv('VITE_YANDEX_DISK_TOKEN', '');
  http = mockHttp();
  openDatabase = vi.spyOn(indexedDB, 'open');
});

afterEach(() => {
  http.assertHandled();
  expect(openDatabase).not.toHaveBeenCalled();
});

describe('GET /api/cloud/files: private server configuration and complete compatible metadata list', () => {
  it('lists exact filenames using only private env, without raw provider metadata or browser storage', async () => {
    http.on('GET', listUrl(), () => Response.json(page([
      resource('Заметка с пробелами.md'), resource('cafe\u0301.md')
    ])));

    await expectResponse(await getFiles(), 200, ['Заметка с пробелами.md', 'cafe\u0301.md']);
    expectListRequest();
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns empty items only after confirming an empty folder with the provider', async () => {
    http.on('GET', listUrl(), () => Response.json(page([])));

    const response = await getFiles();
    // [] by itself is not evidence that the cloud folder was actually read.
    expectListRequest();
    expect(http.fetch).toHaveBeenCalledTimes(1);
    await expectResponse(response, 200, []);
  });

  it('includes every page and excludes directories and non-Markdown resources', async () => {
    http.on('GET', listUrl(), () => Response.json(page([
      resource('first.md'), resource('folder.md', 'dir'), resource('readme.txt')
    ], 0, 5)));
    http.on('GET', listUrl(3), () => Response.json(page([
      resource('last.md'), resource('photo.png')
    ], 3, 5)));

    await expectResponse(await getFiles(), 200, ['first.md', 'last.md']);
    expectListRequest();
    expectListRequest(3);
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not let request query parameters choose the provider, credentials, root or URL', async () => {
    http.on('GET', listUrl(), () => Response.json(page([resource('trusted.md')])));
    const query = new URLSearchParams({
      provider: 'memory', token: 'request-test-token', rootPath: '../outside',
      path: 'disk:/outside', url: 'https://foreign.example.invalid/resources'
    });

    await expectResponse(await getFiles(`?${query}`), 200, ['trusted.md']);
    expectListRequest();
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it('reads current private configuration for each request without reusing another root or token', async () => {
    const secondRoot = 'other-notes';
    const secondToken = 'other-private-test-token';
    http.on('GET', listUrl(), () => Response.json(page([resource('first.md')])));
    http.on('GET', listUrl(0, secondRoot), () => Response.json(page([
      resource('second.md', 'file', secondRoot)
    ], 0, 1, secondRoot)));

    await expectResponse(await getFiles(), 200, ['first.md']);
    privateEnvironment.values = {
      ...settings, ...yandexEnvironment(secondToken, secondRoot)
    };
    await expectResponse(await getFiles(), 200, ['second.md']);
    expectListRequest();
    expectListRequest(0, secondRoot, secondToken);
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves an unknown modification time without synthesizing size, revision or provider fields', async () => {
    const { modified: _modified, ...unknownTime } = resource('unknown.md');
    http.on('GET', listUrl(), () => Response.json(page([
      resource('known.md'), { ...unknownTime, created: '2026-09-29T12:00:00Z', size: 999 }
    ])));

    await expectResponse(await getFiles(), 200, { _embedded: { items: [
      { name: 'known.md', path: 'known.md', modified: '2026-09-29T12:00:00.000Z' },
      { name: 'unknown.md', path: 'unknown.md' }
    ] } });
    expectListRequest();
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['epoch zero', '1970-01-01T00:00:00Z', '1970-01-01T00:00:00.000Z'],
    ['negative milliseconds', '1969-12-31T23:59:59.999Z', '1969-12-31T23:59:59.999Z'],
    ['timezone offset', '2026-09-29T15:00:00.123+03:00', '2026-09-29T12:00:00.123Z']
  ])('exposes %s as the existing ISO modified field without loss', async (_name, modified, expected) => {
    http.on('GET', listUrl(), () => Response.json(page([{ ...resource('note.md'), modified }])));
    await expectResponse(await getFiles(), 200, { _embedded: { items: [
      { name: 'note.md', path: 'note.md', modified: expected }
    ] } });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it('uses private configuration even when a working legacy singleton could return another folder', async () => {
    vi.stubEnv('VITE_YANDEX_DISK_TOKEN', 'legacy-public-test-token');
    http.on('GET', 'https://cloud-api.yandex.net/v1/disk/resources?path=md-cards',
      () => Response.json({ _embedded: { items: [resource('wrong-account.md')] }, secret: token }));
    http.on('GET', listUrl(), () => Response.json(page([resource('private-account.md')])));

    await expectResponse(await getFiles(), 200, ['private-account.md']);
    expectListRequest();
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/cloud/files: explicit unavailable results, never false empty success', () => {
  it.each([
    ['missing connections', { ...settings, CLOUD_STORAGES: undefined }],
    ['missing token', yandexEnvironment('', root)],
    ['missing root', yandexEnvironment(token, '')],
    ['unknown provider', yandexEnvironment(token, root, { provider: 'memory' })],
    ['unsafe root', yandexEnvironment(token, 'notes/../outside')]
  ])('reports %s as a configuration error before HTTP', async (_name, values) => {
    privateEnvironment.values = values;

    await expectResponse(await getFiles(), 503, { success: false, error: 'CLOUD_NOT_CONFIGURED' });
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('refuses missing private credentials even when the old public token could list files', async () => {
    privateEnvironment.values = yandexEnvironment('', root);
    vi.stubEnv('VITE_YANDEX_DISK_TOKEN', 'legacy-public-test-token');
    // Let the working legacy path succeed. RED must be a response assertion,
    // not an unexpected HTTP request or a retry timeout.
    http.on('GET', 'https://cloud-api.yandex.net/v1/disk/resources?path=md-cards',
      () => Response.json({ _embedded: { items: [] } }));

    await expectResponse(await getFiles(), 503, { success: false, error: 'CLOUD_NOT_CONFIGURED' });
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'CLOUD_AUTH_FAILED'], [403, 'CLOUD_AUTH_FAILED'],
    [404, 'CLOUD_REMOTE_ERROR'], [429, 'CLOUD_REMOTE_ERROR'],
    [503, 'CLOUD_REMOTE_ERROR'], [302, 'CLOUD_REMOTE_ERROR']
  ])('maps provider HTTP %i to a safe gateway error without automatic retries', async (status, error) => {
    http.on('GET', listUrl(), () => new Response(`Provider details: ${token}, ${root}`, {
      status, headers: { Location: 'https://foreign.example.invalid/redirect' }
    }));

    await expectResponse(await getFiles(), 502, { success: false, error });
    expectListRequest();
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it('reports a rejected fetch as unavailable without leaking its message or falling back to legacy', async () => {
    vi.stubEnv('VITE_YANDEX_DISK_TOKEN', 'legacy-public-test-token');
    http.on('GET', listUrl(), () => { throw new Error(`Network details: ${token}, ${root}`); });
    http.on('GET', 'https://cloud-api.yandex.net/v1/disk/resources?path=md-cards',
      () => Response.json({ _embedded: { items: [] } }));

    await expectResponse(await getFiles(), 503, { success: false, error: 'CLOUD_UNAVAILABLE' });
    expectListRequest();
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['invalid JSON', () => new Response(`not JSON: ${token}`)],
    ['invalid schema', () => Response.json({ _embedded: { items: [] }, token })]
  ])('reports %s as an invalid cloud response instead of an empty list', async (_name, respond) => {
    http.on('GET', listUrl(), respond);

    await expectResponse(await getFiles(), 502, { success: false, error: 'CLOUD_INVALID_RESPONSE' });
    expectListRequest();
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it('discards a partial list if a later page is unavailable', async () => {
    http.on('GET', listUrl(), () => Response.json(page([resource('partial.md')], 0, 2)));
    http.on('GET', listUrl(1), () => new Response(`Remote details: ${token}`, { status: 503 }));

    await expectResponse(await getFiles(), 502, { success: false, error: 'CLOUD_REMOTE_ERROR' });
    expectListRequest();
    expectListRequest(1);
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid date on a later page without leaking earlier entries or logging provider details', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    http.on('GET', listUrl(), () => Response.json(page([resource('partial.md')], 0, 2)));
    http.on('GET', listUrl(1), () => Response.json(page([
      { ...resource('invalid.md'), modified: '2026-02-30T00:00:00Z', secret: token }
    ], 1, 2)));

    await expectResponse(await getFiles(), 502, { success: false, error: 'CLOUD_INVALID_RESPONSE' });
    expect(http.fetch).toHaveBeenCalledTimes(2);
    expect(log).not.toHaveBeenCalled();
  });

  it('can load a fresh list on the next request after a network failure', async () => {
    http.on('GET', listUrl(), () => { throw new Error('Temporary test network failure'); });
    await expectResponse(await getFiles(), 503, { success: false, error: 'CLOUD_UNAVAILABLE' });
    expect(http.fetch).toHaveBeenCalledTimes(1);

    http.on('GET', listUrl(), () => Response.json(page([resource('recovered.md')])));
    await expectResponse(await getFiles(), 200, ['recovered.md']);
    expectListRequest();
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });
});
