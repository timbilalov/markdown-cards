// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { productionCredentials } from './helpers/productionHttp';
vi.mock('$env/dynamic/private', async () => {
  const { productionCredentials, productionPasswordHash } = await import('./helpers/productionHttp');
  return { env: { ADMIN_USERNAME: productionCredentials.username, ADMIN_PASSWORD_HASH: productionPasswordHash } };
});
it('authenticates using the private deployment environment', async () => {
  const { validateCredentials } = await import('../server/auth');
  expect(await validateCredentials(productionCredentials.username, productionCredentials.password)).toBe(true);
});
