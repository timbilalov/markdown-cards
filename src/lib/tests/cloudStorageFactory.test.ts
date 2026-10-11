// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudStoragePort } from '../ports/cloudStorage';
import { createCloudStorage, type CloudStorageConfig } from '../server/cloud/cloudStorageFactory';
import type { YandexDiskAdapterOptions } from '../server/cloud/yandexDiskAdapter';
import { mockHttp } from './helpers/http';

const base = 'https://cloud-api.yandex.net/v1/disk/resources';
const rootPath = 'factory-notes';
const token = 'factory-test-token';
let http: ReturnType<typeof mockHttp>;

function config(options: Partial<YandexDiskAdapterOptions> = {}): CloudStorageConfig {
  return { provider: 'yandex', yandex: { accessToken: token, rootPath, ...options } };
}

function expectCloudStoragePort(port: CloudStoragePort): void {
  // Establish the factory's public result before invoking it: a missing port
  // must fail an assertion, not a subsequent property access on undefined.
  expect(port).toEqual(expect.objectContaining({
    getCapabilities: expect.any(Function), list: expect.any(Function),
    read: expect.any(Function), write: expect.any(Function)
  }));
}

function listUrl(root = rootPath, limit = 100, offset = 0): string {
  return `${base}?path=${encodeURIComponent(`disk:/${root}`)}&limit=${limit}&offset=${offset}&sort=name`;
}

function page(root = rootPath, names: string[] = [], offset = 0, limit = 100, total = names.length) {
  const path = `disk:/${root}`;
  return { type: 'dir', path, _embedded: {
    path, offset, limit, total,
    items: names.map(name => ({ name, type: 'file', path: `${path}/${name}` }))
  } };
}

beforeEach(() => { http = mockHttp(); });
afterEach(() => http.assertHandled());

