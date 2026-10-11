// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudStoragePort } from '../ports/cloudStorage';
import { createServerCloudStorage } from '../server/cloud/serverCloudStorage';
import { mockHttp } from './helpers/http';

const privateEnvironment = vi.hoisted(() => {
  const state: { values: Readonly<Record<string, string | undefined>> } = { values: {} };
  return state;
});
// Substitute only the framework's env source, never the factory or adapter.
vi.mock('$env/dynamic/private', () => ({ get env() { return privateEnvironment.values; } }));

const token = 'runtime-private-test-token';
const root = 'notes/Мои карточки';
const settings = {
  CLOUD_STORAGE_PROVIDER: 'yandex',
  YANDEX_DISK_TOKEN: token,
  YANDEX_DISK_BASE_PATH: root
};
let http: ReturnType<typeof mockHttp>;
let errorLog: ReturnType<typeof vi.spyOn>;
let warningLog: ReturnType<typeof vi.spyOn>;
let infoLog: ReturnType<typeof vi.spyOn>;

function expectPort(port: CloudStoragePort): void {
  // The RED stub must fail a result assertion before any method access.
  expect(port).toEqual(expect.objectContaining({
    getCapabilities: expect.any(Function), list: expect.any(Function),
    read: expect.any(Function), write: expect.any(Function)
  }));
  expect(port.getCapabilities()).toEqual({
    revisions: false, conditionalCreate: true
  });
}

function listUrl(folder = root): string {
  return 'https://cloud-api.yandex.net/v1/disk/resources'
    + `?path=${encodeURIComponent(`disk:/${folder}`)}&limit=100&offset=0&sort=name`;
}

function emptyFolder(folder = root) {
  const path = `disk:/${folder}`;
  return { type: 'dir', path, _embedded: { path, items: [], limit: 100, offset: 0, total: 0 } };
}

beforeEach(() => {
  privateEnvironment.values = {
    ...settings,
    // These legacy keys may be present alongside private env; never use them.
    VITE_YANDEX_DISK_TOKEN: 'legacy-public-test-token',
    VITE_YANDEX_DISK_BASE_PATH: 'legacy-public-root'
  };
  // A direct process.env/import.meta.env fallback must not override Kit's env.
  vi.stubEnv('CLOUD_STORAGE_PROVIDER', 'memory');
  vi.stubEnv('YANDEX_DISK_TOKEN', 'process-test-token');
  vi.stubEnv('YANDEX_DISK_BASE_PATH', 'process-test-root');
  vi.stubEnv('VITE_YANDEX_DISK_TOKEN', 'legacy-process-test-token');
  vi.stubEnv('VITE_YANDEX_DISK_BASE_PATH', 'legacy-process-root');
  http = mockHttp();
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  warningLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
  infoLog = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  http.assertHandled();
  // Configuration errors belong to the caller; this boundary does not log env.
  expect(errorLog).not.toHaveBeenCalled();
  expect(warningLog).not.toHaveBeenCalled();
  expect(infoLog).not.toHaveBeenCalled();
});

