// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CloudListResult } from '../ports/cloudStorage';
import { YandexDiskAdapter } from '../server/cloud/yandexDiskAdapter';
import { mockHttp } from './helpers/http';

const token = 'test-only-disk-token';
const root = 'disk:/md-cards';
let http: ReturnType<typeof mockHttp>;

function adapter() {
  return new YandexDiskAdapter({ accessToken: token, rootPath: 'md-cards', pageSize: 2 });
}

function url(offset = 0): string {
  return `https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent(root)}&limit=2&offset=${offset}&sort=name`;
}

function resource(name: string, metadata: Record<string, unknown> = {}) {
  return { name, type: 'file', path: `${root}/${name}`, ...metadata };
}

function page(items: unknown[], offset = 0, total = items.length) {
  return { path: root, type: 'dir', _embedded: { path: root, items, offset, limit: 2, total } };
}

beforeEach(() => { http = mockHttp(); });
afterEach(() => http.assertHandled());

describe('YandexDiskAdapter: provider-neutral listing modification hint', () => {
  // Moved from yandexDiskList.test.ts: the new contract preserves the hint,
  // while provider URLs, opaque metadata and unverified revisions stay private.
  it('lists Markdown files with a modification hint but no provider URLs or unverified revisions', async () => {
    http.on('GET', url(), () => Response.json(page([
      resource('note.md', { md5: 'abc', revision: 123, modified: '2026-09-29T00:00:00Z',
        file: 'https://downloader.disk.yandex.ru/private', preview: 'https://preview.example.invalid' }),
      resource('future.md')
    ])));
    const expected: CloudListResult = { status: 'success', entries: [
      { path: 'note.md', revision: null, modifiedAt: Date.UTC(2026, 8, 29) },
      { path: 'future.md', revision: null }
    ] };
    expect(await adapter().list()).toEqual(expected);
    expect(http.fetch).toHaveBeenCalledTimes(1);
    expect(http.fetch).toHaveBeenCalledWith(url(), {
      method: 'GET', signal: expect.any(AbortSignal), redirect: 'error', headers: { Accept: 'application/json', Authorization: `OAuth ${token}` }
    });
  });

  it.each([
    { name: 'positive UTC offset', modified: '2026-09-29T03:00:00+03:00', expected: Date.UTC(2026, 8, 29) },
    { name: 'negative UTC offset across a date boundary', modified: '2026-09-28T18:30:00-05:30', expected: Date.UTC(2026, 8, 29) },
    { name: 'one fractional digit', modified: '2026-09-29T00:00:00.1Z', expected: Date.UTC(2026, 8, 29) + 100 },
    { name: 'two fractional digits', modified: '2026-09-29T00:00:00.12Z', expected: Date.UTC(2026, 8, 29) + 120 },
    { name: 'Unix epoch zero', modified: '1970-01-01T00:00:00+00:00', expected: 0 },
    { name: 'pre-epoch milliseconds', modified: '1969-12-31T23:59:59.999Z', expected: -1 },
    { name: 'valid leap day', modified: '2024-02-29T00:00:00Z', expected: Date.UTC(2024, 1, 29) }
  ])('converts $name to exact Unix milliseconds', async ({ modified, expected }) => {
    http.on('GET', url(), () => Response.json(page([resource('note.md', { modified })])));
    expect(await adapter().list()).toEqual({ status: 'success', entries: [
      { path: 'note.md', revision: null, modifiedAt: expected }
    ] });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps per-file hints across pages without inventing dates for missing metadata or returning filtered resources', async () => {
    // Unused modification metadata of filtered resources does not affect the list.
    http.on('GET', url(), () => Response.json(page([
      resource('folder.md', { type: 'dir', modified: null }), resource('readme.txt', { modified: 'unknown' })
    ], 0, 5)));
    http.on('GET', url(2), () => Response.json(page([
      resource('a.md', { modified: '2026-09-29T00:00:00Z' }),
      resource('b.md', { created: '2026-09-29T00:00:00Z', modifiedAt: 123, revision: 'unverified' })
    ], 2, 5)));
    http.on('GET', url(4), () => Response.json(page([
      resource('c.md', { modified: '2026-09-30T00:00:00Z' })
    ], 4, 5)));
    expect(await adapter().list()).toEqual({ status: 'success', entries: [
      { path: 'a.md', revision: null, modifiedAt: Date.UTC(2026, 8, 29) },
      { path: 'b.md', revision: null },
      { path: 'c.md', revision: null, modifiedAt: Date.UTC(2026, 8, 30) }
    ] });
    expect(http.fetch.mock.calls.map(([input]) => String(input))).toEqual([url(), url(2), url(4)]);
  });

  it('reads fresh hints on each list without promoting timestamps to revisions or write capabilities', async () => {
    let modified = '2026-09-29T00:00:00Z';
    http.on('GET', url(), () => Response.json(page([resource('note.md', { modified })])));
    const storage = adapter();
    const first = await storage.list();
    modified = '2026-09-30T00:00:00Z';
    const second = await storage.list();
    expect([first, second]).toEqual([
      { status: 'success', entries: [{ path: 'note.md', revision: null, modifiedAt: Date.UTC(2026, 8, 29) }] },
      { status: 'success', entries: [{ path: 'note.md', revision: null, modifiedAt: Date.UTC(2026, 8, 30) }] }
    ]);
    expect(storage.getCapabilities()).toEqual({ revisions: false, conditionalCreate: true });

    expect(http.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('YandexDiskAdapter: invalid listed Markdown modification time', () => {
  it.each([
    { name: 'null', modified: null },
    { name: 'numeric timestamp', modified: 1790640000000 },
    { name: 'boolean', modified: true },
    { name: 'object', modified: { value: '2026-09-29T00:00:00Z' } },
    { name: 'empty string', modified: '' },
    { name: 'invalid calendar day', modified: '2026-04-31T00:00:00Z' },
    { name: 'non-leap February 29', modified: '2026-02-29T00:00:00Z' },
    { name: 'invalid month', modified: '2026-13-01T00:00:00Z' },
    { name: 'hour normalized to the next day', modified: '2026-09-29T24:00:00Z' },
    { name: 'missing timezone', modified: '2026-09-29T00:00:00' },
    { name: 'invalid timezone minutes', modified: '2026-09-29T00:00:00+03:60' },
    { name: 'date without time', modified: '2026-09-29' },
    { name: 'sub-millisecond precision', modified: '2026-09-29T00:00:00.1234Z' },
    { name: 'trailing text', modified: '2026-09-29T00:00:00Z garbage' },
    { name: 'trailing newline', modified: '2026-09-29T00:00:00Z\n' }
  ])('rejects $name without returning a partial success', async ({ modified }) => {
    http.on('GET', url(), () => Response.json(page([
      resource('a.md', { modified: '2026-09-29T00:00:00Z' }), resource('b.md', { modified })
    ])));
    expect(await adapter().list()).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it('discards all earlier pages when a later Markdown file has an invalid date', async () => {
    http.on('GET', url(), () => Response.json(page([
      resource('a.md', { modified: '2026-09-29T00:00:00Z' }), resource('b.md')
    ], 0, 3)));
    http.on('GET', url(2), () => Response.json(page([
      resource('c.md', { modified: 'not a date' })
    ], 2, 3)));
    expect(await adapter().list()).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    expect(http.fetch.mock.calls.map(([input]) => String(input))).toEqual([url(), url(2)]);
  });
});
