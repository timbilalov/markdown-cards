import { beforeEach, afterEach, expect, it } from 'vitest';
import { BrowserCloudStorage } from '../adapters/browserCloudStorage';
import { mockHttp } from './helpers/http';

const descriptor = {
  id: 'reserve',
  label: 'Reserve',
  provider: 'dropbox',
  contextId: `ctx-v1-${'a'.repeat(64)}`,
  capabilities: { revisions: true, conditionalCreate: true, conditionalUpdate: true }
};
let http: ReturnType<typeof mockHttp>;
beforeEach(() => {
  http = mockHttp();
  http.on('GET', '/api/cloud/files', () =>
    Response.json({ _embedded: { items: [{ name: 'wrong.md', path: 'wrong.md' }] } })
  );
  http.on(
    'GET',
    '/api/cloud/download?path=note.md',
    () => new Response('wrong', { headers: { 'X-Cloud-Revision': 'wrong' } })
  );
  http.on('GET', '/api/storages/reserve/files', () =>
    Response.json({
      _embedded: {
        items: [
          {
            name: 'note.md',
            path: 'note.md',
            revision: 'base',
            modified: '2026-10-19T00:00:00.000Z'
          }
        ]
      }
    })
  );
  http.on(
    'GET',
    '/api/storages/reserve/download?path=note.md',
    () => new Response('reserve', { headers: { 'X-Cloud-Revision': 'base' } })
  );
});

afterEach(() => http.assertHandled());

it('keeps revisions and metadata on the selected management listing', async () => {
  expect(await new BrowserCloudStorage(descriptor, '/api/storages/reserve').list()).toEqual({
    status: 'success',
    entries: [
      { path: 'note.md', revision: 'base', modifiedAt: Date.parse('2026-10-19T00:00:00.000Z') }
    ]
  });
});

it('reads through the selected management path and context', async () => {
  expect(
    await new BrowserCloudStorage(descriptor, '/api/storages/reserve').readListed('note.md')
  ).toEqual({
    status: 'found',
    document: { path: 'note.md', source: 'reserve', revision: 'base' }
  });
  expect(http.fetch.mock.calls[0][1]).toMatchObject({
    headers: { 'X-Storage-Context': descriptor.contextId }
  });
});
