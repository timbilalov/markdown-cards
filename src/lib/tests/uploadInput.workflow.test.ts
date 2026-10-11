// @vitest-environment node
import { onCloudUpload, uploadLinkCalls } from './helpers/cloudUploadHttp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { runHandle } from './helpers/serverRequest';
import { mockHttp } from './helpers/http';
import { inputSource } from './helpers/requestBodyFixtures';
import { ambiguousUploadFields, existingFilename, initialUploadRemote, newFilename,
  unicodeFilename, unsafeUploadNames, uploadFields, uploadForm,
  uploadInputRequest, type UploadField } from './helpers/uploadInputFixtures';

vi.mock('$env/dynamic/private', () => ({ env: { CLOUD_STORAGE_PROVIDER: 'yandex', YANDEX_DISK_TOKEN: 'test-only-token', YANDEX_DISK_BASE_PATH: 'md-cards', SESSION_SECRET: 'aa'.repeat(32) } }));
vi.mock('../utils/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

let handle: typeof import('../../hooks.server')['handle'];
let upload: RequestHandler;
let sessions: typeof import('../server/session');
let http: ReturnType<typeof mockHttp>;
let parseMarkdown: ReturnType<typeof vi.spyOn>;
let openDatabase: ReturnType<typeof vi.spyOn>;
let remote: Map<string, string>;
let writes: { path: string; source: string; overwrite: boolean }[];

function serveWrite(filename: string, overwrite: boolean) {
  const path = `md-cards/${filename}`;
  const query = `?path=${encodeURIComponent(path)}&overwrite=${overwrite}`;
  const api = `https://cloud-api.yandex.net/v1/disk/resources/upload${query}`;
  const href = `https://upload.example.invalid/fields${query}`;
  onCloudUpload(http, api, href, async init => {
    if (!overwrite && remote.has(path)) return new Response(null, { status: 409 });
    const source = await new Response(init?.body).text();
    writes.push({ path, source, overwrite });
    remote.set(path, source);
    return new Response(null, { status: 201 });
  });
}

async function send(fields: readonly UploadField[]) {
  // Register the first-value write the current unsafe handler attempts. This
  // serves the observed old behavior, not an expected future validation result.
  // Native FormData normalizes line breaks in string fields before transmission.
  const form = uploadForm(fields);
  const firstPath = form.get('path');
  if (firstPath !== null) {
    const filename = String(firstPath).replace(/\r\n|\r|\n/g, '\r\n');
    serveWrite(filename, form.get('overwrite') === 'true');
  }
  const cookieValues = new Map([['auth_token', sessions.issueSession('test-user').token]]);
  const cookies = { get: (name: string) => cookieValues.get(name), set: vi.fn(), delete: vi.fn() };
  const request = uploadInputRequest(fields);
  const event = { request, url: new URL(request.url), cookies, locals: {}, params: {},
    route: { id: '/api/cloud/upload' }, getClientAddress: () => '127.0.0.1' } as unknown as RequestEvent;
  const response = await runHandle(handle, { event, resolve: current => Promise.resolve(upload(current)) });
  expect(cookies.set).not.toHaveBeenCalled();
  expect(cookies.delete).not.toHaveBeenCalled();
  return response;
}

async function expectRefusal(fields: readonly UploadField[], error: string) {
  const response = await send(fields);
  expect(response.status).toBe(400);
  expect(response.headers.get('Content-Type')).toContain('application/json');
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('Location')).toBeNull();
  expect(await response.json()).toEqual({ success: false, error });
  expect(parseMarkdown).not.toHaveBeenCalled();
  expect(http.fetch).not.toHaveBeenCalled();
  expect(writes).toEqual([]);
  expect(Object.fromEntries(remote)).toEqual(initialUploadRemote);
}

