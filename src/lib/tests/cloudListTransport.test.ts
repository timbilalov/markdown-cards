import { historicalStorage } from './helpers/historicalStorage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHttp } from './helpers/http';
import { setLegacyClientToken, setLegacyClientBasePath } from './helpers/legacyClientConfiguration';

const apiUrl = '/api/cloud/files';
const legacyUrl = 'https://cloud-api.yandex.net/v1/disk/resources?path=md-cards';
const known = { name: 'Заметка & планы.md', path: 'Заметка & планы.md', modified: '1970-01-01T00:00:00.000Z' };
const unknown = { name: 'renamed.md.note.md', path: 'renamed.md.note.md' };
let http: ReturnType<typeof mockHttp>;
let db: typeof import('../services/dbService')['dbService'];
let service: typeof import('../services/cloudService')['cloudService'];
let errors: typeof import('../services/cloudService');

function expectApiRequest() {
  expect(http.fetch.mock.calls).toEqual([[apiUrl, { method: 'GET', signal: expect.any(AbortSignal) }]]);
}

async function outcome(): Promise<unknown> {
  return service.listFiles().catch(error => error);
}

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('VITE_YANDEX_DISK_TOKEN', '');
  http = mockHttp();
  db = (await import('../services/dbService')).dbService;
  errors = await import('../services/cloudService');
  service = errors.cloudService;
  setLegacyClientToken(service, 'legacy-test-token');
  // The old transport may complete successfully. Failures must expose the
  // wrong behavior, not missing mocks, retries or a provider/setup exception.
  http.on('GET', legacyUrl, () => Response.json({ _embedded: { items: [] } }));
});
afterEach(() => http.assertHandled());

describe('cloudService.listFiles: same-origin browser transport', () => {
  it.each([null, 'legacy-test-token'])('reads validated metadata without persistent listing copies with browser token %j', async token => {
    setLegacyClientToken(service, token);
    const body = { _embedded: { items: [known, unknown] } };
    http.on('GET', apiUrl, () => Response.json(body));

    const result = await outcome();

    expectApiRequest();
    expect(result).toEqual(body);
    expect(await historicalStorage.getAllCloudFiles()).toEqual([]);
    expect(await db.getAllCards()).toEqual([]);
    expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
  });

  it('does not let a browser base path select the server folder or add query credentials', async () => {
    setLegacyClientBasePath(service, 'browser-selected-folder');
    http.on('GET', legacyUrl.replace('md-cards', 'browser-selected-folder'),
      () => Response.json({ _embedded: { items: [] } }));
    http.on('GET', apiUrl, () => Response.json({ _embedded: { items: [known] } }));

    const result = await outcome();

    expectApiRequest();
    expect(result).toEqual({ _embedded: { items: [known] } });
  });

  it('accepts a confirmed empty list without deleting previous cached metadata', async () => {
    await historicalStorage.saveCloudFile(known);
    http.on('GET', apiUrl, () => Response.json({ _embedded: { items: [] } }));

    const result = await outcome();

    expectApiRequest();
    expect(result).toEqual({ _embedded: { items: [] } });
    expect(await historicalStorage.getCloudFile(known.path)).toEqual(known);
  });

  it('projects allowed fields before caching or returning an otherwise valid response', async () => {
    http.on('GET', apiUrl, () => Response.json({ token: 'response-only-secret', path: 'disk:/private',
      _embedded: { total: 1, items: [{ ...known, size: 42, revision: 'unverified',
        file: 'https://foreign.example.invalid/source', preview: 'https://foreign.example.invalid/preview' }] } }));

    const result = await outcome();

    expectApiRequest();
    expect(result).toEqual({ _embedded: { items: [{...known,revision:'unverified'}] } });
    expect(await historicalStorage.getAllCloudFiles()).toEqual([]);
  });

  it('reads fresh metadata on each call instead of retaining a prior list', async () => {
    setLegacyClientToken(service, null);
    http.on('GET', apiUrl, () => Response.json({ _embedded: { items: [known] } }));
    const first = await outcome();
    http.on('GET', apiUrl, () => Response.json({ _embedded: { items: [unknown] } }));
    const second = await outcome();

    expect([first, second]).toEqual([
      { _embedded: { items: [known] } }, { _embedded: { items: [unknown] } }
    ]);
    expect(http.fetch.mock.calls).toEqual([[apiUrl, { method: 'GET', signal: expect.any(AbortSignal) }], [apiUrl, { method: 'GET', signal: expect.any(AbortSignal) }]]);
  });
});

