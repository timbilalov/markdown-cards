import { vi } from 'vitest';
import { YandexDiskAdapter } from '../../server/cloud/yandexDiskAdapter';
import { mockHttp } from './http';

// Proposed application budgets, deliberately independent of runtime constants.
export const responseBudgets = { link: 64 * 1024, page: 1024 * 1024,
  source: 1024 * 1024, listing: 8 * 1024 * 1024, pages: 100 };
export const responseRoot = 'response-notes';
export const responsePath = 'note.md';
export const responseSource = '\uFEFF# Заметка 😀\r\n\r\nТочный исходник.\r\n';
export const resourcesUrl = 'https://cloud-api.yandex.net/v1/disk/resources';
export const downloadHref = 'https://downloader.disk.yandex.ru/disk/response-test?signature=synthetic';
export const storageHref = 'https://test.storage.yandex.net/response-test?signature=synthetic';
export const uploadHref = 'https://uploader01.dst.yandex.net/upload-target/response-test?signature=synthetic';
export const downloadLink = { method: 'GET', templated: false, href: downloadHref };
export const uploadLink = { method: 'PUT', templated: false, href: uploadHref };

export function listResponseUrl(offset = 0, limit = 100): string {
  return `${resourcesUrl}?path=${encodeURIComponent(`disk:/${responseRoot}`)}&limit=${limit}&offset=${offset}&sort=name`;
}

export function linkResponseUrl(kind: 'download' | 'upload', createOnly = false): string {
  return `${resourcesUrl}/${kind}?path=${encodeURIComponent(`disk:/${responseRoot}/${responsePath}`)}`
    + (kind === 'upload' ? `&overwrite=${!createOnly}` : '');
}

export function diskResource(name = responsePath, type = 'file') {
  return { name, type, path: `disk:/${responseRoot}/${name}` };
}

export function diskPage(items = [diskResource()], offset = 0,
  total: number | undefined = items.length, limit = 100) {
  const path = `disk:/${responseRoot}`;
  return { type: 'dir', path, _embedded: { path, items, offset, limit, total },
    providerNote: 'Дополнительные поля 😀 и текст "href": остаются допустимыми.' };
}

export function responseBytes(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

export function padResponse(text: string, size: number): Uint8Array<ArrayBuffer> {
  const bytes = responseBytes(text);
  if (bytes.length > size) throw new Error('Fixture exceeds its intended budget');
  const padded = new Uint8Array(size).fill(0x20);
  padded.set(bytes);
  return padded;
}

// highWaterMark: 0 makes cancellation observable without speculative prefetch.
// One final chunk remains unread when a byte guard stops at the preceding chunk.
export function streamedResponse(chunks: Uint8Array<ArrayBuffer>[], headers?: HeadersInit,
  cancellation: 'resolve' | 'reject' | 'pending' = 'resolve') {
  let index = 0;
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (index < chunks.length) controller.enqueue(chunks[index++]);
    else controller.close();
  });
  const cancel = vi.fn(() => {
    if (cancellation === 'reject') return Promise.reject(new Error('Synthetic cancellation failure'));
    if (cancellation === 'pending') return new Promise<void>(() => {});
  });
  const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  return { response: new Response(body, { headers }), pull, cancel };
}

export const responsePhases = [
  { name: 'list page', kind: 'list', budget: responseBudgets.page },
  { name: 'download link', kind: 'read-link', budget: responseBudgets.link },
  { name: 'upsert link', kind: 'write-link', budget: responseBudgets.link },
  { name: 'create-only link', kind: 'create-link', budget: responseBudgets.link },
  { name: 'direct source', kind: 'source', budget: responseBudgets.source },
  { name: 'redirected source', kind: 'redirect-source', budget: responseBudgets.source }
] as const;
export type ResponsePhase = typeof responsePhases[number]['kind'];

export function phaseText(kind: ResponsePhase): string {
  if (kind === 'list') return JSON.stringify(diskPage());
  if (kind === 'read-link') return JSON.stringify({ ...downloadLink, providerNote: 'Текст 😀' });
  if (kind === 'write-link' || kind === 'create-link') {
    return JSON.stringify({ ...uploadLink, providerNote: 'Текст 😀' });
  }
  return responseSource;
}

export function phaseFailure(kind: ResponsePhase) {
  return { status: 'unavailable', reason: 'invalid-response',
    ...(['write-link', 'create-link'].includes(kind) ? { outcome: 'not-written' } : {}) };
}

export function phaseSuccess(kind: ResponsePhase, source = responseSource) {
  if (kind === 'list') return { status: 'success', entries: [{ path: responsePath, revision: null }] };
  if (kind === 'write-link' || kind === 'create-link') return { status: 'written', revision: null };
  return { status: 'found', document: { path: responsePath, source, revision: null } };
}

export function setupResponsePhase(http: ReturnType<typeof mockHttp>, kind: ResponsePhase,
  respond: () => Response, href?: string) {
  const adapter = new YandexDiskAdapter({ accessToken: 'response-private-test-token', rootPath: responseRoot });
  const download = href ?? downloadHref;
  const upload = href ?? uploadHref;
  http.on('GET', listResponseUrl(), kind === 'list' ? respond : () => Response.json(diskPage()));
  http.on('GET', linkResponseUrl('download'), kind === 'read-link' ? respond : () => Response.json(downloadLink));
  http.on('GET', download, kind === 'source' ? respond : kind === 'redirect-source'
    ? () => new Response(null, { status: 302, headers: { Location: storageHref } })
    : () => new Response(responseBytes(responseSource)));
  http.on('GET', storageHref, kind === 'redirect-source' ? respond : () => new Response(responseBytes(responseSource)));
  http.on('GET', linkResponseUrl('upload', kind === 'create-link'),
    kind === 'write-link' || kind === 'create-link' ? respond : () => Response.json(uploadLink));
  // Register the current implementation's follow-up too: RED is an assertion,
  // never an unhandled network mock masquerading as rejection of provider input.
  http.on('PUT', upload, () => new Response(null, { status: 201 }));
  return () => kind === 'list' ? adapter.list()
    : kind === 'write-link' || kind === 'create-link'
      ? adapter.write({ path: responsePath, source: responseSource, ...(kind === 'create-link' ? { createOnly: true } : {}) })
      : adapter.read(responsePath);
}
