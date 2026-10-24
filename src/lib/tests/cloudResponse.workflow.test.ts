import { mockStorageIdentity, fixtureStorageContext, fileRequests } from './helpers/storageIdentityHttp';
import { installWebLocks } from './helpers/webLocks';
import { readUploadContent } from './helpers/uploadContent';
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { mockHttp } from './helpers/http';
import { runHandle } from './helpers/serverRequest';
import legacy from './fixtures/migration-legacy.md?raw';
import v1 from './fixtures/v1-minimal.md?raw';
import {
  linkResponseUrl, padResponse, phaseText, responseBudgets, responsePath, responsePhases,
  responseSource, setupResponsePhase, uploadHref, uploadLink, type ResponsePhase
} from './helpers/cloudResponseFixtures';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$env/dynamic/private', () => ({ env: {
  SESSION_SECRET: 'ab'.repeat(32), CLOUD_STORAGE_ACTIVE: 'yandex', CLOUD_STORAGES: JSON.stringify([{ id: 'yandex', label: 'Яндекс Диск', provider: 'yandex', accessToken: 'response-private-test-token', rootPath: 'response-notes' }])
} }));
vi.mock('../utils/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const origin = 'https://app.example.invalid';
let http: ReturnType<typeof mockHttp>;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(Date.parse('2026-10-02T12:00:00Z'));
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('navigator', { onLine: true });
  installWebLocks(); http = mockHttp({ authenticated: true }); mockStorageIdentity(http, 'response-notes');
});
afterEach(() => { http.assertHandled(); });

async function invokeRoute(path: string, handler: RequestHandler, init?: RequestInit): Promise<Response> {
  const { handle } = await import('../../hooks.server');
  const { issueSession } = await import('../server/session');
  const token = issueSession('test-user').token;
  const headers=new Headers(init?.headers); headers.set('X-Storage-Context',fixtureStorageContext('response-notes'));
  const request = new Request(`${origin}${path}`, {...init,headers});
  const event = { request, url: new URL(request.url), params: {}, locals: {},
    route: { id: path.split('?')[0] },
    cookies: { get: (name: string) => name === 'auth_token' ? token : undefined, set: vi.fn() },
    getClientAddress: () => '127.0.0.1' } as unknown as RequestEvent;
  const open = vi.spyOn(indexedDB, 'open');
  try {
    const response = await runHandle(handle, { event, resolve: current => Promise.resolve(handler(current)) });
    expect(open).not.toHaveBeenCalled();
    expect(event.cookies.set).not.toHaveBeenCalled();
    return response;
  } finally { open.mockRestore(); }
}

async function routeForPhase(kind: ResponsePhase): Promise<Response> {
  if (kind === 'list') {
    const { GET } = await import('../../routes/api/cloud/files/+server');
    return invokeRoute('/api/cloud/files', GET as RequestHandler);
  }
  if (kind === 'write-link' || kind === 'create-link') {
    const { POST } = await import('../../routes/api/cloud/upload/+server');
    const form = new FormData();
    form.set('path', responsePath); form.set('content', v1); form.set('overwrite', String(kind !== 'create-link'));
    return invokeRoute('/api/cloud/upload', POST as RequestHandler,
      { method: 'POST', headers: { Origin: origin }, body: form });
  }
  const { GET } = await import('../../routes/api/cloud/download/+server');
  return invokeRoute(`/api/cloud/download?path=${responsePath}`, GET as RequestHandler);
}

describe('real middleware/routes preserve provider body-limit failures', () => {
  it.each(responsePhases)('$name maps to a private 502 without partial success, writes or database access', async ({ kind, budget }) => {
    setupResponsePhase(http, kind, () => new Response(padResponse(phaseText(kind), budget + 1)));
    const response = await routeForPhase(kind);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ success: false, error: 'CLOUD_INVALID_RESPONSE',
      ...(['write-link', 'create-link'].includes(kind) ? { outcome: 'not-written' } : {}) });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(http.fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);

    setupResponsePhase(http, kind, () => new Response(phaseText(kind)));
    const retry = await routeForPhase(kind);
    expect(retry.status).toBe(200);
    expect(retry.headers.get('Cache-Control')).toBe('private, no-store');
    if (kind === 'source' || kind === 'redirect-source' || kind === 'read-link') {
      // Native Response.text strips the UTF-8 BOM; compare bytes instead.
      expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(await retry.arrayBuffer())).toBe(responseSource);
    }
  });
});

