// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createProductionHttp, productionLegacyClientToken, productionPrivateCloudToken,
  productionPasswordHash, productionSessionSecret
} from './helpers/productionHttp';

let production: Awaited<ReturnType<typeof createProductionHttp>> | undefined;
beforeAll(async () => { production = await createProductionHttp(); }, 90_000);
afterAll(async () => { await production?.close(); });

it('emits public assets without private/public test secrets or provider OAuth transport', async () => {
  const assets = await production!.readClientAssets();
  expect(assets.filter(asset => asset.path.endsWith('.js')).length).toBeGreaterThan(0);
  // Prove this is the application's client output, not an empty/wrong folder.
  expect(assets.some(asset => asset.content.includes('/api/storages'))).toBe(true);
  const forbidden = [productionLegacyClientToken, productionPrivateCloudToken,
    productionPasswordHash, productionSessionSecret, 'VITE_YANDEX_DISK_TOKEN',
    'cloud-api.yandex.net', 'OAuth '];
  const leaks = assets.flatMap(asset => forbidden
    .filter(marker => asset.content.includes(marker))
    .map(marker => ({ path: asset.path, marker })));
  expect(leaks, 'Every generated public asset must be free of cloud credentials and direct OAuth').toEqual([]);
});
