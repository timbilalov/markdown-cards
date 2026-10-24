// @vitest-environment node
import { productionStorageContext,productionFileRequests } from './helpers/productionHttp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createProductionHttp, productionCredentials, productionOrigin, readAuthCookie
} from './helpers/productionHttp';
import { padResponse, responseBudgets, responseSource } from './helpers/cloudResponseFixtures';

let server: Awaited<ReturnType<typeof createProductionHttp>> | undefined;
let cookie: string;
beforeAll(async () => {
  server = await createProductionHttp();
  const login = await server.request({ url: `${productionOrigin}/api/auth/login`, method: 'POST',
    headers: { 'X-Storage-Context': productionStorageContext, Origin: productionOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify(productionCredentials) });
  expect(login.status).toBe(200);
  cookie = readAuthCookie(login);
}, 90_000);
afterAll(async () => { await server?.close(); });

describe('provider source budget through the generated production entry', () => {
  it('returns a private gateway error for an oversized document and reads an exact-limit document unchanged on retry', async () => {
    const source = responseSource;
    const oversized = new TextDecoder('utf-8', { ignoreBOM: true })
      .decode(padResponse(source, responseBudgets.source + 1));
    await server!.reset({ 'md-cards/large.md': oversized });
    const request = { url: `${productionOrigin}/api/cloud/download?path=large.md`, headers: { 'X-Storage-Context': productionStorageContext, Cookie: cookie } };
    const refused = await server!.request(request);
    expect(refused.status).toBe(502);
    expect(JSON.parse(refused.text)).toEqual({ success: false, error: 'CLOUD_INVALID_RESPONSE' });
    expect(refused.headers['cache-control']).toBe('private, no-store');
    expect(refused.cookies).toEqual([]);
    expect(refused.effects.writes).toEqual([]);
    expect(refused.effects.unexpected).toEqual([]);
    expect(refused.effects.databaseOpens).toBe(0);
    expect(refused.effects.remote).toEqual({ 'md-cards/large.md': oversized });
    expect(productionFileRequests(refused)).toHaveLength(2);

    const exact = new TextDecoder('utf-8', { ignoreBOM: true })
      .decode(padResponse(source, responseBudgets.source));
    await server!.reset({ 'md-cards/large.md': exact });
    const recovered = await server!.request(request);
    expect(recovered.status).toBe(200);
    expect(recovered.text).toBe(exact);
    expect(recovered.headers['cache-control']).toBe('private, no-store');
    expect(recovered.effects.writes).toEqual([]);
    expect(recovered.effects.unexpected).toEqual([]);
    expect(recovered.effects.databaseOpens).toBe(0);
    expect(productionFileRequests(recovered)).toHaveLength(2);
  });
});
