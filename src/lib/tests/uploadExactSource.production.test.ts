// @vitest-environment node
import { productionStorageContext,productionFileRequests } from './helpers/productionHttp';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createProductionHttp, productionOrigin as origin, productionCredentials, readAuthCookie } from './helpers/productionHttp';
import { productionUploadBody } from './helpers/uploadInputFixtures';
import { v1 } from './helpers/markdownReadFixtures';
let server: Awaited<ReturnType<typeof createProductionHttp>>;
let cookie: string;
beforeAll(async () => {
  server = await createProductionHttp();
  cookie = readAuthCookie(await server.request({ url: `${origin}/api/auth/login`, method: 'POST',
    headers: { 'X-Storage-Context': productionStorageContext, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(productionCredentials) }));
}, 90_000);
afterAll(async () => { await server?.close(); });
it.each([['LF', v1], ['CRLF', v1.replaceAll('\n', '\r\n')], ['mixed', v1.replace('\n', '\r\n')]])
  ('uploads exact %s Markdown bytes from a file part without multipart newline normalization', async (_name, source) => {
    await server.reset();
    const body = await productionUploadBody([['path', 'exact.md'],
      ['content', new Blob([source], { type: 'text/markdown' })], ['overwrite', 'false']]);
    const response = await server.request({ url: `${origin}/api/cloud/upload`, method: 'POST',
      headers: { 'X-Storage-Context': productionStorageContext, Origin: origin, Cookie: cookie, 'Content-Type': body.contentType }, body: body.body });
    expect(response.status).toBe(200);
    expect(response.effects.remote).toEqual({ 'md-cards/exact.md': source });
    expect(response.effects.writes).toEqual([{ path: 'md-cards/exact.md', source, overwrite: false }]);
  });
