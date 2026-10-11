// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { YandexDiskAdapter } from '../server/cloud/yandexDiskAdapter';
import { mockHttp } from './helpers/http';
import v1 from './fixtures/v1-card.md?raw';
import legacy from './fixtures/migration-legacy.md?raw';
import future from './fixtures/unsupported-version.md?raw';

const token = 'test-only-disk-token';
const filename = 'renamed-note.md';
const uploadUrl = 'https://uploader1d.dst.yandex.net:443/upload-target/test?signature=test-only';
const capabilities = { revisions: false, conditionalCreate: true };
let http: ReturnType<typeof mockHttp>;
let adapter: YandexDiskAdapter;

function apiUrl(path = filename, root = 'md-cards'): string {
  return `https://cloud-api.yandex.net/v1/disk/resources/upload?path=${encodeURIComponent(`disk:/${root}/${path}`)}&overwrite=false`;
}

function link(href = uploadUrl) {
  return { href, method: 'PUT', templated: false, operation_id: 'test-only-operation' };
}

function createRequest(source = v1, path = filename) {
  return { path, source, createOnly: true };
}

beforeEach(() => {
  http = mockHttp();
  adapter = new YandexDiskAdapter({ accessToken: token, rootPath: 'md-cards' });
});
afterEach(() => http.assertHandled());

