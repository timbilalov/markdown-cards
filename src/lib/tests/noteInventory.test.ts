// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildNoteInventory } from '../domain/storageSync';
import type { StorageSnapshot } from '../domain/storageSync';
import {
  OLDER,
  NEWER,
  OLD_SOURCE,
  NEW_SOURCE,
  available,
  note,
  present,
  group
} from './helpers/storageSyncFixtures';

describe('buildNoteInventory: the union of filenames across all configured storages', () => {
  it('returns an empty table when there are no configured snapshots', () => {
    expect(buildNoteInventory([])).toEqual([]);
  });

  it('returns no rows when all available storages confirm an empty listing', () => {
    expect(
      buildNoteInventory([available('cloud-a'), available('cloud-b'), available('local')])
    ).toEqual([]);
  });

  it('includes files found only in a backup or the local cache and adds a cell for every storage', () => {
    expect(
      buildNoteInventory([
        available('active-cloud', [note('shared.md', OLD_SOURCE, 'remote-A')]),
        available('backup', [note('backup-only.md', NEW_SOURCE, 'remote-B')]),
        available('third-cloud'),
        available('local', [note('shared.md', NEW_SOURCE), note('local-only.md', OLD_SOURCE)])
      ])
    ).toEqual([
      {
        path: 'shared.md',
        copies: [
          present('active-cloud', OLD_SOURCE, 'remote-A'),
          { storageId: 'backup', status: 'missing' },
          { storageId: 'third-cloud', status: 'missing' },
          present('local', NEW_SOURCE)
        ],
        comparison: {
          versions: [
            group(OLD_SOURCE, ['active-cloud'], OLDER),
            group(NEW_SOURCE, ['local'], NEWER)
          ],
          freshness: { status: 'latest', storageIds: ['local'] }
        }
      },
      {
        path: 'backup-only.md',
        copies: [
          { storageId: 'active-cloud', status: 'missing' },
          present('backup', NEW_SOURCE, 'remote-B'),
          { storageId: 'third-cloud', status: 'missing' },
          { storageId: 'local', status: 'missing' }
        ],
        comparison: {
          versions: [group(NEW_SOURCE, ['backup'], NEWER)],
          freshness: { status: 'latest', storageIds: ['backup'] }
        }
      },
      {
        path: 'local-only.md',
        copies: [
          { storageId: 'active-cloud', status: 'missing' },
          { storageId: 'backup', status: 'missing' },
          { storageId: 'third-cloud', status: 'missing' },
          present('local', OLD_SOURCE)
        ],
        comparison: {
          versions: [group(OLD_SOURCE, ['local'], OLDER)],
          freshness: { status: 'latest', storageIds: ['local'] }
        }
      }
    ]);
  });

  it('groups the same filename across storages even if their document IDs differ', () => {
    const differentId = NEW_SOURCE.replace('minimal-card', 'another-id');
    expect(
      buildNoteInventory([
        available('cloud', [note('renamed.md', OLD_SOURCE)]),
        available('local', [note('renamed.md', differentId)])
      ])
    ).toMatchObject([
      {
        path: 'renamed.md',
        copies: [present('cloud', OLD_SOURCE), present('local', differentId)]
      }
    ]);
  });

  it('keeps different filenames with the same internal document ID as separate notes', () => {
    expect(
      buildNoteInventory([
        available('cloud', [note('first.md', OLD_SOURCE)]),
        available('local', [note('second.md', OLD_SOURCE)])
      ])
    ).toMatchObject([
      {
        path: 'first.md',
        copies: [present('cloud', OLD_SOURCE), { storageId: 'local', status: 'missing' }]
      },
      {
        path: 'second.md',
        copies: [{ storageId: 'cloud', status: 'missing' }, present('local', OLD_SOURCE)]
      }
    ]);
  });

  it('preserves case-sensitive filenames instead of silently merging potentially conflicting paths', () => {
    expect(
      buildNoteInventory([
        available('cloud', [note('Note.md', OLD_SOURCE), note('note.md', NEW_SOURCE)])
      ])
    ).toMatchObject([
      {
        path: 'Note.md',
        copies: [present('cloud', OLD_SOURCE)]
      },
      {
        path: 'note.md',
        copies: [present('cloud', NEW_SOURCE)]
      }
    ]);
  });

  it('keeps unavailable cells distinct from missing cells and retains the known exact source and metadata', () => {
    const path = 'Заметка 🗂.md.md';
    expect(
      buildNoteInventory([
        { storageId: 'offline-cloud', status: 'unavailable' },
        available('empty-cloud'),
        available('local', [note(path, NEW_SOURCE, null, OLDER)])
      ])
    ).toEqual([
      {
        path,
        copies: [
          { storageId: 'offline-cloud', status: 'unavailable' },
          { storageId: 'empty-cloud', status: 'missing' },
          present('local', NEW_SOURCE, null, OLDER)
        ],
        comparison: {
          versions: [group(NEW_SOURCE, ['local'], NEWER)],
          freshness: { status: 'undetermined', reason: 'unavailable' }
        }
      }
    ]);
  });

  it('does not mutate frozen snapshots and returns detached cells on repeated reads', () => {
    const snapshots: readonly StorageSnapshot[] = Object.freeze([
      Object.freeze({
        storageId: 'local',
        status: 'available' as const,
        notes: Object.freeze([Object.freeze(note('note.md', NEW_SOURCE))])
      })
    ]);
    const expected = [
      {
        path: 'note.md',
        copies: [present('local', NEW_SOURCE)],
        comparison: {
          versions: [group(NEW_SOURCE, ['local'], NEWER)],
          freshness: { status: 'latest', storageIds: ['local'] }
        }
      }
    ];
    const before = structuredClone(snapshots);
    const result = buildNoteInventory(snapshots);
    expect(result).toEqual(expected);
    const copy = result[0].copies[0];
    if (copy.status === 'present') copy.source = 'only the returned cell';
    result[0].comparison.versions[0].storageIds.push('only the returned group');
    expect(buildNoteInventory(snapshots)).toEqual(expected);
    expect(snapshots).toEqual(before);
  });

  it('retains listed filenames whose source could not be read without losing healthy files from that storage', () => {
    expect(
      buildNoteInventory([
        available('cloud', [
          { path: 'unreadable.md', status: 'unavailable' },
          note('healthy.md', OLD_SOURCE)
        ]),
        available('local', [note('healthy.md', NEW_SOURCE), note('local-only.md', NEW_SOURCE)])
      ])
    ).toEqual([
      {
        path: 'unreadable.md',
        copies: [
          { storageId: 'cloud', status: 'unavailable' },
          { storageId: 'local', status: 'missing' }
        ],
        comparison: { versions: [], freshness: { status: 'undetermined', reason: 'unavailable' } }
      },
      {
        path: 'healthy.md',
        copies: [present('cloud', OLD_SOURCE), present('local', NEW_SOURCE)],
        comparison: {
          versions: [group(OLD_SOURCE, ['cloud'], OLDER), group(NEW_SOURCE, ['local'], NEWER)],
          freshness: { status: 'latest', storageIds: ['local'] }
        }
      },
      {
        path: 'local-only.md',
        copies: [{ storageId: 'cloud', status: 'missing' }, present('local', NEW_SOURCE)],
        comparison: {
          versions: [group(NEW_SOURCE, ['local'], NEWER)],
          freshness: { status: 'latest', storageIds: ['local'] }
        }
      }
    ]);
  });
});
