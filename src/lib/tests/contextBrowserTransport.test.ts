import { afterEach, beforeEach, expect, it } from 'vitest';
import { BrowserCloudStorage } from '../adapters/browserCloudStorage';
import { mockHttp } from './helpers/http';

const descriptor = {
  id: 'backup',
  label: 'Dropbox',
  provider: 'dropbox',
  contextId: `ctx-v1-${'c'.repeat(64)}`,
  capabilities: { revisions: true, conditionalCreate: true, conditionalUpdate: true }
};
let http: ReturnType<typeof mockHttp>;
beforeEach(() => {
  http = mockHttp();
});

afterEach(() => http.assertHandled());

it('carries expected context and CAS revision and reads the acknowledged revision', async () => {
  http.on('POST', '/api/cloud/upload', init => {
    expect(new Headers(init?.headers).get('X-Storage-Context')).toBe(descriptor.contextId);
    expect(new Headers(init?.headers).get('X-Expected-Revision')).toBe('base');
    return new Response('OK', { headers: { 'X-Cloud-Revision': 'next' } });
  });
  expect(
    await new BrowserCloudStorage(descriptor).write({
      path: 'note.md',
      source: 'exact',
      expectedRevision: 'base'
    })
  ).toEqual({ status: 'written', revision: 'next' });
});

it('retains its captured context/capabilities despite mutations by callers', async () => {
  const mutable = structuredClone(descriptor);
  const cloud = new BrowserCloudStorage(mutable);
  expect(cloud.getCapabilities()).toEqual(descriptor.capabilities);
  mutable.contextId = 'changed';
  mutable.capabilities.conditionalUpdate = false;
  const caps = cloud.getCapabilities();
  caps.conditionalUpdate = false;
  http.on('POST', '/api/cloud/upload', init => {
    expect(new Headers(init?.headers).get('X-Storage-Context')).toBe(descriptor.contextId);
    return new Response('OK', { headers: { 'X-Cloud-Revision': 'new' } });
  });
  expect(cloud.getCapabilities().conditionalUpdate).toBe(true);
  expect(await cloud.write({ path: 'note.md', source: 'exact', expectedRevision: 'base' })).toEqual(
    { status: 'written', revision: 'new' }
  );
});

it('distinguishes context rejection from content conflict', async () => {
  http.on('POST', '/api/cloud/upload', () =>
    Response.json({ error: 'CLOUD_CONTEXT_MISMATCH', outcome: 'not-written' }, { status: 409 })
  );
  expect(
    await new BrowserCloudStorage(descriptor).write({ path: 'note.md', source: 'exact' })
  ).toEqual({ status: 'unavailable', reason: 'remote', outcome: 'not-written' });
});

it('carries the same context through preliminary listing and ordinary download', async () => {
  http.on('GET', '/api/cloud/files', init => {
    expect(new Headers(init?.headers).get('X-Storage-Context')).toBe(descriptor.contextId);
    return Response.json({ _embedded: { items: [{ name: 'note.md', path: 'note.md' }] } });
  });
  http.on('GET', '/api/cloud/download?path=note.md', init => {
    expect(new Headers(init?.headers).get('X-Storage-Context')).toBe(descriptor.contextId);
    return new Response('exact', { headers: { 'X-Cloud-Revision': 'base' } });
  });
  expect(await new BrowserCloudStorage(descriptor).read('note.md')).toEqual({
    status: 'found',
    document: { path: 'note.md', source: 'exact', revision: 'base' }
  });
});
