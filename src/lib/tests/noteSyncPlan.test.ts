// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { planNoteSync } from '../domain/storageSync';
import type { NoteSyncSelection, StorageSnapshot } from '../domain/storageSync';
import {
  NEWEST,
  OLD_SOURCE,
  NEW_SOURCE,
  LEGACY_SOURCE,
  FUTURE_SOURCE,
  INVALID_TIME_SOURCE,
  available,
  note
} from './helpers/storageSyncFixtures';

const path = 'note.md';

const address = { path, sourceStorageId: 'source', targetStorageId: 'target' };

function selection(overrides: Partial<NoteSyncSelection> = {}): NoteSyncSelection {
  return { paths: [path], sourceStorageId: 'source', targetStorageIds: ['target'], ...overrides };
}

describe('planNoteSync: an explicit source and selected destinations', () => {
  it('plans no actions for an empty file selection', () => {
    expect(
      planNoteSync([available('source'), available('target')], selection({ paths: [] }))
    ).toEqual({ actions: [] });
  });

  it('plans no actions when no destination is selected', () => {
    expect(
      planNoteSync(
        [available('source', [note(path, NEW_SOURCE)])],
        selection({ targetStorageIds: [] })
      )
    ).toEqual({ actions: [] });
  });

  it('captures exact source and confirmed target absence for a conditional creation', () => {
    expect(
      planNoteSync(
        [available('source', [note(path, NEW_SOURCE, 'source-rev')]), available('target')],
        selection()
      )
    ).toEqual({
      actions: [
        {
          ...address,
          status: 'copy',
          source: NEW_SOURCE,
          sourceRevision: 'source-rev',
          expectedTarget: { status: 'missing' }
        }
      ]
    });
  });

  it.each([
    ['newer', NEW_SOURCE, OLD_SOURCE],
    ['older', OLD_SOURCE, NEW_SOURCE]
  ])(
    'honors the explicitly selected %s source and captures the observed target version',
    (_, source, target) => {
      expect(
        planNoteSync(
          [
            available('source', [note(path, source, 'chosen-rev')]),
            available('target', [note(path, target, 'target-rev')])
          ],
          selection()
        )
      ).toEqual({
        actions: [
          {
            ...address,
            status: 'copy',
            source,
            sourceRevision: 'chosen-rev',
            expectedTarget: { status: 'present', source: target, revision: 'target-rev' }
          }
        ]
      });
    }
  );

  it('captures an existing target without an opaque revision as a precondition', () => {
    expect(
      planNoteSync(
        [
          available('source', [note(path, NEW_SOURCE, 'cloud-rev')]),
          available('local', [note(path, OLD_SOURCE)])
        ],
        selection({ targetStorageIds: ['local'] })
      )
    ).toEqual({
      actions: [
        {
          path,
          sourceStorageId: 'source',
          targetStorageId: 'local',
          status: 'copy',
          source: NEW_SOURCE,
          sourceRevision: 'cloud-rev',
          expectedTarget: { status: 'present', source: OLD_SOURCE, revision: null }
        }
      ]
    });
  });

  it('skips copying a selected source onto itself', () => {
    expect(
      planNoteSync(
        [available('source', [note(path, NEW_SOURCE)])],
        selection({ targetStorageIds: ['source'] })
      )
    ).toEqual({
      actions: [
        {
          path,
          sourceStorageId: 'source',
          targetStorageId: 'source',
          status: 'skip',
          reason: 'same-storage'
        }
      ]
    });
  });

  it('skips identical text despite unrelated revisions and provider dates', () => {
    expect(
      planNoteSync(
        [
          available('source', [note(path, NEW_SOURCE, '99')]),
          available('target', [note(path, NEW_SOURCE, '1', NEWEST)])
        ],
        selection()
      )
    ).toEqual({ actions: [{ ...address, status: 'skip', reason: 'identical' }] });
  });

  it('skips a file missing in the chosen source while retaining a target-only file', () => {
    expect(
      planNoteSync(
        [available('source'), available('target', [note(path, NEW_SOURCE, 'keep-this-rev')])],
        selection()
      )
    ).toEqual({ actions: [{ ...address, status: 'skip', reason: 'source-missing' }] });
  });

  it('blocks an unavailable source instead of interpreting it as a missing file', () => {
    expect(
      planNoteSync(
        [
          { storageId: 'source', status: 'unavailable' },
          available('target', [note(path, OLD_SOURCE)])
        ],
        selection()
      )
    ).toEqual({ actions: [{ ...address, status: 'blocked', reason: 'source-unavailable' }] });
  });

  it('blocks an unavailable target instead of treating it as permission to create', () => {
    expect(
      planNoteSync(
        [
          available('source', [note(path, NEW_SOURCE)]),
          { storageId: 'target', status: 'unavailable' }
        ],
        selection()
      )
    ).toEqual({ actions: [{ ...address, status: 'blocked', reason: 'target-unavailable' }] });
  });

  it('blocks an unknown source without falling back to any available storage', () => {
    expect(
      planNoteSync(
        [available('other-cloud', [note(path, NEW_SOURCE)]), available('target')],
        selection()
      )
    ).toEqual({ actions: [{ ...address, status: 'blocked', reason: 'unknown-source' }] });
  });

  it('blocks an unknown destination instead of constructing a new storage implicitly', () => {
    expect(planNoteSync([available('source', [note(path, NEW_SOURCE)])], selection())).toEqual({
      actions: [{ ...address, status: 'blocked', reason: 'unknown-target' }]
    });
  });

  it.each([
    ['legacy', LEGACY_SOURCE],
    ['future format', FUTURE_SOURCE],
    ['invalid timestamp', INVALID_TIME_SOURCE]
  ])(
    'allows an explicit copy of %s without parsing, migrating or serializing its source',
    (_, source) => {
      expect(
        planNoteSync([available('source', [note(path, source)]), available('target')], selection())
      ).toEqual({
        actions: [
          {
            ...address,
            status: 'copy',
            source,
            sourceRevision: null,
            expectedTarget: { status: 'missing' }
          }
        ]
      });
    }
  );

  it('preserves a Unicode filename, BOM, CRLF and document Modified in the planned copy', () => {
    const filename = 'Заметка 🗂.md.md';
    const source = '\uFEFF' + NEW_SOURCE.replaceAll('\n', '\r\n');
    expect(
      planNoteSync(
        [available('source', [note(filename, source, ' bytes/rev ')]), available('target')],
        selection({ paths: [filename] })
      )
    ).toEqual({
      actions: [
        {
          path: filename,
          sourceStorageId: 'source',
          targetStorageId: 'target',
          status: 'copy',
          source,
          sourceRevision: ' bytes/rev ',
          expectedTarget: { status: 'missing' }
        }
      ]
    });
  });

  it('plans an LF-to-CRLF replacement as a real copy rather than normalizing the two sources to equality', () => {
    const source = NEW_SOURCE.replaceAll('\n', '\r\n');
    expect(
      planNoteSync(
        [available('source', [note(path, source)]), available('target', [note(path, NEW_SOURCE)])],
        selection()
      )
    ).toEqual({
      actions: [
        {
          ...address,
          status: 'copy',
          source,
          sourceRevision: null,
          expectedTarget: { status: 'present', source: NEW_SOURCE, revision: null }
        }
      ]
    });
  });

  it('produces a result for each selected file and destination using one fixed source for the whole batch', () => {
    expect(
      planNoteSync(
        [
          available('source', [
            note('a.md', NEW_SOURCE, 'rev-a'),
            note('b.md', OLD_SOURCE, 'rev-b')
          ]),
          available('target', [
            note('a.md', NEW_SOURCE, 'rev-other-a'),
            note('b.md', NEW_SOURCE, 'rev-other-b'),
            note('target-only.md', NEW_SOURCE, 'keep')
          ]),
          available('local')
        ],
        selection({
          paths: ['a.md', 'b.md', 'target-only.md'],
          targetStorageIds: ['target', 'local']
        })
      )
    ).toEqual({
      actions: [
        {
          path: 'a.md',
          sourceStorageId: 'source',
          targetStorageId: 'target',
          status: 'skip',
          reason: 'identical'
        },
        {
          path: 'a.md',
          sourceStorageId: 'source',
          targetStorageId: 'local',
          status: 'copy',
          source: NEW_SOURCE,
          sourceRevision: 'rev-a',
          expectedTarget: { status: 'missing' }
        },
        {
          path: 'b.md',
          sourceStorageId: 'source',
          targetStorageId: 'target',
          status: 'copy',
          source: OLD_SOURCE,
          sourceRevision: 'rev-b',
          expectedTarget: { status: 'present', source: NEW_SOURCE, revision: 'rev-other-b' }
        },
        {
          path: 'b.md',
          sourceStorageId: 'source',
          targetStorageId: 'local',
          status: 'copy',
          source: OLD_SOURCE,
          sourceRevision: 'rev-b',
          expectedTarget: { status: 'missing' }
        },
        {
          path: 'target-only.md',
          sourceStorageId: 'source',
          targetStorageId: 'target',
          status: 'skip',
          reason: 'source-missing'
        },
        {
          path: 'target-only.md',
          sourceStorageId: 'source',
          targetStorageId: 'local',
          status: 'skip',
          reason: 'source-missing'
        }
      ]
    });
  });

  it('keeps an available destination actionable when another selected destination is unavailable', () => {
    expect(
      planNoteSync(
        [
          available('source', [note(path, NEW_SOURCE)]),
          { storageId: 'offline', status: 'unavailable' },
          available('target')
        ],
        selection({ targetStorageIds: ['offline', 'target'] })
      )
    ).toEqual({
      actions: [
        {
          path,
          sourceStorageId: 'source',
          targetStorageId: 'offline',
          status: 'blocked',
          reason: 'target-unavailable'
        },
        {
          ...address,
          status: 'copy',
          source: NEW_SOURCE,
          sourceRevision: null,
          expectedTarget: { status: 'missing' }
        }
      ]
    });
  });

  it('blocks a listed but unreadable source only for that file and still plans healthy files from the same storage', () => {
    expect(
      planNoteSync(
        [
          available('source', [
            { path: 'unreadable.md', status: 'unavailable' },
            note('healthy.md', NEW_SOURCE)
          ]),
          available('target')
        ],
        selection({ paths: ['unreadable.md', 'healthy.md'] })
      )
    ).toEqual({
      actions: [
        {
          path: 'unreadable.md',
          sourceStorageId: 'source',
          targetStorageId: 'target',
          status: 'blocked',
          reason: 'source-unavailable'
        },
        {
          path: 'healthy.md',
          sourceStorageId: 'source',
          targetStorageId: 'target',
          status: 'copy',
          source: NEW_SOURCE,
          sourceRevision: null,
          expectedTarget: { status: 'missing' }
        }
      ]
    });
  });

  it('does not create over a listed but unreadable target and still plans other files for that destination', () => {
    expect(
      planNoteSync(
        [
          available('source', [note('unreadable.md', NEW_SOURCE), note('healthy.md', NEW_SOURCE)]),
          available('target', [{ path: 'unreadable.md', status: 'unavailable' }])
        ],
        selection({ paths: ['unreadable.md', 'healthy.md'] })
      )
    ).toEqual({
      actions: [
        {
          path: 'unreadable.md',
          sourceStorageId: 'source',
          targetStorageId: 'target',
          status: 'blocked',
          reason: 'target-unavailable'
        },
        {
          path: 'healthy.md',
          sourceStorageId: 'source',
          targetStorageId: 'target',
          status: 'copy',
          source: NEW_SOURCE,
          sourceRevision: null,
          expectedTarget: { status: 'missing' }
        }
      ]
    });
  });

  it('deduplicates selections so a repeated path or destination cannot cause repeated writes', () => {
    expect(
      planNoteSync(
        [available('source', [note(path, NEW_SOURCE)]), available('target')],
        selection({
          paths: [path, path],
          targetStorageIds: ['target', 'target', 'source', 'source']
        })
      )
    ).toEqual({
      actions: [
        {
          ...address,
          status: 'copy',
          source: NEW_SOURCE,
          sourceRevision: null,
          expectedTarget: { status: 'missing' }
        },
        {
          path,
          sourceStorageId: 'source',
          targetStorageId: 'source',
          status: 'skip',
          reason: 'same-storage'
        }
      ]
    });
  });

  it.each(['../outside.md', 'folder/note.md', '.md', 'note.txt'])(
    'blocks an invalid selected path %s before planning a write',
    filename => {
      expect(
        planNoteSync([available('source'), available('target')], selection({ paths: [filename] }))
      ).toEqual({
        actions: [
          {
            path: filename,
            sourceStorageId: 'source',
            targetStorageId: 'target',
            status: 'blocked',
            reason: 'invalid-path'
          }
        ]
      });
    }
  );

  it('captures source, target and selection independently of later caller changes', () => {
    const sourceNote = note(path, NEW_SOURCE, 'source-before');
    const targetNote = note(path, OLD_SOURCE, 'target-before');
    const snapshots = [available('source', [sourceNote]), available('target', [targetNote])];
    const chosen = selection();
    const expected = {
      actions: [
        {
          ...address,
          status: 'copy',
          source: NEW_SOURCE,
          sourceRevision: 'source-before',
          expectedTarget: { status: 'present', source: OLD_SOURCE, revision: 'target-before' }
        }
      ]
    };
    const result = planNoteSync(snapshots, chosen);
    expect(result).toEqual(expected);
    sourceNote.source = 'later source';
    sourceNote.revision = 'later source revision';
    targetNote.source = 'later target';
    targetNote.revision = 'later target revision';
    chosen.paths = ['other.md'];
    chosen.sourceStorageId = 'later-source';
    chosen.targetStorageIds = ['later-target'];
    expect(result).toEqual(expected);
  });

  it('does not mutate frozen snapshots or selections and returns detached target preconditions', () => {
    const targetNote = Object.freeze(note(path, OLD_SOURCE, 'target-before'));
    const snapshots: readonly StorageSnapshot[] = Object.freeze([
      Object.freeze({
        storageId: 'source',
        status: 'available' as const,
        notes: Object.freeze([Object.freeze(note(path, NEW_SOURCE))])
      }),
      Object.freeze({
        storageId: 'target',
        status: 'available' as const,
        notes: Object.freeze([targetNote])
      })
    ]);
    const chosen = Object.freeze({
      paths: Object.freeze([path]),
      sourceStorageId: 'source',
      targetStorageIds: Object.freeze(['target'])
    });
    const before = structuredClone({ snapshots, chosen });
    const expected = {
      actions: [
        {
          ...address,
          status: 'copy',
          source: NEW_SOURCE,
          sourceRevision: null,
          expectedTarget: { status: 'present', source: OLD_SOURCE, revision: 'target-before' }
        }
      ]
    };
    const result = planNoteSync(snapshots, chosen);
    expect(result).toEqual(expected);
    const action = result.actions[0];
    if (action.status === 'copy' && action.expectedTarget.status === 'present') {
      action.expectedTarget.source = 'only the returned plan';
    }
    expect({ snapshots, chosen }).toEqual(before);
    expect(planNoteSync(snapshots, chosen)).toEqual(expected);
  });
});
