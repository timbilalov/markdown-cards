// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { YandexDiskAdapter } from '../server/cloud/yandexDiskAdapter';
import { mockHttp } from './helpers/http';
import v1 from './fixtures/v1-card.md?raw';
import legacy from './fixtures/migration-legacy.md?raw';
import future from './fixtures/unsupported-version.md?raw';

const token = 'test-only-disk-token';
const filename = 'renamed-note.md'; // Independent of the ID inside Markdown.
const downloadUrl = 'https://downloader.dst.yandex.ru/disk/test-file?signature=test-only';
const storageUrl = 'https://s123.storage.yandex.net/test-file?signature=test-only';
let http: ReturnType<typeof mockHttp>;
let adapter: YandexDiskAdapter;

function apiUrl(path = filename, root = 'md-cards'): string {
  return `https://cloud-api.yandex.net/v1/disk/resources/download?path=${encodeURIComponent(`disk:/${root}/${path}`)}`;
}

function link(href = downloadUrl) {
  return { href, method: 'GET', templated: false };
}

function found(source: string, path = filename) {
  return { status: 'found', document: { path, source, revision: null } };
}

function serveSource(source: string, href = downloadUrl) {
  http.on('GET', apiUrl(), () => Response.json(link(href)));
  http.on('GET', href, () => new Response(source, { headers: { 'Content-Type': 'application/octet-stream' } }));
}

beforeEach(() => {
  http = mockHttp();
  adapter = new YandexDiskAdapter({ accessToken: token, rootPath: 'md-cards' });
});
afterEach(() => http.assertHandled());

describe('YandexDiskAdapter.read: exact source without parsing or inventing revisions', () => {
  it.each([
    { name: 'v1', source: v1 },
    { name: 'legacy', source: legacy },
    { name: 'future format', source: future },
    { name: 'empty file', source: '' },
    { name: 'CRLF, Unicode and trailing whitespace', source: '# Заметка 🗂\r\n\r\nТекст  \r\n\t' },
    { name: 'UTF-8 BOM', source: '\uFEFF# Заметка\r\n' }
  ])('preserves $name exactly', async ({ source }) => {
    serveSource(source);
    expect(await adapter.read(filename)).toEqual(found(source));
    expect(http.fetch).toHaveBeenCalledTimes(2);
    expect(http.fetch).toHaveBeenNthCalledWith(1, apiUrl(), {
      method: 'GET', signal: expect.any(AbortSignal), redirect: 'error',
      headers: { Accept: 'application/json', Authorization: `OAuth ${token}` }
    });
    expect(http.fetch).toHaveBeenNthCalledWith(2, downloadUrl, {
      method: 'GET', signal: expect.any(AbortSignal), redirect: 'manual',
      headers: { Accept: 'application/octet-stream', Authorization: `OAuth ${token}` }
    });
  });

  it('encodes a Unicode filename and configured nested root once', async () => {
    const root = 'notes/Мои карточки';
    const path = 'Заметка & планы #1.md';
    const localAdapter = new YandexDiskAdapter({ accessToken: token, rootPath: root });
    http.on('GET', apiUrl(path, root), () => Response.json(link()));
    http.on('GET', downloadUrl, () => new Response(legacy));
    expect(await localAdapter.read(path)).toEqual(found(legacy, path));
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it('accepts the other explicitly allowed downloader host', async () => {
    const href = 'https://downloader.disk.yandex.ru/disk/test-file?signature=test-only';
    serveSource(legacy, href);
    expect(await adapter.read(filename)).toEqual(found(legacy));
    expect(http.fetch).toHaveBeenNthCalledWith(2, href, {
      method: 'GET', signal: expect.any(AbortSignal), redirect: 'manual',
      headers: { Accept: 'application/octet-stream', Authorization: `OAuth ${token}` }
    });
  });

  it('follows one documented storage redirect without forwarding OAuth', async () => {
    http.on('GET', apiUrl(), () => Response.json(link()));
    http.on('GET', downloadUrl, () => new Response(null, { status: 302, headers: { Location: storageUrl } }));
    http.on('GET', storageUrl, () => new Response(v1));
    expect(await adapter.read(filename)).toEqual(found(v1));
    expect(http.fetch).toHaveBeenCalledTimes(3);
    expect(http.fetch).toHaveBeenNthCalledWith(3, storageUrl, {
      method: 'GET', signal: expect.any(AbortSignal), redirect: 'manual', headers: { Accept: 'application/octet-stream' }
    });
  });

  it('decodes a UTF-8 character split between stream chunks without changing it', async () => {
    const source = 'Я🗂';
    const bytes = new TextEncoder().encode(source);
    http.on('GET', apiUrl(), () => Response.json(link()));
    http.on('GET', downloadUrl, () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 1));
        controller.enqueue(bytes.slice(1, 4));
        controller.enqueue(bytes.slice(4));
        controller.close();
      }
    })));
    expect(await adapter.read(filename)).toEqual(found(source));
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it('requests the current file on every read and ignores unverified revision fields', async () => {
    let source = legacy;
    http.on('GET', apiUrl(), () => Response.json({ ...link(), revision: 'unverified', md5: 'unverified' }));
    http.on('GET', downloadUrl, () => new Response(source, { headers: { ETag: 'unverified' } }));
    expect(await adapter.read(filename)).toEqual(found(legacy));
    source = v1;
    expect(await adapter.read(filename)).toEqual(found(v1));
    expect(http.fetch).toHaveBeenCalledTimes(4);
  });
});

