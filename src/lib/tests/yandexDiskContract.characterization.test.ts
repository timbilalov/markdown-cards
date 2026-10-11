// @vitest-environment node
import { afterEach, beforeEach, expect, vi } from 'vitest';
import type { CloudDocument } from '../ports/cloudStorage';
import { YandexDiskAdapter } from '../server/cloud/yandexDiskAdapter';
import { defineCloudStorageContract } from './contracts/cloudStorage.contract';

const root = 'contract-notes';
const rootPath = `disk:/${root}`;
const resourcesUrl = 'https://cloud-api.yandex.net/v1/disk/resources';
const token = 'contract-test-token';
let protocolErrors: unknown[] = [];

beforeEach(() => { protocolErrors = []; });
afterEach(() => {
  // Adapter error mapping must not hide a failed assertion inside the HTTP fake.
  expect(protocolErrors, 'Unexpected HTTP requests or protocol violations').toEqual([]);
});

function installRemote(documents: readonly CloudDocument[]): void {
  // Seed only the HTTP remote. The real adapter performs every port operation.
  // This model assumes overwrite=false is enforced by the provider; it cannot
  // establish atomicity on a live Yandex server or supply missing CAS revisions.
  const files = new Map(documents.map(document => [
    `${rootPath}/${document.path}`, new TextEncoder().encode(document.source)
  ]));
  const downloads = new Map<string, string>();
  const uploads = new Map<string, string>();
  let nextLink = 0;

  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    try {
      const href = String(input);
      const url = new URL(href);
      const headers = new Headers(init?.headers);
      if (!init) throw new Error('Expected explicit request options');

      const uploadPath = uploads.get(href);
      if (uploadPath !== undefined) {
        expect(init.method).toBe('PUT');
        expect(init.redirect).toBe('error');
        expect(headers.get('Authorization')).toBeNull();
        expect(headers.get('Content-Type')).toBe('application/octet-stream');
        expect(init.body).toBeInstanceOf(Uint8Array);
        if (!(init.body instanceof Uint8Array)) throw new Error('Expected UTF-8 bytes');
        // Two issued links do not reserve the path: the second PUT conflicts.
        if (files.has(uploadPath)) return new Response(null, { status: 409 });
        files.set(uploadPath, new Uint8Array(init.body));
        return new Response(null, { status: 201 });
      }

      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
      expect(headers.get('Authorization')).toBe(`OAuth ${token}`);

      const downloadPath = downloads.get(href);
      if (downloadPath !== undefined) {
        expect(init.redirect).toBe('manual');
        expect(headers.get('Accept')).toBe('application/octet-stream');
        const bytes = files.get(downloadPath);
        if (bytes === undefined) throw new Error('Issued download link has no file');
        return new Response(bytes);
      }

      expect(init.redirect).toBe('error');
      expect(headers.get('Accept')).toBe('application/json');
      const endpoint = `${url.origin}${url.pathname}`;
      const query = Object.fromEntries(url.searchParams);

      if (endpoint === resourcesUrl) {
        const offset = Number(query.offset);
        expect(Number.isSafeInteger(offset) && offset >= 0).toBe(true);
        expect(query).toEqual({ path: rootPath, limit: '1', offset: String(offset), sort: 'name' });
        const paths = [...files.keys()].sort();
        return Response.json({
          name: root, type: 'dir', path: rootPath,
          _embedded: {
            path: rootPath, offset, limit: 1, total: paths.length,
            items: paths.slice(offset, offset + 1).map(path => ({
              name: path.slice(rootPath.length + 1), path, type: 'file'
            }))
          }
        });
      }

      if (endpoint === `${resourcesUrl}/download`) {
        expect(query).toEqual({ path: expect.stringMatching(new RegExp(`^${rootPath}/.+`)) });
        if (!files.has(query.path)) return new Response(null, { status: 404 });
        const link = `https://downloader.disk.yandex.ru/disk/${++nextLink}?signature=contract-only`;
        downloads.set(link, query.path);
        return Response.json({ href: link, method: 'GET', templated: false });
      }

      if (endpoint === `${resourcesUrl}/upload`) {
        expect(query).toEqual({
          path: expect.stringMatching(new RegExp(`^${rootPath}/.+`)), overwrite: 'false'
        });
        if (files.has(query.path)) return new Response(null, { status: 409 });
        const link = `https://uploader1d.dst.yandex.net/upload-target/${++nextLink}?signature=contract-only`;
        uploads.set(link, query.path);
        return Response.json({ href: link, method: 'PUT', templated: false });
      }

      throw new Error(`Unexpected HTTP request: ${init.method} ${href}`);
    } catch (error) {
      protocolErrors.push(error);
      throw error;
    }
  }));
}

// Characterization of existing behavior, not a new TDD RED set. Keep the shared
// assertions unchanged and declare expectations independently of the adapter.
defineCloudStorageContract({
  name: 'YandexDiskAdapter over mock HTTP (characterization)',
  capabilities: { revisions: false, conditionalCreate: true },
  create(documents) {
    installRemote(documents);
    // One item per page forces shared multi-file cases through real pagination.
    return new YandexDiskAdapter({ accessToken: token, rootPath: root, pageSize: 1 });
  }
});
