import type { BrowserContext, Route } from '@playwright/test';
import { extname } from 'node:path';
import type {
  createProductionHttp,
  ProductionResponse
} from '../../src/lib/tests/helpers/productionHttp';
import { productionOrigin as origin } from '../../src/lib/tests/helpers/productionHttp';

const mime: Record<string, string> = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.json': 'application/json'
};

export async function serveProduction(
  context: BrowserContext,
  server: Awaited<ReturnType<typeof createProductionHttp>>,
  options: {
    offline?: () => boolean;
    beforeResponse?: (route: Route, response: ProductionResponse) => Promise<boolean | void>;
  } = {}
) {
  const assets = new Set((await server.readClientAssets()).map(asset => asset.path));
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || options.offline?.()) {
      await route.abort();
      return;
    }
    const path = decodeURIComponent(url.pathname.slice(1));
    if (assets.has(path)) {
      await route.fulfill({
        body: Buffer.from(await server.readClientAssetBytes(path)),
        contentType: mime[extname(path)] ?? 'application/octet-stream'
      });
      return;
    }
    const response = await server.request({
      url: url.href,
      method: request.method(),
      headers: await request.allHeaders(),
      bodyBytes: request.postDataBuffer() ? [...request.postDataBuffer()!] : undefined
    });
    if ((await options.beforeResponse?.(route, response)) === false) {
      await route.abort();
      return;
    }
    const headers = { ...response.headers };
    if (response.cookies.length) headers['set-cookie'] = response.cookies.join('\n');
    await route.fulfill({ status: response.status, headers, body: response.text }).catch(() => {
      if (!request.frame().page().isClosed())
        throw new Error('Unexpected response delivery failure');
    });
  });
}
