import { afterEach, expect, it } from 'vitest';
import { MemoryCloudStorage } from './helpers/memoryCloudStorage';
import { BrowserCloudStorage } from '../adapters/browserCloudStorage';
import { YandexDiskAdapter } from '../server/cloud/yandexDiskAdapter';
import { mockHttp } from './helpers/http';

const http = () => mockHttp();
let boundary: ReturnType<typeof http>;
afterEach(() => boundary?.assertHandled());

it.each([
  () => new YandexDiskAdapter({ accessToken: 'token', rootPath: 'Notes' }),
  () => new BrowserCloudStorage(),
  () => new MemoryCloudStorage()
])('refuses unsupported conditional updates without an unconditional write', async factory => {
  boundary = http();
  expect(
    await factory().write({ path: 'note.md', source: 'new', expectedRevision: 'old' })
  ).toEqual({ status: 'unsupported', operation: 'conditional-update' });
  expect(boundary.fetch).not.toHaveBeenCalled();
});

it('checks revisions atomically when Memory advertises conditional updates', async () => {
  const storage = new MemoryCloudStorage({
    capabilities: { revisions: true, conditionalCreate: true, conditionalUpdate: true },
    documents: [{ path: 'note.md', source: 'before', revision: 'base' }]
  });
  expect(
    await storage.write({ path: 'note.md', source: 'new', expectedRevision: 'other' })
  ).toEqual({ status: 'conflict' });
  expect(await storage.read('note.md')).toEqual({
    status: 'found',
    document: { path: 'note.md', source: 'before', revision: 'base' }
  });
  expect(
    await storage.write({ path: 'note.md', source: 'new', expectedRevision: 'base' })
  ).toMatchObject({ status: 'written' });
  expect(
    await storage.write({ path: 'missing.md', source: 'new', expectedRevision: 'base' })
  ).toEqual({ status: 'conflict' });
});
