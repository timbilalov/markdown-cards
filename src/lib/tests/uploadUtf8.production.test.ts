// @vitest-environment node
import { productionStorageContext,productionFileRequests } from './helpers/productionHttp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createProductionHttp, productionCredentials, productionOrigin as origin,
  readAuthCookie, type ProductionResponse
} from './helpers/productionHttp';
import { inputSource } from './helpers/requestBodyFixtures';

let server: Awaited<ReturnType<typeof createProductionHttp>> | undefined;
let cookie: string;
const boundary = 'upload-utf8-test';
const contentType = `multipart/form-data; boundary=${boundary}`;
const marker = 'RAW_UTF8_SENTINEL';
// A real U+FFFD is valid content. Malformed bytes must not select this filename.
const filename = 'existing-\uFFFD.md';
const initialRemote = { [`md-cards/${filename}`]: 'Original source must survive' };
const validSource = inputSource.replace('Первый абзац', '\uFFFD — Первый абзац');

function multipartBytes(path: string, content: string): Uint8Array {
  const body = Object.entries({ path, content, overwrite: 'true' }).map(([name, value]) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
  ).join('') + `--${boundary}--\r\n`;
  return new TextEncoder().encode(body);
}

function malformedBody(field: 'path' | 'content', invalidBytes: readonly number[]): Uint8Array {
  const bytes = Buffer.from(multipartBytes(
    field === 'path' ? `existing-${marker}.md` : filename,
    field === 'content' ? validSource.replace('Первый абзац', `${marker} Первый абзац`) : validSource
  ));
  const offset = bytes.indexOf(marker);
  expect(offset, 'The raw-byte fixture must replace the intended field value').toBeGreaterThan(-1);
  const body = Buffer.concat([bytes.subarray(0, offset), Buffer.from(invalidBytes),
    bytes.subarray(offset + marker.length)]);
  expect(() => new TextDecoder('utf-8', { fatal: true }).decode(body)).toThrow();
  return body;
}

beforeAll(async () => {
  server = await createProductionHttp();
  const login = await server.request({ url: `${origin}/api/auth/login`, method: 'POST',
    headers: { 'X-Storage-Context': productionStorageContext, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(productionCredentials) });
  expect(login.status).toBe(200);
  cookie = readAuthCookie(login);
}, 90_000);
beforeEach(async () => { await server!.reset(initialRemote); });
afterAll(async () => { await server?.close(); });

async function upload(body: Uint8Array, headers: Record<string, string> = {}) {
  return server!.request({ url: `${origin}/api/cloud/upload`, method: 'POST',
    headers: { 'X-Storage-Context': productionStorageContext, Origin: origin, Cookie: cookie, 'Content-Type': contentType, ...headers },
    bodyBytes: Array.from(body) });
}

function expectNoEffects(response: ProductionResponse) {
  expect(response.cookies).toEqual([]);
  expect(response.effects).toEqual({ requests: [], writes: [], remote: initialRemote, unexpected: [], databaseOpens: 0 });
}

describe('strict multipart UTF-8 through the generated production entry', () => {
  it.each([
    { name: 'invalid leading byte in content', field: 'content', bytes: [0xff] },
    { name: 'UTF-8 encoded lone surrogate in content', field: 'content', bytes: [0xed, 0xa0, 0x80] },
    { name: 'invalid leading byte in filename', field: 'path', bytes: [0xff] },
    { name: 'incomplete multibyte sequence in filename', field: 'path', bytes: [0xe2, 0x82] }
  ] as const)('refuses $name without repairing or overwriting a document', async ({ field, bytes }) => {
    const body = malformedBody(field, bytes);
    const signedOut = await upload(body, { Cookie: '', Origin: 'https://foreign.example.invalid' });
    expect(signedOut.status).toBe(401);
    expect(signedOut.bodyUsed).toBe(false);
    expectNoEffects(signedOut);
    const foreign = await upload(body, { Origin: 'https://foreign.example.invalid' });
    expect(foreign.status).toBe(403);
    expect(foreign.bodyUsed).toBe(false);
    expectNoEffects(foreign);

    const response = await upload(body);
    // Soft assertions let valid retry/read checks run even at the RED checkpoint.
    expect.soft(response.status).toBe(400);
    expect.soft(response.headers['content-type']).toContain('application/json');
    expect.soft(response.text).toBe(JSON.stringify({ success: false, error: 'INVALID_REQUEST_BODY' }));
    expect.soft({...response.effects,requests:productionFileRequests(response)}).toEqual({ requests: [], writes: [], remote: initialRemote, unexpected: [], databaseOpens: 0 });
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers.location).toBeUndefined();
    expect(response.cookies).toEqual([]);

    // Isolate recovery from an unsafe implementation's write on RED. This is
    // after checking that a refused request left the original fixture intact.
    await server!.reset(initialRemote);
    const retry = await upload(multipartBytes(filename, validSource));
    expect(retry.status).toBe(200);
    expect(retry.text).toBe('File uploaded successfully');
    expect(retry.effects.writes).toEqual([{ path: `md-cards/${filename}`, source: validSource, overwrite: true }]);
    expect(retry.effects.remote).toEqual({ [`md-cards/${filename}`]: validSource });
    expect(productionFileRequests(retry)).toHaveLength(2);
    expect(retry.effects.unexpected).toEqual([]);
    expect(retry.effects.databaseOpens).toBe(0);
    const read = await server!.request({ url: `${origin}/api/cloud/download?path=${encodeURIComponent(filename)}`,
      headers: { 'X-Storage-Context': productionStorageContext, Cookie: cookie } });
    expect(read.status).toBe(200);
    expect(read.text).toBe(validSource);
    expect(read.effects.writes).toEqual(retry.effects.writes);
    expect(read.effects.unexpected).toEqual([]);
    expect(read.effects.databaseOpens).toBe(0);
  });
});