describe('YandexDiskAdapter: capabilities', () => {
  it('reports conditional creation, no verified revisions and no conditional update', () => {
    expect(adapter.getCapabilities()).toEqual(capabilities);
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('returns independent capability objects', async () => {
    const exposed = adapter.getCapabilities();
    expect(exposed).toEqual(capabilities);
    Object.assign(exposed, { revisions: true, conditionalCreate: false });
    expect(adapter.getCapabilities()).toEqual(capabilities);

    expect(http.fetch).not.toHaveBeenCalled();
  });

});

describe('YandexDiskAdapter.write: exact conditional creation', () => {
  it.each([
    { name: 'v1', source: v1 },
    { name: 'legacy', source: legacy },
    { name: 'future format', source: future },
    { name: 'empty source', source: '' },
    { name: 'CRLF and Unicode', source: '# Заметка 🗂\r\n\r\nТекст  \r\n\t' },
    { name: 'BOM', source: '\uFEFF# Note\n' }
  ])('uploads exact UTF-8 for $name and confirms only 201', async ({ source }) => {
    http.on('GET', apiUrl(), () => Response.json(link()));
    http.on('PUT', uploadUrl, () => new Response('untrusted response body', {
      status: 201, headers: { ETag: 'unverified' }
    }));
    expect(await adapter.write(createRequest(source))).toEqual({ status: 'written', revision: null });
    expect(http.fetch).toHaveBeenCalledTimes(2);
    expect(http.fetch).toHaveBeenNthCalledWith(1, apiUrl(), {
      method: 'GET', signal: expect.any(AbortSignal), redirect: 'error',
      headers: { Accept: 'application/json', Authorization: `OAuth ${token}` }
    });
    expect(http.fetch).toHaveBeenNthCalledWith(2, uploadUrl, {
      method: 'PUT', signal: expect.any(AbortSignal), redirect: 'error',
      headers: { 'Content-Type': 'application/octet-stream' }, body: new TextEncoder().encode(source)
    });
  });

  it('uses the exact Unicode filename and nested root instead of an embedded Card ID', async () => {
    const root = 'notes/Мои карточки';
    const path = 'Заметка & планы #1.md';
    const localAdapter = new YandexDiskAdapter({ accessToken: token, rootPath: root });
    http.on('GET', apiUrl(path, root), () => Response.json(link()));
    http.on('PUT', uploadUrl, () => new Response(null, { status: 201 }));
    expect(await localAdapter.write(createRequest(v1, path))).toEqual({ status: 'written', revision: null });
    expect(http.fetch).toHaveBeenCalledTimes(2);
    expect(http.fetch.mock.calls[0][0]).toBe(apiUrl(path, root));
    expect(http.fetch.mock.calls[1][1]?.body).toEqual(new TextEncoder().encode(v1));
  });

  it('returns conflict for an existing path before upload and never requests overwrite=true', async () => {
    http.on('GET', apiUrl(), () => new Response('already exists', { status: 409 }));
    expect(await adapter.write(createRequest())).toEqual({ status: 'conflict' });
    expect(http.fetch).toHaveBeenCalledTimes(1);
    expect(http.fetch.mock.calls[0][0]).toBe(apiUrl());
  });

  it('preserves a conflict returned by PUT after issuing an upload link without retrying', async () => {
    http.on('GET', apiUrl(), () => Response.json(link()));
    http.on('PUT', uploadUrl, () => new Response('path appeared', { status: 409 }));
    expect(await adapter.write(createRequest())).toEqual({ status: 'conflict' });
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps both concurrent requests conditional and reports the provider winner and conflict', async () => {
    // Explicit provider transcript, not a simulation/proof of server-side CAS.
    const firstUrl = uploadUrl;
    const secondUrl = 'https://uploader2d.dst.yandex.net/upload-target/second?signature=test-only';
    let issued = 0;
    http.on('GET', apiUrl(), () => Response.json(link(issued++ === 0 ? firstUrl : secondUrl)));
    http.on('PUT', firstUrl, () => new Response(null, { status: 201 }));
    http.on('PUT', secondUrl, () => new Response(null, { status: 409 }));
    expect(await Promise.all([
      adapter.write(createRequest('first source')),
      adapter.write(createRequest('second source'))
    ])).toEqual([{ status: 'written', revision: null }, { status: 'conflict' }]);
    expect(http.fetch).toHaveBeenCalledTimes(4);
    expect(http.fetch.mock.calls.filter(([, init]) => init?.method === 'GET').map(([url]) => url))
      .toEqual([apiUrl(), apiUrl()]);
    expect(http.fetch.mock.calls.filter(([, init]) => init?.method === 'PUT').map(([url, init]) => [url, init?.body]))
      .toEqual([[firstUrl, new TextEncoder().encode('first source')], [secondUrl, new TextEncoder().encode('second source')]]);
  });
});

describe('YandexDiskAdapter.write: reject invalid input before any HTTP', () => {
  it.each([
    '', '.', '..', '../outside.md', '/note.md', 'disk:/md-cards/note.md',
    'folder/note.md', 'folder\\note.md', '%2e%2e.md', 'note%2fother.md',
    'https://example.invalid/note.md', 'bad\u0000.md', 'bad\n.md', '\ud800.md'
  ])('rejects invalid path %j', async path => {
    expect(await adapter.write(createRequest(v1, path))).toEqual({ status: 'invalid', reason: 'invalid-path' });
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it.each(['before\ud800after', 'before\udc00after'])('refuses lossy UTF-8 encoding of %j', async source => {
    expect(await adapter.write(createRequest(source))).toEqual({ status: 'invalid', reason: 'invalid-source' });
    expect(http.fetch).not.toHaveBeenCalled();
  });
});

describe('YandexDiskAdapter.write: failures before the PUT are known not written', () => {
  it.each([[401, 'auth'], [403, 'auth'], [404, 'remote'], [429, 'remote'], [503, 'remote'],
    [302, 'remote'], [201, 'remote']] as const)('maps link API HTTP %i to %s / not-written', async (status, reason) => {
    const foreign = 'https://example.invalid/collect';
    http.on('GET', apiUrl(), () => new Response('private provider detail', { status, headers: { Location: foreign } }));
    http.on('GET', foreign, () => Response.json(link()));
    expect(await adapter.write(createRequest())).toEqual({ status: 'unavailable', reason, outcome: 'not-written' });
    expect(http.fetch).toHaveBeenCalledTimes(1);
    expect(http.fetch.mock.calls[0][1]?.redirect).toBe('error');
  });

  it('reports a rejected link fetch as network / not-written', async () => {
    http.on('GET', apiUrl(), () => { throw new TypeError('test network failure'); });
    expect(await adapter.write(createRequest())).toEqual({ status: 'unavailable', reason: 'network', outcome: 'not-written' });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses malformed link JSON without uploading', async () => {
    http.on('GET', apiUrl(), () => new Response('{'));
    expect(await adapter.write(createRequest())).toEqual({ status: 'unavailable', reason: 'invalid-response', outcome: 'not-written' });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'null', body: null },
    { name: 'missing href', body: { method: 'PUT', templated: false } },
    { name: 'non-string href', body: { ...link(), href: 7 } },
    { name: 'wrong method', body: { ...link(), method: 'GET' } },
    { name: 'missing method', body: { href: uploadUrl, templated: false } },
    { name: 'templated link', body: { ...link(), templated: true } },
    { name: 'missing templated flag', body: { href: uploadUrl, method: 'PUT' } }
  ])('refuses link schema: $name', async ({ body }) => {
    http.on('GET', apiUrl(), () => Response.json(body));
    expect(await adapter.write(createRequest())).toEqual({ status: 'unavailable', reason: 'invalid-response', outcome: 'not-written' });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('YandexDiskAdapter.write: only approved upload destinations receive the source', () => {
  it.each([
    'http://uploader1d.dst.yandex.net/upload-target/file',
    'https://example.invalid/upload-target/file',
    'https://uploader1d.dst.yandex.net.example.invalid/upload-target/file',
    'https://other.dst.yandex.net/upload-target/file',
    'https://user:password@uploader1d.dst.yandex.net/upload-target/file',
    'https://uploader1d.dst.yandex.net:8443/upload-target/file',
    'https://127.0.0.1/upload-target/file',
    '//uploader1d.dst.yandex.net/upload-target/file',
    'https://uploader1d.dst.yandex.net/upload-target/file#fragment',
    '', 'not a URL',
    'https://uploader1d.dst.yandex.net/up\nload-target/file',
    'https://uploader1d.dst.yandex.net\\upload-target\\file',
    'https://uploader1d.dst.yandex.net/private'
  ])('refuses unsafe upload href %j without sending the source', async href => {
    http.on('GET', apiUrl(), () => Response.json(link(href)));
    http.on('PUT', href, () => new Response(null, { status: 201 }));
    expect(await adapter.write(createRequest())).toEqual({ status: 'unavailable', reason: 'invalid-response', outcome: 'not-written' });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('YandexDiskAdapter.write: unconfirmed PUT outcomes remain unknown', () => {
  it.each([[202, 'remote'], [200, 'remote'], [204, 'remote'], [401, 'auth'], [403, 'auth'],
    [412, 'remote'], [503, 'remote'], [507, 'remote']] as const)('maps PUT HTTP %i to %s / unknown', async (status, reason) => {
    http.on('GET', apiUrl(), () => Response.json(link()));
    http.on('PUT', uploadUrl, () => new Response(null, { status }));
    expect(await adapter.write(createRequest())).toEqual({ status: 'unavailable', reason, outcome: 'unknown' });
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry or report not-written when the PUT response is lost', async () => {
    http.on('GET', apiUrl(), () => Response.json(link()));
    http.on('PUT', uploadUrl, () => { throw new TypeError('test response lost after sending'); });
    expect(await adapter.write(createRequest())).toEqual({ status: 'unavailable', reason: 'network', outcome: 'unknown' });
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not resend source to an upload redirect target or claim the outcome is known', async () => {
    const foreign = 'https://example.invalid/collect';
    http.on('GET', apiUrl(), () => Response.json(link()));
    http.on('PUT', uploadUrl, () => new Response(null, { status: 307, headers: { Location: foreign } }));
    http.on('PUT', foreign, () => new Response(null, { status: 201 }));
    expect(await adapter.write(createRequest())).toEqual({ status: 'unavailable', reason: 'remote', outcome: 'unknown' });
    expect(http.fetch).toHaveBeenCalledTimes(2);
    expect(http.fetch.mock.calls[1][1]?.redirect).toBe('error');
  });
});
