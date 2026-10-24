import { expect, it, vi } from 'vitest';
import { executeNoteSync, type NoteSyncDependencies } from '../application/executeNoteSync';
import { planNoteSync } from '../domain/storageSync';
import { MemoryCloudStorage } from './helpers/memoryCloudStorage';
import type { NoteStorage } from '../ports/noteStorage';
import type { ManualSyncOperation } from '../ports/manualSyncJournal';
import { available, note, OLD_SOURCE, NEW_SOURCE } from './helpers/storageSyncFixtures';

function endpoint(id: string, source: string | null, caseSensitive = true) {
  const memory = new MemoryCloudStorage({
    documents: source === null ? [] : [{ path: 'note.md', source, revision: 'base' }],
    capabilities: { revisions: true, conditionalCreate: true, conditionalUpdate: true }
  });
  const storage: NoteStorage = {
    id,
    label: id,
    kind: 'cloud',
    contextId: `context-${id}`,
    caseSensitive,
    list: () => memory.list(),
    read: (path, signal) => memory.read(path),
    copy: vi.fn(async input =>
      memory.write({
        path: input.path,
        source: input.source,
        createOnly: input.expectedTarget.status === 'missing',
        ...(input.expectedTarget.status === 'present' && input.expectedTarget.revision !== null
          ? { expectedRevision: input.expectedTarget.revision }
          : {})
      })
    )
  };
  return { storage, memory };
}

function setup(source = OLD_SOURCE, target: string | null = NEW_SOURCE) {
  const from = endpoint('from', source);
  const to = endpoint('to', target);
  let sequence = 0;
  const durable = new Map<string, ManualSyncOperation>();
  const journal = {
    begin: vi.fn(async (operation: ManualSyncOperation) => {
      const key = `${operation.targetKey}/${operation.pathKey}`;
      if (durable.has(key)) return false;
      durable.set(key, operation);
      return true;
    }),
    settle: vi.fn(async (operation: ManualSyncOperation, outcome: 'known' | 'unknown') => {
      if (outcome === 'known') durable.delete(`${operation.targetKey}/${operation.pathKey}`);
    })
  };
  const dependencies: NoteSyncDependencies = {
    storages: new Map([
      ['from', from.storage],
      ['to', to.storage]
    ]),
    journal,
    newId: () => `op-${++sequence}`,
    now: () => 100,
    exclusive: async task => {
      await task();
      return true;
    }
  };
  const plan = planNoteSync(
    [
      available('from', [note('note.md', source, 'base')]),
      available('to', target === null ? [] : [note('note.md', target, 'base')])
    ],
    { paths: ['note.md'], sourceStorageId: 'from', targetStorageIds: ['to'] }
  );
  return { from, to, dependencies, journal, durable, plan };
}

it('copies an explicitly selected older reference with exact bytes and captured target preconditions', async () => {
  const { plan, dependencies, to } = setup('\uFEFFlegacy\r\n');
  expect(await executeNoteSync(plan, dependencies)).toEqual([
    {
      path: 'note.md',
      sourceStorageId: 'from',
      targetStorageId: 'to',
      outcome: { status: 'written', revision: expect.any(String) }
    }
  ]);
  expect(to.storage.copy).toHaveBeenCalledWith({
    path: 'note.md',
    source: '\uFEFFlegacy\r\n',
    expectedTarget: { status: 'present', source: NEW_SOURCE, revision: 'base' }
  });
});

it.each(['changed', 'deleted', 'unavailable'] as const)(
  'does not write after the reference becomes %s',
  async kind => {
    const { plan, dependencies, from, to } = setup();
    from.storage.read = async () =>
      kind === 'deleted'
        ? { status: 'not-found' }
        : kind === 'unavailable'
          ? { status: 'unavailable', reason: 'network' }
          : { status: 'found', document: { path: 'note.md', source: 'changed', revision: 'new' } };
    expect(await executeNoteSync(plan, dependencies)).toMatchObject([
      {
        outcome: {
          status: 'blocked',
          reason: kind === 'unavailable' ? 'source-unavailable' : 'source-changed'
        }
      }
    ]);
    expect(to.storage.copy).not.toHaveBeenCalled();
  }
);

