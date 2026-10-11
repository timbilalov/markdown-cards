import { expect } from 'vitest';
import type { mockHttp } from './http';

type Http = ReturnType<typeof mockHttp>;
type Responder = Parameters<Http['on']>[2];

export function adapterUploadUrl(fixtureApi: string): string {
  const url = new URL(fixtureApi);
  return `${url.origin}${url.pathname}?path=${encodeURIComponent(`disk:/${url.searchParams.get('path')}`)}&overwrite=${url.searchParams.get('overwrite')}`;
}

// The signed test URL is private to the server adapter. Exact payload bytes
// and outcomes are supplied by the caller; retired HTTP protocols are absent.
export function onCloudUpload(http: Http, fixtureApi: string, fixtureHref: string, respond: Responder): void {
  const href = `https://uploader1d.dst.yandex.net/upload-target/fixture?fixture=${encodeURIComponent(fixtureHref)}`;
  http.on('GET', adapterUploadUrl(fixtureApi), () => Response.json({ href, method: 'PUT', templated: false }));
  http.on('PUT', href, respond);
}

export function uploadLinkCalls(fixtureApi: string, token: string) {
  const headers = { Accept: 'application/json', Authorization: `OAuth ${token}` };
  return [
    [adapterUploadUrl(fixtureApi), { method: 'GET', signal: expect.any(AbortSignal), redirect: 'error', headers }]
  ];
}
