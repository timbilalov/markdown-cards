import { readUploadContent } from './helpers/uploadContent';
import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { isAuthenticated, setAuthenticationStatus } from '../stores/sessionState';
import { BrowserCloudStorage } from '../adapters/browserCloudStorage';
import { mockHttp } from './helpers/http';
import { v1 } from './helpers/markdownReadFixtures';
const path = 'заметка.md';
const request = { path, source: v1, createOnly: true };
describe('browser cloud port', () => {
  it.each([
    [503, 'CLOUD_UNAVAILABLE', 'network'], [502, 'CLOUD_INVALID_RESPONSE', 'invalid-response'],
    [502, 'CLOUD_REMOTE_ERROR', 'remote'], [503, 'CLOUD_NOT_CONFIGURED', 'remote']
  ] as const)('uses the same reason for list, read and write: %s %s', async (status, error, reason) => {
    const http = mockHttp(); const response = () => Response.json({ error, outcome: 'not-written' }, { status });
    http.on('GET', '/api/cloud/files', response);
    http.on('GET', `/api/cloud/download?path=${encodeURIComponent(path)}`, response);
    http.on('POST', '/api/cloud/upload', response);
    const storage = new BrowserCloudStorage();
    expect(await storage.list()).toEqual({ status: 'unavailable', reason });
    expect(await storage.readListed(path)).toEqual({ status: 'unavailable', reason });
    expect(await storage.write(request)).toEqual({ status: 'unavailable', reason, outcome: 'not-written' });
    http.assertHandled();
  });

  it.each(['list', 'read', 'write'] as const)('ignores a %s request\'s stale 401 after a new login', async mode => {
    const response = Promise.withResolvers<Response>(); const http = mockHttp();
    const url = mode === 'list' ? '/api/cloud/files' : mode === 'write' ? '/api/cloud/upload'
      : `/api/cloud/download?path=${encodeURIComponent(path)}`;
    http.on(mode === 'write' ? 'POST' : 'GET', url, () => response.promise);
    setAuthenticationStatus(true);
    const storage = new BrowserCloudStorage();
    const pending = mode === 'list' ? storage.list() : mode === 'read' ? storage.readListed(path) : storage.write(request);
    setAuthenticationStatus(false); setAuthenticationStatus(true);
    response.resolve(Response.json({ error: 'Not authenticated' }, { status: 401 }));
    expect(await pending).toMatchObject({ status: 'unavailable', reason: 'auth' });
    expect(get(isAuthenticated)).toBe(true); http.assertHandled();
  });

  it('sends one exact write with createOnly mapped to overwrite', async () => {
    const http = mockHttp(); let sent: FormData | undefined;
    http.on('POST', '/api/cloud/upload', async init => { sent = init?.body as FormData; return new Response('File uploaded successfully'); });
    expect(await new BrowserCloudStorage().write(request)).toEqual({ status: 'written', revision: null });
    expect([...sent!.keys()]).toEqual(['path', 'content', 'overwrite']);
    expect(sent!.get('path')).toBe(path);
    expect(sent!.get('overwrite')).toBe('false');
    expect(await readUploadContent(sent!)).toBe(v1);
    http.assertHandled();
  });
  it.each([
    [422, { error: 'MARKDOWN_UNSUPPORTED' }, { status: 'invalid', reason: 'invalid-source' }],
    [415, { error: 'UNSUPPORTED_MEDIA_TYPE' }, { status: 'invalid', reason: 'invalid-source' }],
    [503, { error: 'CLOUD_NOT_CONFIGURED', outcome: 'not-written' }, { status: 'unavailable', reason: 'remote', outcome: 'not-written' }],
    [503, { error: 'CLOUD_WRITE_UNSUPPORTED', outcome: 'not-written' }, { status: 'unsupported', operation: 'create-only' }],
    [502, { error: 'CLOUD_AUTH_FAILED', outcome: 'not-written' }, { status: 'unavailable', reason: 'auth', outcome: 'not-written' }],
    [503, { error: 'CLOUD_WRITE_UNKNOWN', outcome: 'unknown' }, { status: 'unavailable', reason: 'remote', outcome: 'unknown' }],
    [502, { error: 'CLOUD_INVALID_RESPONSE', outcome: 'not-written' }, { status: 'unavailable', reason: 'invalid-response', outcome: 'not-written' }],
    [409, { error: 'CLOUD_CONFLICT' }, { status: 'conflict' }],
    [502, {}, { status: 'unavailable', reason: 'remote', outcome: 'unknown' }]
  ] as const)('classifies HTTP %s without retry', async (status, body, expected) => {
    const http = mockHttp(); http.on('POST', '/api/cloud/upload', () => Response.json(body, { status }));
    expect(await new BrowserCloudStorage().write(request)).toEqual(expected);
    expect(http.fetch).toHaveBeenCalledTimes(1); http.assertHandled();
  });
  it('treats a lost upload response as uncertain without retry', async () => {
    const http = mockHttp(); http.on('POST', '/api/cloud/upload', () => { throw new TypeError('lost'); });
    expect(await new BrowserCloudStorage().write(request)).toEqual({ status: 'unavailable', reason: 'network', outcome: 'unknown' });
    expect(http.fetch).toHaveBeenCalledTimes(1); http.assertHandled();
  });
  it('retains BOM and CRLF when reading a listed source', async () => {
    const source = '\uFEFF' + v1.replaceAll('\n', '\r\n'); const http = mockHttp();
    http.on('GET', `/api/cloud/download?path=${encodeURIComponent(path)}`, () => new Response(source));
    expect(await new BrowserCloudStorage().readListed(path)).toEqual({ status: 'found', document: { path, source, revision: null } });
    http.assertHandled();
  });
  it('distinguishes provider auth failure from not-found even at HTTP 502', async () => {
    const http = mockHttp(); http.on('GET', `/api/cloud/download?path=${encodeURIComponent(path)}`,
      () => Response.json({ error: 'CLOUD_AUTH_FAILED' }, { status: 502 }));
    expect(await new BrowserCloudStorage().readListed(path)).toEqual({ status: 'unavailable', reason: 'auth' });
    expect(http.fetch).toHaveBeenCalledTimes(1); http.assertHandled();
  });
});

it('classifies a provider authentication failure in listing as unauthorized even when the server returns 502', async () => {
  const http = mockHttp();
  http.on('GET', '/api/cloud/files', () => Response.json({ error: 'CLOUD_AUTH_FAILED' }, { status: 502 }));
  expect(await new BrowserCloudStorage().read(path)).toEqual({ status: 'unavailable', reason: 'auth' });
  expect(http.fetch).toHaveBeenCalledTimes(1); http.assertHandled();
});
