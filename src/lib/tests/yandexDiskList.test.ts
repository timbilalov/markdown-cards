// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { YandexDiskAdapter } from '../server/cloud/yandexDiskAdapter';
import type { YandexDiskAdapterOptions } from '../server/cloud/yandexDiskAdapter';
import { mockHttp } from './helpers/http';

const token = 'test-only-disk-token';
const root = 'md-cards';
const base = 'https://cloud-api.yandex.net/v1/disk/resources';
let http: ReturnType<typeof mockHttp>;

function adapter(options: Partial<YandexDiskAdapterOptions> = {}) {
  return new YandexDiskAdapter({ accessToken: token, rootPath: root, pageSize: 2, ...options });
}

function url(offset = 0, rootPath = root, limit = 2): string {
  return `${base}?path=${encodeURIComponent(`disk:/${rootPath}`)}&limit=${limit}&offset=${offset}&sort=name`;
}

function resource(name: string, type = 'file', rootPath = root) {
  return { name, type, path: `disk:/${rootPath}/${name}` };
}

function page(items: unknown[], offset = 0, total: number | undefined = items.length, rootPath = root) {
  return {
    path: `disk:/${rootPath}`, type: 'dir',
    _embedded: { path: `disk:/${rootPath}`, items, offset, limit: 2, ...(total === undefined ? {} : { total }) }
  };
}

beforeEach(() => { http = mockHttp(); });
afterEach(() => http.assertHandled());