it.each(['changed', 'deleted', 'unavailable', 'revision'] as const)(
  'does not overwrite a %s destination',
  async kind => {
    const { plan, dependencies, to } = setup();
    to.storage.read = async () =>
      kind === 'deleted'
        ? { status: 'not-found' }
        : kind === 'unavailable'
          ? { status: 'unavailable', reason: 'network' }
          : {
              status: 'found',
              document: {
                path: 'note.md',
                source: kind === 'revision' ? NEW_SOURCE : 'changed',
                revision: 'new'
              }
            };
    expect(await executeNoteSync(plan, dependencies)).toMatchObject([
      {
        outcome: {
          status: 'blocked',
          reason: kind === 'unavailable' ? 'target-unavailable' : 'target-changed'
        }
      }
    ]);
    expect(to.storage.copy).not.toHaveBeenCalled();
  }
);

it('refuses a changed source revision even when its text is unchanged', async () => {
  const { plan, dependencies, from, to } = setup();
  from.storage.read = async () => ({
    status: 'found',
    document: { path: 'note.md', source: OLD_SOURCE, revision: 'changed' }
  });
  expect(await executeNoteSync(plan, dependencies)).toMatchObject([
    { outcome: { status: 'blocked', reason: 'source-changed' } }
  ]);
  expect(to.storage.copy).not.toHaveBeenCalled();
});

it('performs create-only for a confirmed missing destination', async () => {
  const { plan, dependencies, to } = setup(OLD_SOURCE, null);
  expect(await executeNoteSync(plan, dependencies)).toMatchObject([
    { outcome: { status: 'written' } }
  ]);
  expect(to.storage.copy).toHaveBeenCalledWith({
    path: 'note.md',
    source: OLD_SOURCE,
    expectedTarget: { status: 'missing' }
  });
});

it.each([false, null])(
  'refuses writes without acquired cross-tab ownership (%j)',
  async ownership => {
    const { plan, dependencies, to, journal } = setup();
    dependencies.exclusive = async () => ownership;
    expect(await executeNoteSync(plan, dependencies)).toMatchObject([
      {
        outcome: {
          status: 'blocked',
          reason: ownership === null ? 'ownership-unavailable' : 'busy'
        }
      }
    ]);
    expect(to.storage.copy).not.toHaveBeenCalled();
    expect(journal.begin).not.toHaveBeenCalled();
  }
);

it('persists intent before a write and refuses to write if that persistence fails', async () => {
  const { plan, dependencies, to, journal } = setup();
  journal.begin.mockRejectedValue(new Error('quota'));
  expect(await executeNoteSync(plan, dependencies)).toMatchObject([
    { outcome: { status: 'blocked', reason: 'local-error' } }
  ]);
  expect(to.storage.copy).not.toHaveBeenCalled();
});

it('records an unknown write and blocks a second attempt instead of blindly retrying', async () => {
  const { plan, dependencies, to, journal } = setup();
  to.storage.copy = vi.fn(async () => ({
    status: 'unavailable' as const,
    reason: 'network' as const,
    outcome: 'unknown' as const
  }));
  expect(await executeNoteSync(plan, dependencies)).toMatchObject([
    { outcome: { status: 'unavailable', outcome: 'unknown' } }
  ]);
  expect(journal.settle).toHaveBeenCalledWith(
    expect.objectContaining({ source: OLD_SOURCE }),
    'unknown'
  );
  expect(await executeNoteSync(plan, dependencies)).toMatchObject([
    { outcome: { status: 'blocked', reason: 'uncertain' } }
  ]);
  expect(to.storage.copy).toHaveBeenCalledTimes(1);
});

it('treats an exception after starting a copy as an unknown outcome', async () => {
  const { plan, dependencies, to, journal } = setup();
  to.storage.copy = vi.fn(async () => {
    throw new Error('lost');
  });
  expect(await executeNoteSync(plan, dependencies)).toMatchObject([
    { outcome: { status: 'unavailable', outcome: 'unknown' } }
  ]);
  expect(journal.settle).toHaveBeenCalledWith(expect.any(Object), 'unknown');
});

it('does not report confirmed success when the durable acknowledgement fails', async () => {
  const { plan, dependencies, journal } = setup();
  journal.settle.mockRejectedValue(new Error('quota'));
  expect(await executeNoteSync(plan, dependencies)).toMatchObject([
    { outcome: { status: 'unavailable', outcome: 'unknown' } }
  ]);
});

