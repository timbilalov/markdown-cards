// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCloudStorage } from '../server/cloud/cloudStorageFactory';
import type { CloudWriteRequest, CloudStoragePort } from '../ports/cloudStorage';
import { mockHttp } from './helpers/http';
import v1 from './fixtures/v1-card.md?raw';

const token = 'test-only-overwrite-token';
const path = 'Заметка #1 & планы?.md';
const root = 'notes/Мои карточки';
const href = 'https://uploader1d.dst.yandex.net:443/upload-target/test?signature=test-only';
const apiUrl = `https://cloud-api.yandex.net/v1/disk/resources/upload?path=${encodeURIComponent(`disk:/${root}/${path}`)}&overwrite=true`;
const link = { href, method: 'PUT', templated: false };
let http: ReturnType<typeof mockHttp>;
let storage: CloudStoragePort;

beforeEach(() => {
  http = mockHttp();
  storage = createCloudStorage({ provider: 'yandex', yandex: { accessToken: token, rootPath: root } });
});
afterEach(() => http.assertHandled());

function request(source = v1): CloudWriteRequest { return { path, source }; }
function registerLink() { http.on('GET', apiUrl, () => Response.json(link)); }

describe('explicit ordinary overwrite through the provider-neutral factory', () => {
  it.each([v1, '', '\uFEFF# Текст 🗂\r\n\tстрока  \r\n'])('sends exact UTF-8 source %# without read, OAuth on PUT, or invented revision', async source => {
    registerLink();
    http.on('PUT', href, () => new Response(null, { status: 201, headers: { ETag: 'not-a-verified-revision' } }));
    const input = Object.freeze(request(source));
    expect(await storage.write(input)).toEqual({ status: 'written', revision: null });
    expect(http.fetch.mock.calls).toEqual([
      [apiUrl, { method: 'GET', signal: expect.any(AbortSignal), redirect: 'error', headers: { Accept: 'application/json', Authorization: `OAuth ${token}` } }],
      [href, { method: 'PUT', signal: expect.any(AbortSignal), redirect: 'error', headers: { 'Content-Type': 'application/octet-stream' }, body: new TextEncoder().encode(source) }]
    ]);
    expect(input).toEqual({ path, source });
    expect(storage.getCapabilities()).toEqual({ revisions: false, conditionalCreate: true });

    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['existing', 'missing'])('accepts the provider completion when target is %s', async state => {
    // A protocol fake: it models upsert, not the provider's version-history guarantee.
    let remote: string | undefined = state === 'existing' ? 'previous source' : undefined;
    registerLink();
    http.on('PUT', href, init => {
      remote = new TextDecoder().decode(init?.body as Uint8Array);
      return new Response(null, { status: 201 });
    });
    expect(await storage.write(request())).toEqual({ status: 'written', revision: null });
    expect(remote).toBe(v1);
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it('allows two successive replacements without inferring a revision conflict', async () => {
    let remote = 'base';
    registerLink();
    http.on('PUT', href, init => {
      remote = new TextDecoder().decode(init?.body as Uint8Array);
      return new Response(null, { status: 201 });
    });
    expect(await storage.write(request('first'))).toEqual({ status: 'written', revision: null });
    expect(await storage.write(request('second'))).toEqual({ status: 'written', revision: null });
    expect(remote).toBe('second');
    expect(http.fetch).toHaveBeenCalledTimes(4);
  });

  it.each(['', '../note.md', 'a/b.md', 'a\\b.md', 'a%2Fb.md', 'disk:note.md', 'note\n.md', '\ud800.md'])('rejects invalid path %j before HTTP', async invalidPath => {
    expect(await storage.write({ ...request(), path: invalidPath })).toEqual({ status: 'invalid', reason: 'invalid-path' });
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it.each(['\ud800', '\udfff', null])('rejects unencodable/non-string source %j before HTTP', async source => {
    expect(await storage.write({ ...request(), source: source as unknown as string }))
      .toEqual({ status: 'invalid', reason: 'invalid-source' });
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 429, 500, 302])('reports link HTTP %i as not-written without PUT or retry', async status => {
    http.on('GET', apiUrl, () => new Response('untrusted provider body', { status }));
    expect(await storage.write(request())).toEqual({ status: 'unavailable', reason: status === 401 || status === 403 ? 'auth' : 'remote', outcome: 'not-written' });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it('reports network failure before PUT as not-written', async () => {
    http.on('GET', apiUrl, () => { throw new Error('secret provider diagnostic'); });
    expect(await storage.write(request())).toEqual({ status: 'unavailable', reason: 'network', outcome: 'not-written' });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    null, { ...link, method: 'GET' }, { ...link, templated: true },
    { ...link, href: 'https://attacker.example/upload-target/test' },
    { ...link, href: 'http://uploader1d.dst.yandex.net/upload-target/test' },
    { ...link, href: 'https://user:pass@uploader1d.dst.yandex.net/upload-target/test' },
    { ...link, href: 'https://uploader1d.dst.yandex.net:444/upload-target/test' },
    { ...link, href: `${href}#fragment` },
    { ...link, href: 'https://uploader1d.dst.yandex.net/other/test' }
  ])('rejects invalid upload link %# without forwarding content or credentials', async body => {
    http.on('GET', apiUrl, () => Response.json(body));
    expect(await storage.write(request())).toEqual({ status: 'unavailable', reason: 'invalid-response', outcome: 'not-written' });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed JSON before PUT', async () => {
    http.on('GET', apiUrl, () => new Response('{broken'));
    expect(await storage.write(request())).toEqual({ status: 'unavailable', reason: 'invalid-response', outcome: 'not-written' });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['link', 'upload'])('preserves explicit provider conflict at %s without retry', async phase => {
    http.on('GET', apiUrl, () => phase === 'link' ? new Response(null, { status: 409 }) : Response.json(link));
    http.on('PUT', href, () => new Response(null, { status: 409 }));
    expect(await storage.write(request())).toEqual({ status: 'conflict' });
    expect(http.fetch).toHaveBeenCalledTimes(phase === 'link' ? 1 : 2);
  });

  it.each([200, 202, 204, 302, 401, 403, 404, 412, 500])('does not confirm or retry upload HTTP %i', async status => {
    registerLink();
    http.on('PUT', href, () => new Response(null, { status }));
    expect(await storage.write(request())).toEqual({ status: 'unavailable', reason: status === 401 || status === 403 ? 'auth' : 'remote', outcome: 'unknown' });
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps a lost upload response unknown even if the remote side applied the bytes', async () => {
    let remote = 'base';
    registerLink();
    http.on('PUT', href, init => {
      remote = new TextDecoder().decode(init?.body as Uint8Array);
      throw new Error('response lost after commit');
    });
    expect(await storage.write(request())).toEqual({ status: 'unavailable', reason: 'network', outcome: 'unknown' });
    expect(remote).toBe(v1);
    expect(http.fetch).toHaveBeenCalledTimes(2);
  });
  it('accepts explicit createOnly false as ordinary write', async () => {
    registerLink();
    http.on('PUT', href, () => new Response(null, { status: 201 }));
    expect(await storage.write({ path: path, source: '', createOnly: false }))
      .toEqual({ status: 'written', revision: null });
  });

  it.each([null, 'true', 'false', 0, 1])('rejects invalid createOnly %j without effects', async createOnly => {
    expect(await storage.write({ path: path, source: '', createOnly: createOnly as unknown as boolean }))
      .toEqual({ status: 'invalid', reason: 'invalid-create-only' });
    expect(http.fetch).not.toHaveBeenCalled();
  });

});