describe('createCloudStorage: server composition returns a working port', () => {
  it('selects the Yandex capabilities without HTTP', async () => {
    const port = createCloudStorage(config());
    expectCloudStoragePort(port);
    expect(port.getCapabilities()).toEqual({
      revisions: false, conditionalCreate: true
    });

    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('uses the configured token and root with the adapter default page size', async () => {
    http.on('GET', listUrl(), () => Response.json(page()));
    const port = createCloudStorage(config());
    expectCloudStoragePort(port);
    expect(http.fetch).not.toHaveBeenCalled();
    expect(await port.list()).toEqual({ status: 'success', entries: [] });
    expect(http.fetch).toHaveBeenCalledExactlyOnceWith(listUrl(), {
      method: 'GET', signal: expect.any(AbortSignal), redirect: 'error',
      headers: { Accept: 'application/json', Authorization: `OAuth ${token}` }
    });
  });

  it('passes an explicit page size and nested Unicode root through real pagination', async () => {
    const root = 'notes/Мои карточки';
    http.on('GET', listUrl(root, 1), () => Response.json(page(root, ['a.md'], 0, 1, 2)));
    http.on('GET', listUrl(root, 1, 1), () => Response.json(page(root, ['b.md'], 1, 1, 2)));
    const port = createCloudStorage(config({ rootPath: root, pageSize: 1 }));
    expectCloudStoragePort(port);
    expect(await port.list()).toEqual({ status: 'success', entries: [
      { path: 'a.md', revision: null }, { path: 'b.md', revision: null }
    ] });
    expect(http.fetch.mock.calls.map(([url]) => String(url)))
      .toEqual([listUrl(root, 1), listUrl(root, 1, 1)]);
  });

  it('reads through the configured HTTP adapter and retains the exact remote source', async () => {
    const path = 'loaded.md';
    const source = '# Заметка\r\n\r\nExact source ✓\r\n';
    const url = `${base}/download?path=${encodeURIComponent(`disk:/${rootPath}/${path}`)}`;
    const href = 'https://downloader.disk.yandex.ru/disk/factory-read?signature=test-only';
    http.on('GET', url, () => Response.json({ href, method: 'GET', templated: false }));
    http.on('GET', href, () => new Response(source));
    const port = createCloudStorage(config());
    expectCloudStoragePort(port);
    expect(await port.read(path)).toEqual({ status: 'found', document: { path, source, revision: null } });
    expect(http.fetch.mock.calls.map(([input]) => String(input))).toEqual([url, href]);
    expect(http.fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('Authorization')))
      .toEqual([`OAuth ${token}`, `OAuth ${token}`]);
  });

  it('creates through the configured HTTP adapter without changing conditional-write outcomes', async () => {
    const path = 'created.md';
    const source = '# Создано\n';
    const url = `${base}/upload?path=${encodeURIComponent(`disk:/${rootPath}/${path}`)}&overwrite=false`;
    const href = 'https://uploader1d.dst.yandex.net/upload-target/factory-create?signature=test-only';
    http.on('GET', url, () => Response.json({ href, method: 'PUT', templated: false }));
    http.on('PUT', href, () => new Response(null, { status: 201 }));
    const port = createCloudStorage(config());
    expectCloudStoragePort(port);
    expect(await port.write({ path, source, createOnly: true }))
      .toEqual({ status: 'written', revision: null });
    expect(http.fetch).toHaveBeenCalledTimes(2);
    expect(http.fetch).toHaveBeenNthCalledWith(1, url, {
      method: 'GET', signal: expect.any(AbortSignal), redirect: 'error',
      headers: { Accept: 'application/json', Authorization: `OAuth ${token}` }
    });
    expect(http.fetch).toHaveBeenNthCalledWith(2, href, {
      method: 'PUT', signal: expect.any(AbortSignal), redirect: 'error',
      headers: { 'Content-Type': 'application/octet-stream' }, body: new TextEncoder().encode(source)
    });
  });

  it('keeps separately created ports independent instead of sharing credentials or a singleton', async () => {
    const secondRoot = 'second-notes';
    const secondToken = 'second-test-token';
    http.on('GET', listUrl(), () => Response.json(page()));
    http.on('GET', listUrl(secondRoot), () => Response.json(page(secondRoot)));
    const first = createCloudStorage(config());
    const second = createCloudStorage(config({ accessToken: secondToken, rootPath: secondRoot }));
    expectCloudStoragePort(first);
    expectCloudStoragePort(second);
    expect(first).not.toBe(second);
    expect(http.fetch).not.toHaveBeenCalled();
    expect(await first.list()).toEqual({ status: 'success', entries: [] });
    expect(await second.list()).toEqual({ status: 'success', entries: [] });
    expect(await first.list()).toEqual({ status: 'success', entries: [] });
    expect(http.fetch.mock.calls.map(([url, init]) => [String(url), new Headers(init?.headers).get('Authorization')]))
      .toEqual([
        [listUrl(), `OAuth ${token}`], [listUrl(secondRoot), `OAuth ${secondToken}`], [listUrl(), `OAuth ${token}`]
      ]);
  });

  it('captures explicit configuration without mutating it or retargeting an existing port later', async () => {
    const options = { accessToken: token, rootPath, pageSize: 1 };
    const settings = { provider: 'yandex', yandex: options };
    const original = structuredClone(settings);
    http.on('GET', listUrl(rootPath, 1), () => Response.json(page(rootPath, [], 0, 1)));
    const port = createCloudStorage(settings);
    expectCloudStoragePort(port);
    expect(settings).toEqual(original);
    options.accessToken = 'changed-test-token';
    options.rootPath = 'changed-root';
    options.pageSize = 2;
    settings.provider = 'memory';
    expect(await port.list()).toEqual({ status: 'success', entries: [] });
    expect(http.fetch).toHaveBeenCalledExactlyOnceWith(listUrl(rootPath, 1), {
      method: 'GET', signal: expect.any(AbortSignal), redirect: 'error',
      headers: { Accept: 'application/json', Authorization: `OAuth ${token}` }
    });
  });
});

describe('createCloudStorage: configuration failures are explicit and contain no values', () => {
  it.each([undefined, '', ' ', 'Yandex', 'yandex ', 'dropbox', 'memory', 'https://provider.example.invalid'])
    ('rejects provider %j without guessing or falling back to another adapter', provider => {
      expect(() => createCloudStorage({ ...config(), provider }))
        .toThrow(/^Invalid cloud storage configuration$/);
      expect(http.fetch).not.toHaveBeenCalled();
    });

  it('requires explicit Yandex options even when legacy environment values are present', () => {
    vi.stubEnv('VITE_YANDEX_DISK_TOKEN', 'legacy-test-token');
    vi.stubEnv('YANDEX_DISK_TOKEN', 'private-test-token');
    expect(() => createCloudStorage({ provider: 'yandex' }))
      .toThrow(/^Invalid cloud storage configuration$/);
    expect(http.fetch).not.toHaveBeenCalled();
  });

  const invalidOptions: { name: string; options: Partial<YandexDiskAdapterOptions> }[] = [
    { name: 'empty token', options: { accessToken: '' } },
    { name: 'whitespace token', options: { accessToken: ' \t' } },
    { name: 'token containing a newline', options: { accessToken: 'secret-test-value\r\nheader' } },
    { name: 'empty root', options: { rootPath: '' } },
    { name: 'absolute root', options: { rootPath: '/private-test-notes' } },
    { name: 'traversal root', options: { rootPath: 'notes/../private-test-notes' } },
    { name: 'malformed Unicode root', options: { rootPath: 'notes/\ud800' } },
    { name: 'zero page size', options: { pageSize: 0 } },
    { name: 'excessive page size', options: { pageSize: 101 } },
    { name: 'fractional page size', options: { pageSize: 1.5 } },
    { name: 'NaN page size', options: { pageSize: NaN } }
  ];

  it.each(invalidOptions)('rejects $name with the factory error before HTTP', ({ options }) => {
    expect(() => createCloudStorage(config(options))).toThrow(/^Invalid cloud storage configuration$/);
    expect(http.fetch).not.toHaveBeenCalled();
  });
});