describe('YandexDiskAdapter: complete provider-neutral listing', () => {
  it.each(['.md', '..md', '...md'])('filters a filename without a usable route basename: %s', async name => {
    http.on('GET', url(), () => Response.json(page([resource(name), resource('valid.md')])));
    expect(await adapter().list()).toEqual({ status: 'success', entries: [{ path: 'valid.md', revision: null }] });
  });

  it('finishes 100 pages with 10,000 files within the operation budget at 100ms per page', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    for (let offset = 0; offset < 10_000; offset += 100) {
      http.on('GET', url(offset, root, 100), async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        const response = page(Array.from({ length: 100 }, (_, index) => resource(`note-${offset + index}.md`)), offset, 10_000);
        response._embedded.limit = 100;
        return Response.json(response);
      });
    }
    const reading = adapter({ pageSize: 100 }).list();
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await reading;
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('Expected complete listing');
    expect(result.entries).toHaveLength(10_000);
    expect(http.fetch).toHaveBeenCalledTimes(100);
  });

  it('returns an empty success only after a valid response confirms an empty folder', async () => {
    http.on('GET', url(), () => Response.json(page([])));
    expect(await adapter().list()).toEqual({ status: 'success', entries: [] });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it('walks every page and advances offsets by all resources, including filtered entries', async () => {
    http.on('GET', url(), () => Response.json(page([resource('folder.md', 'dir'), resource('readme.txt')], 0, 5)));
    http.on('GET', url(2), () => Response.json(page([resource('a.md'), resource('b.md')], 2, 5)));
    http.on('GET', url(4), () => Response.json(page([resource('c.md')], 4, 5)));
    expect(await adapter().list()).toEqual({ status: 'success', entries: [
      { path: 'a.md', revision: null }, { path: 'b.md', revision: null }, { path: 'c.md', revision: null }
    ] });
    expect(http.fetch.mock.calls.map(([input]) => String(input))).toEqual([url(), url(2), url(4)]);
  });

  it('supports an omitted total and stops at the final short page', async () => {
    const first = page([resource('a.md'), resource('b.md')]);
    const last = page([resource('c.md')], 2);
    delete first._embedded.total;
    delete last._embedded.total;
    http.on('GET', url(), () => Response.json(first));
    http.on('GET', url(2), () => Response.json(last));
    expect(await adapter().list()).toEqual({ status: 'success', entries: [
      { path: 'a.md', revision: null }, { path: 'b.md', revision: null }, { path: 'c.md', revision: null }
    ] });
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not truncate a short page when total says more resources remain', async () => {
    http.on('GET', url(), () => Response.json(page([resource('a.md')], 0, 2)));
    http.on('GET', url(1), () => Response.json(page([resource('b.md')], 1, 2)));
    expect(await adapter().list()).toEqual({ status: 'success', entries: [
      { path: 'a.md', revision: null }, { path: 'b.md', revision: null }
    ] });
    expect(http.fetch.mock.calls.map(([input]) => String(input))).toEqual([url(), url(1)]);
  });

  it('encodes a configured nested Unicode root and returns the exact filename', async () => {
    const rootPath = 'notes/Мои карточки';
    const name = 'Заметка & планы.md';
    http.on('GET', url(0, rootPath), () => Response.json(page([resource(name, 'file', rootPath)], 0, 1, rootPath)));
    expect(await adapter({ rootPath }).list()).toEqual({
      status: 'success', entries: [{ path: name, revision: null }]
    });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it('uses a bounded default page size when configuration omits it', async () => {
    http.on('GET', url(0, root, 100), () => Response.json({ ...page([]),
      _embedded: { ...page([])._embedded, limit: 100 }
    }));
    expect(await new YandexDiskAdapter({ accessToken: token, rootPath: root }).list())
      .toEqual({ status: 'success', entries: [] });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('YandexDiskAdapter: configuration is rejected before HTTP', () => {
  it.each(['', ' \t', 'bad\r\nheader'])('rejects invalid token %j without exposing it', accessToken => {
    expect(() => adapter({ accessToken })).toThrow(/^Invalid Yandex Disk configuration$/);
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it.each(['', '/md-cards', '../outside', 'notes/../private', 'notes//cards', 'notes\\cards',
    'https://example.invalid', 'notes/%2e%2e', 'notes/\u0000cards'])('rejects invalid root %j', rootPath => {
    expect(() => adapter({ rootPath })).toThrow(/^Invalid Yandex Disk configuration$/);
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it.each([0, 1.5, 101, NaN])('rejects invalid page size %j', pageSize => {
    expect(() => adapter({ pageSize })).toThrow(/^Invalid Yandex Disk configuration$/);
    expect(http.fetch).not.toHaveBeenCalled();
  });
});

describe('YandexDiskAdapter: listing failures never become an empty or partial success', () => {
  it.each([
    [401, 'auth'], [403, 'auth'], [404, 'remote'], [429, 'remote'], [503, 'remote']
  ] as const)('maps HTTP %i to %s', async (status, reason) => {
    http.on('GET', url(), () => new Response('provider-specific detail', { status }));
    expect(await adapter().list()).toEqual({ status: 'unavailable', reason });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it('reports a network rejection without swallowing it as missing storage', async () => {
    http.on('GET', url(), () => { throw new TypeError('test network failure'); });
    expect(await adapter().list()).toEqual({ status: 'unavailable', reason: 'network' });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid JSON as invalid-response', async () => {
    http.on('GET', url(), () => new Response('{', { headers: { 'Content-Type': 'application/json' } }));
    expect(await adapter().list()).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'null', body: null },
    { name: 'file instead of folder', body: { ...page([]), type: 'file' } },
    { name: 'missing embedded collection', body: { path: 'disk:/md-cards', type: 'dir' } },
    { name: 'non-array items', body: { ...page([]), _embedded: { ...page([])._embedded, items: {} } } },
    { name: 'another root', body: { ...page([]), path: 'disk:/private' } },
    { name: 'another embedded root', body: { ...page([]), _embedded: { ...page([])._embedded, path: 'disk:/private' } } },
    { name: 'wrong offset', body: page([], 1, 0) },
    { name: 'zero limit', body: { ...page([]), _embedded: { ...page([])._embedded, limit: 0 } } },
    { name: 'negative total', body: page([], 0, -1) },
    { name: 'total smaller than returned items', body: page([resource('a.md')], 0, 0) },
    { name: 'path/name mismatch', body: page([{ ...resource('a.md'), path: 'disk:/private/a.md' }]) },
    { name: 'unknown resource type', body: page([resource('a.md', 'link')]) },
    { name: 'nested filename', body: page([resource('../outside.md')]) },
    { name: 'duplicate paths', body: page([resource('a.md'), resource('a.md')]) }
  ])('rejects malformed metadata: $name', async ({ body }) => {
    http.on('GET', url(), () => Response.json(body));
    expect(await adapter().list()).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['auth', 'network'] as const)('discards earlier pages when the next page fails with %s', async reason => {
    http.on('GET', url(), () => Response.json(page([resource('a.md'), resource('b.md')], 0, 3)));
    http.on('GET', url(2), () => {
      if (reason === 'network') throw new TypeError('test network failure');
      return new Response('not authorized', { status: 401 });
    });
    expect(await adapter().list()).toEqual({ status: 'unavailable', reason });
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: 'changed total', body: page([resource('c.md')], 2, 4) },
    { name: 'premature empty page', body: page([], 2, 3) },
    { name: 'repeated entry from an earlier page', body: page([resource('a.md')], 2, 3) }
  ])('discards earlier pages on inconsistent pagination: $name', async ({ body }) => {
    http.on('GET', url(), () => Response.json(page([resource('a.md'), resource('b.md')], 0, 3)));
    http.on('GET', url(2), () => Response.json(body));
    expect(await adapter().list()).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it('refuses an API redirect without sending OAuth to its target', async () => {
    const foreignUrl = 'https://example.invalid/collect';
    http.on('GET', url(), () => new Response(null, { status: 302, headers: { Location: foreignUrl } }));
    http.on('GET', foreignUrl, () => Response.json(page([])));
    expect(await adapter().list()).toEqual({ status: 'unavailable', reason: 'remote' });
    expect(http.fetch).toHaveBeenCalledTimes(1);
    expect(http.fetch.mock.calls[0][1]?.redirect).toBe('error');
  });
});