it('reports partial results independently and skips files absent in the selected source', async () => {
  const { dependencies, from, to } = setup();
  const another = endpoint('another', NEW_SOURCE);
  another.storage.copy = vi.fn(async () => ({ status: 'conflict' as const }));
  const storages = new Map(dependencies.storages);
  storages.set('another', another.storage);
  dependencies.storages = storages;
  const plan = planNoteSync(
    [
      available('from', [note('note.md', OLD_SOURCE, 'base')]),
      available('to', [note('note.md', NEW_SOURCE, 'base'), note('absent.md', NEW_SOURCE)]),
      available('another', [note('note.md', NEW_SOURCE, 'base')])
    ],
    {
      paths: ['note.md', 'absent.md'],
      sourceStorageId: 'from',
      targetStorageIds: ['to', 'another']
    }
  );
  expect(await executeNoteSync(plan, dependencies)).toMatchObject([
    {
      path: 'note.md',
      sourceStorageId: 'from',
      targetStorageId: 'to',
      outcome: { status: 'written' }
    },
    {
      path: 'note.md',
      sourceStorageId: 'from',
      targetStorageId: 'another',
      outcome: { status: 'conflict' }
    },
    {
      path: 'absent.md',
      sourceStorageId: 'from',
      targetStorageId: 'to',
      outcome: { status: 'skipped', reason: 'source-missing' }
    },
    {
      path: 'absent.md',
      sourceStorageId: 'from',
      targetStorageId: 'another',
      outcome: { status: 'skipped', reason: 'source-missing' }
    }
  ]);
});

it('rechecks an identical skip so diverged copies are not reported identical', async () => {
  const { plan, dependencies, to } = setup(OLD_SOURCE, OLD_SOURCE);
  await to.memory.write({ path: 'note.md', source: 'newer' });
  expect(await executeNoteSync(plan, dependencies)).toMatchObject([
    { outcome: { status: 'blocked', reason: 'no-longer-identical' } }
  ]);
  expect(to.storage.copy).not.toHaveBeenCalled();
});

it('blocks every selected colliding filename before writing to a case-insensitive destination', async () => {
  const { dependencies, from, to } = setup(OLD_SOURCE, null);
  to.storage.caseSensitive = false;
  await from.memory.write({ path: 'Note.md', source: 'upper' });
  await from.memory.write({ path: 'note.md', source: 'lower' });
  const upper = await from.memory.read('Note.md');
  const lower = await from.memory.read('note.md');
  const plan = planNoteSync(
    [
      available('from', [
        note('Note.md', 'upper', upper.status === 'found' ? upper.document.revision : null),
        note('note.md', 'lower', lower.status === 'found' ? lower.document.revision : null)
      ]),
      available('to')
    ],
    { paths: ['Note.md', 'note.md'], sourceStorageId: 'from', targetStorageIds: ['to'] }
  );
  expect(await executeNoteSync(plan, dependencies)).toMatchObject([
    { outcome: { status: 'blocked', reason: 'case-collision' } },
    { outcome: { status: 'blocked', reason: 'case-collision' } }
  ]);
  expect(to.storage.copy).not.toHaveBeenCalled();
});

it('also refuses a case alias already occupied in the destination', async () => {
  const { plan, dependencies, to } = setup(OLD_SOURCE, null);
  to.storage.caseSensitive = false;
  await to.memory.write({ path: 'Note.md', source: 'another note' });
  expect(await executeNoteSync(plan, dependencies)).toMatchObject([
    { outcome: { status: 'blocked', reason: 'case-collision' } }
  ]);
  expect(to.storage.copy).not.toHaveBeenCalled();
});

it('captures the plan and storage collection before asynchronous work', async () => {
  const { plan, dependencies, to } = setup();
  const gate = Promise.withResolvers<void>();
  dependencies.exclusive = async task => {
    await gate.promise;
    await task();
    return true;
  };
  const executing = executeNoteSync(plan, dependencies);
  const captured = structuredClone(plan);
  if (plan.actions[0].status === 'copy') plan.actions[0].source = 'mutated';
  const other = endpoint('replacement', null);
  (dependencies.storages as Map<string, NoteStorage>).set('to', other.storage);
  gate.resolve();
  expect(await executing).toMatchObject([{ outcome: { status: 'written' } }]);
  expect(to.storage.copy).toHaveBeenCalledWith(
    expect.objectContaining({
      source: captured.actions[0].status === 'copy' ? captured.actions[0].source : undefined
    })
  );
  expect(other.storage.copy).not.toHaveBeenCalled();
});

it('does not attribute an identical-plan divergence to a particular changed side', async () => {
  const { plan, dependencies, from, to } = setup(OLD_SOURCE, OLD_SOURCE);
  await from.memory.write({ path: 'note.md', source: 'changed source' });
  expect(await executeNoteSync(plan, dependencies)).toMatchObject([
    { outcome: { status: 'blocked', reason: 'no-longer-identical' } }
  ]);
  expect(to.storage.copy).not.toHaveBeenCalled();
});

