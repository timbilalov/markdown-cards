// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { MemoryCloudStorage } from './helpers/memoryCloudStorage';
import { POST } from '../../routes/api/storages/[storageId]/copy/+server';
import { copyCloudNote } from '../adapters/manualCloudCopy';

const source = '\uFEFF<!-- markdown-cards: 99 -->\r\nKEEP\r\n';

const descriptor = {
  id: 'backup',
  provider: 'dropbox',
  label: 'Backup',
  contextId: `ctx-v1-${'a'.repeat(64)}`,
  capabilities: { revisions: true, conditionalCreate: true, conditionalUpdate: true }
};

function memory(text: string | null = 'previous') {
  return new MemoryCloudStorage({
    documents: text === null ? [] : [{ path: 'note.md', source: text, revision: 'base' }],
    capabilities: descriptor.capabilities
  });
}

async function request(
  storage: MemoryCloudStorage,
  headers: Record<string, string> = {},
  body = source,
  path = 'note.md'
) {
  const url = new URL(
    `https://app.invalid/api/storages/backup/copy?path=${encodeURIComponent(path)}`
  );
  return POST({
    url,
    request: new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/markdown;charset=utf-8', ...headers },
      body: new TextEncoder().encode(body)
    }),
    locals: { cloudStorage: storage }
  } as unknown as Parameters<typeof POST>[0]);
}

const expected = {
  'X-Expected-Source-Hash': createHash('sha256').update('previous').digest('hex'),
  'X-Expected-Revision': 'base'
};
it('copies unsupported raw text exactly through the management endpoint with CAS', async () => {
  const storage = memory();
  const write = vi.spyOn(storage, 'write');
  const response = await request(storage, expected);
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({ status: 'written' });
  expect(write).toHaveBeenCalledWith({
    path: 'note.md',
    source,
    createOnly: false,
    expectedRevision: 'base'
  });
  expect(await storage.read('note.md')).toMatchObject({ document: { source } });
});

it.each(['changed', 'missing', 'revision'] as const)(
  'refuses a %s destination at the server boundary',
  async kind => {
    const storage = memory(kind === 'missing' ? null : kind === 'changed' ? 'changed' : 'previous');
    if (kind === 'revision') await storage.write({ path: 'note.md', source: 'previous' });
    const write = vi.spyOn(storage, 'write');
    const response = await request(storage, expected);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ status: 'conflict' });
    expect(write).not.toHaveBeenCalled();
  }
);

it('creates empty raw text only when absence is confirmed', async () => {
  const storage = memory(null);
  expect(await (await request(storage, { 'X-Create-Only': 'true' }, ''))?.json()).toMatchObject({
    status: 'written'
  });
  expect(await storage.read('note.md')).toMatchObject({ document: { source: '' } });
  expect(await (await request(storage, { 'X-Create-Only': 'true' }))?.json()).toEqual({
    status: 'conflict'
  });
});

it.each([
  [{}, 'note.md'],
  [{ 'X-Create-Only': 'true', ...expected }, 'note.md'],
  [{ 'X-Expected-Source-Hash': 'bad' }, 'note.md'],
  [expected, '../outside.md']
] as const)(
  'rejects invalid preconditions/path before provider I/O (%j)',
  async (headers, path) => {
    const storage = memory();
    const read = vi.spyOn(storage, 'read');
    const write = vi.spyOn(storage, 'write');
    expect((await request(storage, headers, source, path))?.status).toBe(400);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  }
);

it('bounds a raw request before any file I/O', async () => {
  const storage = memory();
  const read = vi.spyOn(storage, 'read');
  expect((await request(storage, expected, 'a'.repeat(1024 * 1024 + 1)))?.status).toBe(413);
  expect(read).not.toHaveBeenCalled();
});

it('preserves an unknown write outcome instead of returning a known rejection', async () => {
  const storage = memory();
  vi.spyOn(storage, 'write').mockRejectedValue(new Error('lost acknowledgement'));
  expect(await (await request(storage, expected))?.json()).toEqual({
    status: 'unavailable',
    reason: 'network',
    outcome: 'unknown'
  });
});

it('sends exact UTF8 bytes, bound context and captured preconditions from the browser', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ status: 'written', revision: 'next' })
  );
  vi.stubGlobal('fetch', fetch);
  expect(
    await copyCloudNote(descriptor, {
      path: 'note.md',
      source,
      expectedTarget: { status: 'present', source: 'previous', revision: 'base' }
    })
  ).toEqual({ status: 'written', revision: 'next' });
  expect(fetch).toHaveBeenCalledWith(
    '/api/storages/backup/copy?path=note.md',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'X-Storage-Context': descriptor.contextId, ...expected })
    })
  );
  expect(
    new TextDecoder('utf8', { ignoreBOM: true }).decode(fetch.mock.calls[0][1]?.body as Uint8Array)
  ).toBe(source);
});

it.each(['lost', 'malformed'] as const)(
  'classifies %s browser acknowledgement as unknown',
  async mode => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (mode === 'lost') throw new Error('lost');
        return new Response('{}');
      })
    );
    expect(
      await copyCloudNote(descriptor, {
        path: 'note.md',
        source,
        expectedTarget: { status: 'missing' }
      })
    ).toMatchObject({ status: 'unavailable', outcome: 'unknown' });
  }
);

it.each([401, 403, 409] as const)(
  'recognizes a proven HTTP %i rejection as not-written',
  async status => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            success: false,
            error: status === 409 ? 'CLOUD_CONTEXT_MISMATCH' : 'Forbidden',
            outcome: 'not-written'
          },
          { status }
        )
      )
    );
    expect(
      await copyCloudNote(descriptor, {
        path: 'note.md',
        source,
        expectedTarget: { status: 'missing' }
      })
    ).toMatchObject({ status: 'unavailable', outcome: 'not-written' });
  }
);