describe('cloudService.listFiles: explicit errors, no retries or false empty success', () => {
  it.each([
    [401, 'AUTH_FAILED'], [403, 'AUTH_FAILED'], [404, 'HTTP_404'],
    [502, 'HTTP_502'], [503, 'HTTP_503']
  ])('rejects API HTTP %i with %s and keeps metadata untouched', async (status, code) => {
    await historicalStorage.saveCloudFile(known);
    http.on('GET', apiUrl, () => new Response('response-only-secret', { status }));

    const result = await outcome();

    expectApiRequest();
    expect(result).toBeInstanceOf(errors.CloudError);
    expect(result).toMatchObject({ code });
    expect(String(result)).not.toContain('response-only-secret');
    expect(await historicalStorage.getAllCloudFiles()).toEqual([known]);
  });

  it('reports network failure without forwarding its details and can recover on the next call', async () => {
    http.on('GET', apiUrl, () => { throw new TypeError('network-only-secret'); });
    const result = await outcome();

    expectApiRequest();
    expect(result).toBeInstanceOf(errors.CloudNetworkError);
    expect(String(result)).not.toContain('network-only-secret');
    http.on('GET', apiUrl, () => Response.json({ _embedded: { items: [unknown] } }));
    expect(await outcome()).toEqual({ _embedded: { items: [unknown] } });
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects a 200 HTML login/error body as an invalid response', async () => {
    http.on('GET', apiUrl, () => new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }));
    const result = await outcome();

    expectApiRequest();
    expect(result).toBeInstanceOf(errors.CloudError);
    expect(result).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(await historicalStorage.getAllCloudFiles()).toEqual([]);
  });

  it.each([
    { name: 'null body', body: null },
    { name: 'array body', body: [] },
    { name: 'missing collection', body: {} },
    { name: 'non-array items', body: { _embedded: { items: {} } } },
    ...[
      { name: 'null entry', entry: null },
      { name: 'missing name', entry: { path: 'other.md' } },
      { name: 'path/name mismatch', entry: { name: 'other.md', path: 'disk:/private/other.md' } },
      { name: 'traversal', entry: { name: '../other.md', path: '../other.md' } },
      { name: 'encoded segment', entry: { name: '%2e%2e.md', path: '%2e%2e.md' } },
      { name: 'control character', entry: { name: 'bad\u0000.md', path: 'bad\u0000.md' } },
      { name: 'non-Markdown file', entry: { name: 'other.txt', path: 'other.txt' } },
      { name: 'empty Markdown basename', entry: { name: '.md', path: '.md' } },
      { name: 'dot route basename', entry: { name: '..md', path: '..md' } },
      { name: 'parent route basename', entry: { name: '...md', path: '...md' } },
      { name: 'duplicate filename', entry: known },
      { name: 'null date', entry: { ...unknown, modified: null } },
      { name: 'numeric date', entry: { ...unknown, modified: 0 } },
      { name: 'invalid date', entry: { ...unknown, modified: '2026-02-30T00:00:00.000Z' } },
      { name: 'noncanonical date', entry: { ...unknown, modified: '2026-09-29' } }
    ].map(({ name, entry }) => ({ name, body: { _embedded: { items: [known, entry] } } }))
  ])('rejects $name before any partial metadata write', async ({ body }) => {
    await historicalStorage.saveCloudFile(unknown);
    const write = vi.spyOn(historicalStorage, 'saveCloudFile');
    http.on('GET', apiUrl, () => Response.json(body));

    const result = await outcome();

    expectApiRequest();
    expect(result).toBeInstanceOf(errors.CloudError);
    expect(result).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(write).not.toHaveBeenCalled();
    expect(await historicalStorage.getAllCloudFiles()).toEqual([unknown]);
  });
});