async function expectValidRetry(filename = unicodeFilename, overwrite: string | null = 'false') {
  const response = await send(uploadFields(filename, overwrite));
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await response.text()).toBe('File uploaded successfully');
  expect(parseMarkdown).toHaveBeenCalledExactlyOnceWith(inputSource);
  expect(writes).toEqual([{ path: `md-cards/${filename}`, source: inputSource, overwrite: overwrite === 'true' }]);
  expect(Object.fromEntries(remote)).toEqual({ ...initialUploadRemote, [`md-cards/${filename}`]: inputSource });
  expect(http.fetch).toHaveBeenCalledTimes(2);
  expect(uploadLinkCalls(
    `https://cloud-api.yandex.net/v1/disk/resources/upload?path=${encodeURIComponent(`md-cards/${filename}`)}&overwrite=${overwrite === 'true'}`,
    'test-only-token')).toContainEqual(http.fetch.mock.calls[0]);
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(1790812800000);
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('VITE_YANDEX_DISK_TOKEN', 'test-only-token');
  http = mockHttp();
  remote = new Map(Object.entries(initialUploadRemote));
  writes = [];
  parseMarkdown = vi.spyOn(await import('../domain/markdown'), 'parseMarkdownDocument');
  sessions = await import('../server/session');
  handle = (await import('../../hooks.server')).handle;
  const handler = (await import('../../routes/api/cloud/upload/+server')).POST;
  upload = current => handler({ ...current, params: {}, route: { id: '/api/cloud/upload' } });
  openDatabase = vi.spyOn(indexedDB, 'open');
});
afterEach(() => {
  http.assertHandled();
  expect(openDatabase).not.toHaveBeenCalled();
});

describe('upload validates the received filename before Markdown and cloud work', () => {
  it.each(unsafeUploadNames)('refuses %s without rewriting the filename', async (_name, filename) => {
    await expectRefusal(uploadFields(filename), 'CLOUD_INVALID_PATH');
    await expectValidRetry();
  });

  it('refuses a file-valued path instead of coercing File to a string', async () => {
    const fields: UploadField[] = [['path', new Blob(['private path'])], ['content', inputSource], ['overwrite', 'true']];
    await expectRefusal(fields, 'CLOUD_INVALID_PATH');
    await expectValidRetry(existingFilename, 'true');
  });

  it('rejects the unsafe filename before decoding an invalid Card ID and still accepts filename new.md', async () => {
    const invalidId = inputSource.replace('\r\ntest-card\r\n', '\r\n../unsafe-card\r\n');
    expect(invalidId).not.toBe(inputSource);
    await expectRefusal(uploadFields('../outside.md', 'true', invalidId), 'CLOUD_INVALID_PATH');
    // Card ID remains test-card. The reserved editor alias is not a filename rule.
    await expectValidRetry('new.md', null);
  });
});

describe('upload field cardinality and allowed keys', () => {
  it.each(ambiguousUploadFields)('refuses duplicate fields: $name', async ({ fields }) => {
    await expectRefusal(fields, 'INVALID_UPLOAD_FIELDS');
    await expectValidRetry(existingFilename, 'true');
  });

  it.each(['token', 'root', 'provider', '_csrf', 'Path', '__proto__', ''])
    ('refuses the unexpected field %j instead of silently ignoring it', async name => {
      await expectRefusal([...uploadFields(), [name, 'untrusted-extra-value']], 'INVALID_UPLOAD_FIELDS');
      await expectValidRetry(newFilename, null);
    });

  it.each(['path', 'content'])('returns private JSON for the missing required %s field', async name => {
    await expectRefusal(uploadFields().filter(([key]) => key !== name), 'INVALID_UPLOAD_FIELDS');
    await expectValidRetry();
  });

  it('refuses an unexpected file-valued field instead of ignoring the attachment', async () => {
    await expectRefusal([...uploadFields(), ['attachment', new Blob(['private extra file'])]], 'INVALID_UPLOAD_FIELDS');
    await expectValidRetry();
  });

  it('returns private JSON for empty content without parsing Markdown', async () => {
    await expectRefusal(uploadFields(newFilename, 'false', ''), 'INVALID_MARKDOWN_CONTENT');
    await expectValidRetry();
  });
});

describe('overwrite is optional or exactly one textual true/false value', () => {
  it.each(['', 'TRUE', 'False', '1', '0', 'yes', ' false ', 'null'])
    ('refuses overwrite=%j without silently turning the operation into create', async value => {
      await expectRefusal(uploadFields(newFilename, value), 'INVALID_UPLOAD_FIELDS');
      await expectValidRetry(newFilename, null);
    });

  it('refuses file-valued overwrite without silently turning the operation into create', async () => {
    await expectRefusal([...uploadFields(newFilename, null), ['overwrite', new Blob(['true'])]], 'INVALID_UPLOAD_FIELDS');
    await expectValidRetry(existingFilename, 'true');
  });
});