describe('YandexDiskAdapter.read: validate input before any HTTP', () => {
  it.each([
    '', '.', '..', '../outside.md', '/note.md', 'disk:/md-cards/note.md',
    'folder/note.md', 'folder\\note.md', '%2e%2e.md', 'note%2fother.md',
    'https://example.invalid/note.md', 'bad\u0000.md', 'bad\n.md', '\ud800.md'
  ])('rejects invalid path %j', async path => {
    expect(await adapter.read(path)).toEqual({ status: 'invalid', reason: 'invalid-path' });
    expect(http.fetch).not.toHaveBeenCalled();
  });
});

describe('YandexDiskAdapter.read: download-link API failures', () => {
  it.each([
    { status: 401, result: { status: 'unavailable', reason: 'auth' } },
    { status: 403, result: { status: 'unavailable', reason: 'auth' } },
    { status: 404, result: { status: 'not-found' } },
    { status: 429, result: { status: 'unavailable', reason: 'remote' } },
    { status: 503, result: { status: 'unavailable', reason: 'remote' } },
    { status: 302, result: { status: 'unavailable', reason: 'remote' } }
  ])('maps API HTTP $status before any download', async ({ status, result }) => {
    const foreign = 'https://example.invalid/collect';
    http.on('GET', apiUrl(), () => new Response('private provider detail', { status, headers: { Location: foreign } }));
    http.on('GET', foreign, () => Response.json(link()));
    expect(await adapter.read(filename)).toEqual(result);
    expect(http.fetch).toHaveBeenCalledTimes(1);
    expect(http.fetch.mock.calls[0][1]?.redirect).toBe('error');
  });

  it('reports a failed API fetch as network, not absence', async () => {
    http.on('GET', apiUrl(), () => { throw new TypeError('test network failure'); });
    expect(await adapter.read(filename)).toEqual({ status: 'unavailable', reason: 'network' });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses malformed link JSON', async () => {
    http.on('GET', apiUrl(), () => new Response('{'));
    expect(await adapter.read(filename)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'null', body: null },
    { name: 'missing href', body: { method: 'GET', templated: false } },
    { name: 'non-string href', body: { ...link(), href: 7 } },
    { name: 'wrong method', body: { ...link(), method: 'PUT' } },
    { name: 'missing method', body: { href: downloadUrl, templated: false } },
    { name: 'templated link', body: { ...link(), templated: true } },
    { name: 'missing templated flag', body: { href: downloadUrl, method: 'GET' } }
  ])('refuses link schema: $name', async ({ body }) => {
    http.on('GET', apiUrl(), () => Response.json(body));
    expect(await adapter.read(filename)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('YandexDiskAdapter.read: download URL and redirect boundaries', () => {
  it.each([
    'http://downloader.dst.yandex.ru/disk/file',
    'ftp://downloader.dst.yandex.ru/disk/file',
    'https://example.invalid/disk/file',
    'https://downloader.dst.yandex.ru.example.invalid/disk/file',
    'https://user:password@downloader.dst.yandex.ru/disk/file',
    'https://downloader.dst.yandex.ru:8443/disk/file',
    'https://127.0.0.1/disk/file',
    '//downloader.dst.yandex.ru/disk/file',
    'https://downloader.dst.yandex.ru/disk/file#fragment',
    '', 'not a URL',
    'https://downloader.dst.yandex.ru/di\nsk/file',
    'https://downloader.dst.yandex.ru\\disk\\file',
    storageUrl,
    'https://downloader.dst.yandex.ru/private'
  ])('refuses an unsafe initial href %j before sending OAuth', async href => {
    http.on('GET', apiUrl(), () => Response.json(link(href)));
    http.on('GET', href, () => new Response('unexpected download'));
    expect(await adapter.read(filename)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    'http://s123.storage.yandex.net/file',
    'https://example.invalid/file',
    'https://s123.storage.yandex.net.example.invalid/file',
    'https://evil-storage.yandex.net/file',
    'https://storage.yandex.net/file',
    'https://user:password@s123.storage.yandex.net/file',
    'https://s123.storage.yandex.net:8443/file',
    'https://127.0.0.1/file',
    '/relative-file',
    'https://s123.storage.yandex.net/file#fragment',
    downloadUrl
  ])('refuses an unsafe redirect target %j without requesting it', async target => {
    http.on('GET', apiUrl(), () => Response.json(link()));
    http.on('GET', downloadUrl, () => new Response(null, { status: 302, headers: { Location: target } }));
    if (target !== downloadUrl) http.on('GET', target, () => new Response('unexpected download'));
    expect(await adapter.read(filename)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    expect(http.fetch).toHaveBeenCalledTimes(2);
    expect(http.fetch.mock.calls[1][1]?.redirect).toBe('manual');
  });

  it('refuses a redirect without Location', async () => {
    http.on('GET', apiUrl(), () => Response.json(link()));
    http.on('GET', downloadUrl, () => new Response(null, { status: 302 }));
    expect(await adapter.read(filename)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it('refuses a second redirect even to another allowed storage host', async () => {
    const secondStorage = 'https://s456.storage.yandex.net/file';
    http.on('GET', apiUrl(), () => Response.json(link()));
    http.on('GET', downloadUrl, () => new Response(null, { status: 302, headers: { Location: storageUrl } }));
    http.on('GET', storageUrl, () => new Response(null, { status: 302, headers: { Location: secondStorage } }));
    http.on('GET', secondStorage, () => new Response('unexpected download'));
    expect(await adapter.read(filename)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    expect(http.fetch).toHaveBeenCalledTimes(3);
    expect(http.fetch.mock.calls[2][1]?.redirect).toBe('manual');
  });
});

describe('YandexDiskAdapter.read: download errors never become missing or partial documents', () => {
  it.each([
    [401, 'auth'], [403, 'auth'], [404, 'remote'], [500, 'remote'], [503, 'remote'], [204, 'remote'], [206, 'remote']
  ] as const)('maps download HTTP %i to %s', async (status, reason) => {
    http.on('GET', apiUrl(), () => Response.json(link()));
    http.on('GET', downloadUrl, () => new Response(null, { status }));
    expect(await adapter.read(filename)).toEqual({ status: 'unavailable', reason });
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it('reports download fetch rejection as network', async () => {
    http.on('GET', apiUrl(), () => Response.json(link()));
    http.on('GET', downloadUrl, () => { throw new TypeError('test network failure'); });
    expect(await adapter.read(filename)).toEqual({ status: 'unavailable', reason: 'network' });
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it('discards a partially received body if the stream fails', async () => {
    http.on('GET', apiUrl(), () => Response.json(link()));
    let delivered = false;
    http.on('GET', downloadUrl, () => new Response(new ReadableStream({
      pull(controller) {
        if (delivered) { controller.error(new TypeError('test interrupted download')); return; }
        delivered = true;
        controller.enqueue(new TextEncoder().encode('# Partial source'));
      }
    })));
    expect(await adapter.read(filename)).toEqual({ status: 'unavailable', reason: 'network' });
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it('refuses invalid UTF-8 instead of silently inserting replacement characters', async () => {
    http.on('GET', apiUrl(), () => Response.json(link()));
    http.on('GET', downloadUrl, () => new Response(new Uint8Array([0xc3, 0x28])));
    expect(await adapter.read(filename)).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not treat a storage-server 404 as confirmed absence', async () => {
    http.on('GET', apiUrl(), () => Response.json(link()));
    http.on('GET', downloadUrl, () => new Response(null, { status: 302, headers: { Location: storageUrl } }));
    http.on('GET', storageUrl, () => new Response('expired URL', { status: 404 }));
    expect(await adapter.read(filename)).toEqual({ status: 'unavailable', reason: 'remote' });
    expect(http.fetch).toHaveBeenCalledTimes(3);
  });
});
