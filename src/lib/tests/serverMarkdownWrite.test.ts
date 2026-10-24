import { configuredCloudLocals, yandexEnvironment } from './helpers/configuredCloud';
// @vitest-environment node
import { onCloudUpload, uploadLinkCalls } from './helpers/cloudUploadHttp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { mockHttp } from './helpers/http';
import { rejectedMarkdown, v1 } from './helpers/markdownReadFixtures';
import legacy from './fixtures/migration-legacy.md?raw';

vi.mock('$env/dynamic/private', () => ({ env: { CLOUD_STORAGE_ACTIVE: 'yandex', CLOUD_STORAGES: JSON.stringify([{ id: 'yandex', label: 'Яндекс Диск', provider: 'yandex', accessToken: 'test-only-token', rootPath: 'md-cards' }]) } }));

const existingFilename = 'renamed-note.md'; // Deliberately differs from meta.id.
const originalSource = 'Existing remote source — keep it intact';
// Multipart text fields normalize line endings. Check the received CRLF source
// byte for byte, so parsing/serialization cannot silently canonicalize it to LF.
const exactV1 = v1.replace(/\r?\n/g, '\r\n');
const refusalByName: Record<string, { status: number; error: string; reason: string }> = {
  'unmigrated legacy': { status: 422, error: 'MARKDOWN_UNSUPPORTED', reason: 'missing-version' },
  'future version': { status: 422, error: 'MARKDOWN_UNSUPPORTED', reason: 'unknown-version' },
  'unknown metadata': { status: 422, error: 'MARKDOWN_UNSUPPORTED', reason: 'unsupported-content' },
  'malformed version marker': { status: 400, error: 'MARKDOWN_INVALID', reason: 'invalid-version' },
  'invalid timestamp': { status: 400, error: 'MARKDOWN_INVALID', reason: 'invalid-timestamp' },
  'unsafe ID': { status: 400, error: 'MARKDOWN_INVALID', reason: 'invalid-id' }
};

let http: ReturnType<typeof mockHttp>;
let remote: Map<string, string>;
let uploads: { filename: string; source: string; overwrite: boolean }[];

function event(request: Request): RequestEvent {
  // Only SvelteKit request plumbing is substituted; handlers/services stay real.
  return {
    request, url: new URL(request.url), params: {}, locals: configuredCloudLocals(yandexEnvironment('test-only-token', 'md-cards')),
    getClientAddress: () => '127.0.0.1'
  } as unknown as RequestEvent;
}

function uploadRequest(content: string | Blob, overwrite = true): Request {
  const form = new FormData();
  form.set('path', existingFilename);
  form.set('content', content);
  form.set('overwrite', String(overwrite));
  return new Request('https://app.example.invalid/api/cloud/upload', { method: 'POST', body: form });
}

async function upload(content: string | Blob, overwrite = true) {
  const { POST } = await import('../../routes/api/cloud/upload/+server');
  return POST({ ...event(uploadRequest(content, overwrite)), params: {}, route: { id: '/api/cloud/upload' } });
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_YANDEX_DISK_TOKEN', 'test-only-token');
  http = mockHttp();
  remote = new Map([[existingFilename, originalSource]]);
  uploads = [];
  // Register the writes that the old handlers actually attempt. RED must expose
  // unwanted successful writes, not an unhandled mock URL or a retry timeout.
  for (const filename of [existingFilename, 'test-card.md']) {
    for (const overwrite of [true, false]) {
      const apiUrl = 'https://cloud-api.yandex.net/v1/disk/resources/upload'
        + `?path=${encodeURIComponent(`md-cards/${filename}`)}&overwrite=${overwrite}`;
      const href = `https://upload.example.invalid/${filename}?overwrite=${overwrite}`;
      onCloudUpload(http, apiUrl, href, async init => {
        const source = await new Response(init?.body).text();
        uploads.push({ filename, source, overwrite });
        remote.set(filename, source);
        return new Response(null, { status: 201 });
      });
    }
  }
});

afterEach(() => http.assertHandled());

describe('Server upload validates the complete Markdown before transport', () => {
  it.each(rejectedMarkdown)('refuses %s without asking for an upload URL or changing the remote', async (name, source) => {
    const expected = refusalByName[name];
    const response = await upload(source);

    expect(response.status).toBe(expected.status);
    expect(await response.json()).toEqual({ success: false, error: expected.error, reason: expected.reason });
    expect(http.fetch).not.toHaveBeenCalled();
    expect(uploads).toEqual([]);
    expect([...remote]).toEqual([[existingFilename, originalSource]]);
  });

  it('refuses a non-Markdown file part even when it contains valid v1', async () => {
    const response = await upload(new Blob([exactV1], { type: 'application/octet-stream' }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: 'INVALID_MARKDOWN_CONTENT' });
    expect(http.fetch).not.toHaveBeenCalled();
    expect(uploads).toEqual([]);
    expect([...remote]).toEqual([[existingFilename, originalSource]]);
  });

  it.each([true, false])('can save exact v1 after refusing legacy, preserving overwrite=%s and filename', async overwrite => {
    if (!overwrite) remote.clear(); // The creation destination initially does not exist.
    const refused = await upload(legacy, overwrite);
    const callsAfterRefusal = http.fetch.mock.calls.length;
    const remoteAfterRefusal = [...remote];
    const accepted = await upload(exactV1, overwrite);

    expect([refused.status, accepted.status]).toEqual([422, 200]);
    expect(await refused.json()).toEqual({ success: false, error: 'MARKDOWN_UNSUPPORTED', reason: 'missing-version' });
    expect(callsAfterRefusal).toBe(0);
    expect(remoteAfterRefusal).toEqual(overwrite ? [[existingFilename, originalSource]] : []);
    expect(http.fetch).toHaveBeenCalledTimes(2); // One URL request and one PUT, only for v1.
    expect(uploadLinkCalls(
      'https://cloud-api.yandex.net/v1/disk/resources/upload'
        + `?path=${encodeURIComponent(`md-cards/${existingFilename}`)}&overwrite=${overwrite}`,
      'test-only-token')).toContainEqual(http.fetch.mock.calls[0]);
    expect(uploads).toEqual([{ filename: existingFilename, source: exactV1, overwrite }]);
    expect([...remote]).toEqual([[existingFilename, exactV1]]);
  });
});