describe('createServerCloudStorage: runtime private configuration', () => {
  it('uses only Kit private env and constructs the real HTTP port lazily after module import', async () => {
    // The module was imported when the mock env was empty. No import-time config
    // failure or snapshot should prevent valid configuration at call time.
    http.on('GET', listUrl(), () => Response.json(emptyFolder()));
    const port = createServerCloudStorage();
    expectPort(port);
    expect(http.fetch).not.toHaveBeenCalled();
    expect(await port.list()).toEqual({ status: 'success', entries: [] });
    expect(http.fetch).toHaveBeenCalledExactlyOnceWith(listUrl(), {
      method: 'GET', signal: expect.any(AbortSignal), redirect: 'error',
      headers: { Accept: 'application/json', Authorization: `OAuth ${token}` }
    });
  });

  it('reads env for each call while keeping existing instances bound to their original settings', async () => {
    const secondRoot = 'second-notes';
    const secondToken = 'second-private-test-token';
    http.on('GET', listUrl(), () => Response.json(emptyFolder()));
    http.on('GET', listUrl(secondRoot), () => Response.json(emptyFolder(secondRoot)));
    const first = createServerCloudStorage();
    expectPort(first);
    privateEnvironment.values = {
      ...settings, YANDEX_DISK_TOKEN: secondToken, YANDEX_DISK_BASE_PATH: secondRoot
    };
    const second = createServerCloudStorage();
    expectPort(second);
    expect(first).not.toBe(second);
    expect(await first.list()).toEqual({ status: 'success', entries: [] });
    expect(await second.list()).toEqual({ status: 'success', entries: [] });
    privateEnvironment.values = { ...settings, CLOUD_STORAGE_PROVIDER: 'dropbox' };
    expect(() => createServerCloudStorage()).toThrow(/^Invalid cloud storage configuration$/);
    expect(http.fetch.mock.calls.map(([url, init]) => [String(url), new Headers(init?.headers).get('Authorization')]))
      .toEqual([[listUrl(), `OAuth ${token}`], [listUrl(secondRoot), `OAuth ${secondToken}`]]);
  });

  it('accepts a read-only environment without mutating or supplementing it', async () => {
    privateEnvironment.values = Object.freeze({ ...settings });
    http.on('GET', listUrl(), () => Response.json(emptyFolder()));
    const port = createServerCloudStorage();
    expectPort(port);
    expect(privateEnvironment.values).toEqual(settings);
    expect(await port.list()).toEqual({ status: 'success', entries: [] });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it('can use corrected env after a configuration error without reloading the module', () => {
    privateEnvironment.values = {};
    expect(() => createServerCloudStorage()).toThrow(/^Invalid cloud storage configuration$/);
    privateEnvironment.values = { ...settings };
    expectPort(createServerCloudStorage());
    expect(http.fetch).not.toHaveBeenCalled();
  });
});

describe('createServerCloudStorage: explicit failure without env fallbacks', () => {
  it.each(['CLOUD_STORAGE_PROVIDER', 'YANDEX_DISK_TOKEN', 'YANDEX_DISK_BASE_PATH'])
    ('requires %s from private env even when legacy and process values exist', key => {
      const values = { ...privateEnvironment.values };
      delete values[key];
      privateEnvironment.values = values;
      expect(() => createServerCloudStorage()).toThrow(/^Invalid cloud storage configuration$/);
      expect(http.fetch).not.toHaveBeenCalled();
    });

  it.each(['', ' ', 'Yandex', 'yandex ', 'memory', 'dropbox'])
    ('refuses provider %j instead of defaulting or normalizing', provider => {
      privateEnvironment.values = { ...settings, CLOUD_STORAGE_PROVIDER: provider };
      expect(() => createServerCloudStorage()).toThrow(/^Invalid cloud storage configuration$/);
      expect(http.fetch).not.toHaveBeenCalled();
    });

  it.each(['', ' \t', 'private-test-value\r\nheader'])
    ('rejects invalid private token %j with a value-free configuration error', accessToken => {
      privateEnvironment.values = { ...settings, YANDEX_DISK_TOKEN: accessToken };
      expect(() => createServerCloudStorage()).toThrow(/^Invalid cloud storage configuration$/);
      expect(http.fetch).not.toHaveBeenCalled();
    });

  it.each(['', '/notes', 'notes/../outside', 'notes//cards', 'notes/%2e%2e', 'notes/\u0000cards', 'notes/\ud800'])
    ('rejects invalid private root %j before HTTP', rootPath => {
      privateEnvironment.values = { ...settings, YANDEX_DISK_BASE_PATH: rootPath };
      expect(() => createServerCloudStorage()).toThrow(/^Invalid cloud storage configuration$/);
      expect(http.fetch).not.toHaveBeenCalled();
    });
});