describe('Save keeps a durable local snapshot when the provider upload-link body is rejected', () => {
  it.each(['new', 'migrated'] as const)('keeps the %s document and retries through the same write contract', async kind => {
    http.on('GET', '/api/cloud/files', () => Response.json({ _embedded: { items: [] } }));
    const cards = await import('../stores/cardStore');
    const { dbService: db } = await import('../services/dbService');
    await (await import('../stores/cloudStore')).checkIsSessionAuthenticated();
    let filename: string;
    if (kind === 'new') {
      cards.openNewCard();
      filename = get(cards.cardStore)!.meta.id;
    } else {
      filename = 'note';
      http.on('GET', '/api/cloud/files', () => Response.json({ _embedded: { items: [{ name: 'note.md', path: 'note.md' }] } }));
      http.on('GET', '/api/cloud/download?path=note.md', () => new Response(legacy));
      await cards.loadCard(filename);
      expect(cards.migrateCurrentCardFormat().status).toBe('success');
    }
    const { POST } = await import('../../routes/api/cloud/upload/+server');
    let oversized = true;
    let remote: string | null = kind === 'new' ? null : legacy;
    let localSource: string | null = null;
    let uploadedSource: string | null = null;
    const statuses: number[] = [];
    const modes: string[] = [];
    const providerUrl = filename === 'note' ? linkResponseUrl('upload', kind === 'new')
      : `https://cloud-api.yandex.net/v1/disk/resources/upload?path=${encodeURIComponent(`disk:/response-notes/${filename}.md`)}&overwrite=${kind !== 'new'}`;
    http.on('GET', providerUrl, () => oversized
      ? new Response(padResponse(JSON.stringify(uploadLink), responseBudgets.link + 1)) : Response.json(uploadLink));
    http.on('PUT', uploadHref, init => {
      remote = new TextDecoder('utf-8', { ignoreBOM: true }).decode(init?.body as Uint8Array);
      return new Response(null, { status: 201 });
    });
    http.on('POST', '/api/cloud/upload', async init => {
      const form = init?.body as FormData;
      localSource = await readUploadContent(form);
      // The file part must retain the exact local snapshot through multipart encoding.
      const wireRequest = new Request(`${origin}/api/cloud/upload`, { ...init, headers: { Origin: origin } });
      uploadedSource = await readUploadContent(await wireRequest.formData());
      modes.push(String(form.get('overwrite')));
      const response = await invokeRoute('/api/cloud/upload', POST as RequestHandler,
        { ...init, headers: { Origin: origin } });
      statuses.push(response.status);
      return response;
    });

    await cards.saveCard(filename, get(cards.cardStore)!);
    expect(statuses).toEqual([502]);
    expect(await db.getLocalMarkdownSnapshot(filename)).toMatchObject({ filename,
      saveMode: kind === 'new' ? 'create' : 'update', source: localSource });
    expect(remote).toBe(kind === 'new' ? null : legacy);
    expect(get(cards.cardSaveMessage)).toBeNull();
    expect(get(cards.cardSaveError)).toMatch(/локально.*не в облаке/i);
    expect(http.fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);

    oversized = false;
    await cards.saveCard(filename, get(cards.cardStore)!);
    expect(statuses).toEqual([502, 200]);
    expect(modes).toEqual([kind === 'new' ? 'false' : 'true', kind === 'new' ? 'false' : 'true']);
    expect(remote).toBe(uploadedSource);
    expect(await db.getLocalMarkdownSnapshot(filename)).toBeNull();
    expect(get(cards.cardSaveError)).toBeNull();
    expect(get(cards.cardDocument)).toMatchObject({ saveMode: 'update' });
  });
});
