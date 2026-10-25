import { expect, it, vi } from 'vitest';
import {
  readStorageInventory,
  type StorageInventoryProgress
} from '../application/storageInventory';
import { MemoryCloudStorage } from './helpers/memoryCloudStorage';
import type { CloudDocument } from '../ports/cloudStorage';
import type { NoteStorageReader } from '../ports/noteStorage';

const present = (path = 'note.md', source = 'raw') => ({ path, source, revision: 'rev' });

function reader(id: string, notes: CloudDocument[] = [present()]): NoteStorageReader {
  return Object.assign(new MemoryCloudStorage({ documents: notes }), { id });
}

it('counts every listed copy across storages, including failed reads, as it finishes', async () => {
  const cloud = reader('cloud', [present('first.md'), present('broken.md')]);
  const local = reader('local', [present('first.md')]);
  const gates = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
  const started = Promise.withResolvers<void>();
  let reads = 0;
  for (const source of [cloud, local]) {
    source.read = async path => {
      const gate = gates[reads++];
      if (reads === 3) started.resolve();
      await gate.promise;
      if (path === 'broken.md') throw new Error('network');
      return { status: 'found', document: present(path) };
    };
  }
  const progress: StorageInventoryProgress[] = [];
  const loading = readStorageInventory(
    [cloud, local, { id: 'offline', unavailable: true }],
    undefined,
    value => progress.push(value)
  );
  try {
    await started.promise;
    expect(progress.filter(value => value.phase === 'listing')).toEqual(
      [0, 1, 2, 3].map(completed => ({ phase: 'listing', completed, total: 3 }))
    );
    expect(progress.at(-1)).toEqual({ phase: 'reading', completed: 0, total: 3 });
    gates[1].resolve();
    await vi.waitFor(() =>
      expect(progress.at(-1)).toEqual({ phase: 'reading', completed: 1, total: 3 })
    );
    gates[2].resolve();
    await vi.waitFor(() =>
      expect(progress.at(-1)).toEqual({ phase: 'reading', completed: 2, total: 3 })
    );
    gates[0].resolve();
    const snapshots = await loading;
    expect(progress.at(-1)).toEqual({ phase: 'reading', completed: 3, total: 3 });
    expect(snapshots[0]).toMatchObject({
      notes: [{ status: 'present' }, { path: 'broken.md', status: 'unavailable' }]
    });
  } finally {
    gates.forEach(gate => gate.resolve());
    await loading;
  }
});

it('finishes progress for empty or unavailable listings without inventing reads', async () => {
  const broken = reader('broken');
  broken.list = async () => { throw new Error('network'); };
  const progress = vi.fn();
  await readStorageInventory([reader('empty', []), broken], undefined, progress);
  expect(progress.mock.calls.map(([value]) => value)).toEqual([
    { phase: 'listing', completed: 0, total: 2 },
    { phase: 'listing', completed: 1, total: 2 },
    { phase: 'listing', completed: 2, total: 2 },
    { phase: 'reading', completed: 0, total: 0 }
  ]);
});

it('stops publishing progress when an in-flight load is cancelled', async () => {
  const source = reader('cloud');
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  source.read = async path => {
    started.resolve();
    await gate.promise;
    return { status: 'found', document: present(path) };
  };
  const controller = new AbortController();
  const progress = vi.fn();
  const loading = readStorageInventory([source], controller.signal, progress);
  try {
    await started.promise;
    controller.abort();
    progress.mockClear();
    gate.resolve();
    await loading;
    expect(progress).not.toHaveBeenCalled();
  } finally {
    gate.resolve();
    await loading;
  }
});

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