it('can confirm current equality for two changed copies without writing', async () => {
  const { plan, dependencies, from, to, journal } = setup(OLD_SOURCE, OLD_SOURCE);
  await from.memory.write({ path: 'note.md', source: 'new equal' });
  await to.memory.write({ path: 'note.md', source: 'new equal' });
  expect(await executeNoteSync(plan, dependencies)).toMatchObject([
    { outcome: { status: 'skipped', reason: 'identical' } }
  ]);
  expect(to.storage.copy).not.toHaveBeenCalled();
  expect(journal.begin).not.toHaveBeenCalled();
});

it.each(['read', 'list'] as const)(
  'keeps per-target results when a preflight %s throws',
  async method => {
    const { dependencies } = setup();
    const failed = endpoint('failed', null, false);
    const healthy = endpoint('healthy', null);
    failed.storage[method] = async () => {
      throw new Error('read/list failed');
    };
    dependencies.storages = new Map([
      ...dependencies.storages,
      ['failed', failed.storage],
      ['healthy', healthy.storage]
    ]);
    const plan = planNoteSync(
      [
        available('from', [note('note.md', OLD_SOURCE, 'base')]),
        available('to', [note('note.md', NEW_SOURCE, 'base')]),
        available('failed'),
        available('healthy')
      ],
      { paths: ['note.md'], sourceStorageId: 'from', targetStorageIds: ['to', 'failed', 'healthy'] }
    );
    expect(await executeNoteSync(plan, dependencies)).toMatchObject([
      { targetStorageId: 'to', outcome: { status: 'written' } },
      { targetStorageId: 'failed', outcome: { status: 'blocked', reason: 'target-unavailable' } },
      { targetStorageId: 'healthy', outcome: { status: 'written' } }
    ]);
  }
);

it('rechecks the selected source before each target, including after a previous successful copy', async () => {
  const { dependencies, from, to } = setup();
  const healthy = endpoint('healthy', null);
  dependencies.storages = new Map([...dependencies.storages, ['healthy', healthy.storage]]);
  const firstCopy = to.storage.copy;
  to.storage.copy = async input => {
    const result = await firstCopy(input);
    await from.memory.write({ path: 'note.md', source: 'changed during batch' });
    return result;
  };
  const plan = planNoteSync(
    [
      available('from', [note('note.md', OLD_SOURCE, 'base')]),
      available('to', [note('note.md', NEW_SOURCE, 'base')]),
      available('healthy')
    ],
    { paths: ['note.md'], sourceStorageId: 'from', targetStorageIds: ['to', 'healthy'] }
  );
  expect(await executeNoteSync(plan, dependencies)).toMatchObject([
    { outcome: { status: 'written' } },
    { outcome: { status: 'blocked', reason: 'source-changed' } }
  ]);
  expect(healthy.storage.copy).not.toHaveBeenCalled();
});

it('uses a canonical journal address for case aliases even before an unknown write appears in listing', async () => {
  const { dependencies, to } = setup(OLD_SOURCE, null);
  to.storage.caseSensitive = false;
  to.storage.copy = vi.fn(async () => ({
    status: 'unavailable' as const,
    reason: 'network' as const,
    outcome: 'unknown' as const
  }));
  const from = endpoint('from', null);
  await from.memory.write({ path: 'Note.md', source: OLD_SOURCE });
  await from.memory.write({ path: 'note.md', source: OLD_SOURCE });
  dependencies.storages = new Map([
    ['from', from.storage],
    ['to', to.storage]
  ]);
  const listed = await from.memory.list();
  if (listed.status !== 'success') throw new Error('fixture');
  const snapshots = [
    available(
      'from',
      listed.entries.map(entry => note(entry.path, OLD_SOURCE, entry.revision))
    ),
    available('to')
  ];
  await executeNoteSync(
    planNoteSync(snapshots, {
      paths: ['Note.md'],
      sourceStorageId: 'from',
      targetStorageIds: ['to']
    }),
    dependencies
  );
  expect(
    await executeNoteSync(
      planNoteSync(snapshots, {
        paths: ['note.md'],
        sourceStorageId: 'from',
        targetStorageIds: ['to']
      }),
      dependencies
    )
  ).toMatchObject([{ outcome: { status: 'blocked', reason: 'uncertain' } }]);
  expect(to.storage.copy).toHaveBeenCalledTimes(1);
});
