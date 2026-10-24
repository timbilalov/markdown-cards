import { expect, it, vi } from 'vitest';
import { readStorageInventory } from '../application/storageInventory';
import { MemoryCloudStorage } from './helpers/memoryCloudStorage';
import type { CloudDocument } from '../ports/cloudStorage';
import type { NoteStorageReader } from '../ports/noteStorage';

const present = (path = 'note.md', source = 'raw') => ({ path, source, revision: 'rev' });

function reader(id: string, notes: CloudDocument[] = [present()]): NoteStorageReader {
  return Object.assign(new MemoryCloudStorage({ documents: notes }), { id });
}

it('reads any number of sources and keeps exact unsupported Markdown, revisions and source order', async () => {
  const sources = [
    reader('first', [present('note.md', '\uFEFFraw\r\n')]),
    reader('second', []),
    reader('third', [present('other.md', '')])
  ];
  expect(await readStorageInventory(sources)).toEqual([
    {
      storageId: 'first',
      status: 'available',
      notes: [{ status: 'present', ...present('note.md', '\uFEFFraw\r\n') }]
    },
    { storageId: 'second', status: 'available', notes: [] },
    {
      storageId: 'third',
      status: 'available',
      notes: [{ status: 'present', ...present('other.md', '') }]
    }
  ]);
});

it('keeps an unavailable catalog entry, never treating it as an empty folder', async () => {
  expect(
    await readStorageInventory([{ id: 'offline', unavailable: true }, reader('healthy')])
  ).toMatchObject([
    { storageId: 'offline', status: 'unavailable' },
    { storageId: 'healthy', status: 'available', notes: [{ path: 'note.md' }] }
  ]);
});

it.each(['failure', 'throw'] as const)(
  'keeps a failed complete listing unavailable (%s)',
  async mode => {
    const source = reader('broken');
    source.list = async () => {
      if (mode === 'throw') throw new Error('network');
      return { status: 'unavailable', reason: 'network' };
    };
    expect(await readStorageInventory([source, reader('healthy')])).toMatchObject([
      { storageId: 'broken', status: 'unavailable' },
      { storageId: 'healthy', status: 'available' }
    ]);
  }
);

it.each(['failure', 'throw', 'missing'] as const)(
  'retains a listed filename with an unreadable copy (%s)',
  async mode => {
    const source = reader('cloud', [present('broken.md'), present('good.md')]);
    source.read = async path => {
      if (path === 'good.md') return { status: 'found', document: present(path) };
      if (mode === 'throw') throw new Error('network');
      return mode === 'missing'
        ? { status: 'not-found' }
        : { status: 'unavailable', reason: 'network' };
    };
    expect(await readStorageInventory([source])).toEqual([
      {
        storageId: 'cloud',
        status: 'available',
        notes: [
          { path: 'broken.md', status: 'unavailable' },
          { status: 'present', ...present('good.md') }
        ]
      }
    ]);
  }
);

it('bounds concurrent source reads across multiple storages and retains complete listing order', async () => {
  const count = 3;
  const sources = Array.from({ length: count }, (_, index) =>
    reader(
      `cloud${index}`,
      Array.from({ length: 12 }, (_, i) => present(`${i}.md`))
    )
  );
  let active = 0;
  let maximum = 0;
  for (const source of sources)
    source.read = async path => {
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      return { status: 'found', document: present(path) };
    };
  const snapshots = await readStorageInventory(sources);
  expect(maximum).toBeGreaterThan(0);
  expect(maximum).toBeLessThanOrEqual(4);
  expect(snapshots).toMatchObject(
    Array.from({ length: count }, () => ({
      notes: Array.from({ length: 12 }, (_, i) => ({ path: `${i}.md` }))
    }))
  );
});

it.each([
  { entries: [{ path: '../other.md', revision: null }] },
  {
    entries: [
      { path: 'note.md', revision: null },
      { path: 'note.md', revision: null }
    ]
  }
])('refuses invalid or duplicate listing addresses %j', async ({ entries }) => {
  const source = reader('cloud');
  source.list = async () => ({ status: 'success', entries });
  expect(await readStorageInventory([source])).toEqual([
    { storageId: 'cloud', status: 'unavailable' }
  ]);
});

it('does no I/O after cancellation', async () => {
  const source = reader('cloud');
  const list = vi.spyOn(source, 'list');
  expect(await readStorageInventory([source], AbortSignal.abort())).toEqual([
    { storageId: 'cloud', status: 'unavailable' }
  ]);
  expect(list).not.toHaveBeenCalled();
});

it('keeps observed source revision and the separately listed provider timestamp', async () => {
  const source = reader('cloud');
  source.list = async () => ({
    status: 'success',
    entries: [{ path: 'note.md', revision: 'rev', modifiedAt: 0 }]
  });
  expect(await readStorageInventory([source])).toEqual([
    {
      storageId: 'cloud',
      status: 'available',
      notes: [{ status: 'present', ...present(), storageModifiedAt: 0 }]
    }
  ]);
});

it('does not attribute a document returned for another path to a listed note', async () => {
  const source = reader('cloud');
  source.read = async () => ({ status: 'found', document: present('wrong.md') });
  expect(await readStorageInventory([source])).toEqual([
    { storageId: 'cloud', status: 'available', notes: [{ path: 'note.md', status: 'unavailable' }] }
  ]);
});

it('does not assign a stale provider timestamp to a different observed revision', async () => {
  const source = reader('cloud');
  source.list = async () => ({
    status: 'success',
    entries: [{ path: 'note.md', revision: 'old-list-rev', modifiedAt: 0 }]
  });
  expect(await readStorageInventory([source])).toEqual([
    { storageId: 'cloud', status: 'available', notes: [{ status: 'present', ...present() }] }
  ]);
});

it('does not start source reads when cancelled during listing', async () => {
  const source = reader('cloud');
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Awaited<ReturnType<NoteStorageReader['list']>>>();
  source.list = () => {
    started.resolve();
    return response.promise;
  };
  const read = vi.spyOn(source, 'read');
  const controller = new AbortController();
  const loading = readStorageInventory([source], controller.signal);
  try {
    expect(
      await Promise.race([started.promise.then(() => 'listing'), loading.then(() => 'finished')])
    ).toBe('listing');
    controller.abort();
    response.resolve({ status: 'success', entries: [{ path: 'note.md', revision: 'rev' }] });
    expect(await loading).toEqual([{ storageId: 'cloud', status: 'unavailable' }]);
    expect(read).not.toHaveBeenCalled();
  } finally {
    response.resolve({ status: 'success', entries: [] });
    await loading;
  }
});

it('retains a separately labelled listing hint when both provider revisions are unknown', async () => {
  const source = reader('cloud', [{ ...present(), revision: null }]);
  source.list = async () => ({
    status: 'success',
    entries: [{ path: 'note.md', revision: null, modifiedAt: 0 }]
  });
  expect(await readStorageInventory([source])).toMatchObject([
    { notes: [{ storageModifiedAt: 0, revision: null }] }
  ]);
});
