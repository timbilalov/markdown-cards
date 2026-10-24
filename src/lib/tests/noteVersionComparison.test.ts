// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { compareNoteVersions } from '../domain/storageSync';
import type { NoteCopy } from '../domain/storageSync';
import {
  OLDER,
  NEWER,
  NEWEST,
  OLD_SOURCE,
  NEW_SOURCE,
  NEWEST_SOURCE,
  OTHER_SOURCE,
  LEGACY_SOURCE,
  FUTURE_SOURCE,
  INVALID_TIME_SOURCE,
  UNKNOWN_METADATA_SOURCE,
  present,
  group
} from './helpers/storageSyncFixtures';

describe('compareNoteVersions: exact sources and document Modified', () => {
  it('reports no versions for an empty collection', () => {
    expect(compareNoteVersions([])).toEqual({ versions: [], freshness: { status: 'empty' } });
  });

  it('reports no versions when every storage confirms absence', () => {
    expect(
      compareNoteVersions([
        { storageId: 'cloud-a', status: 'missing' },
        { storageId: 'local', status: 'missing' }
      ])
    ).toEqual({ versions: [], freshness: { status: 'empty' } });
  });

  it('identifies a single known copy as the latest when every other storage confirms absence', () => {
    expect(
      compareNoteVersions([
        present('backup', OLD_SOURCE),
        { storageId: 'local', status: 'missing' }
      ])
    ).toEqual({
      versions: [group(OLD_SOURCE, ['backup'], OLDER)],
      freshness: { status: 'latest', storageIds: ['backup'] }
    });
  });

  it('groups identical source across any number of storages despite different provider dates and revisions', () => {
    expect(
      compareNoteVersions([
        present('cloud-a', OLD_SOURCE, 'rev-99', NEWEST),
        present('cloud-b', OLD_SOURCE, 'rev-1', OLDER),
        present('third-cloud', OLD_SOURCE, 'opaque/unrelated', NEWER),
        present('local', OLD_SOURCE)
      ])
    ).toEqual({
      versions: [group(OLD_SOURCE, ['cloud-a', 'cloud-b', 'third-cloud', 'local'], OLDER)],
      freshness: { status: 'latest', storageIds: ['cloud-a', 'cloud-b', 'third-cloud', 'local'] }
    });
  });

  it('ranks document Modified instead of the upload time of an older copied file', () => {
    expect(
      compareNoteVersions([
        present('newly-uploaded-backup', OLD_SOURCE, '999', NEWEST),
        present('local', NEW_SOURCE, null, OLDER),
        present('another-cloud', NEW_SOURCE, '1', NEWER)
      ])
    ).toEqual({
      versions: [
        group(OLD_SOURCE, ['newly-uploaded-backup'], OLDER),
        group(NEW_SOURCE, ['local', 'another-cloud'], NEWER)
      ],
      freshness: { status: 'latest', storageIds: ['local', 'another-cloud'] }
    });
  });

  it.each([
    {
      earlier: '1969-12-31T23:59:59.999Z',
      earlierTime: -1,
      later: '1970-01-01T00:00:00.000Z',
      laterTime: 0
    },
    {
      earlier: '1969-12-31T23:59:59.998Z',
      earlierTime: -2,
      later: '1969-12-31T23:59:59.999Z',
      laterTime: -1
    }
  ])(
    'ranks valid Modified $laterTime ms above $earlierTime ms without treating zero or negative dates as unknown',
    ({ earlier, earlierTime, later, laterTime }) => {
      const historical = OLD_SOURCE.replace('2026-09-01T00:00:00.000Z', '1960-01-01T00:00:00.000Z');
      const earlierSource = historical.replace('2026-09-24T00:00:00.000Z', earlier);
      const laterSource = historical.replace('2026-09-24T00:00:00.000Z', later);
      expect(
        compareNoteVersions([present('cloud', earlierSource), present('local', laterSource)])
      ).toEqual({
        versions: [
          group(earlierSource, ['cloud'], earlierTime),
          group(laterSource, ['local'], laterTime)
        ],
        freshness: { status: 'latest', storageIds: ['local'] }
      });
    }
  );

  it.each([0, 1, 2])(
    'finds the newest copy at input position %i independently of storage order',
    newestIndex => {
      const ids = ['cloud-a', 'cloud-b', 'local'];
      const copies = ids.map((id, index) =>
        present(id, index === newestIndex ? NEW_SOURCE : OLD_SOURCE)
      );
      expect(compareNoteVersions(copies).freshness).toEqual({
        status: 'latest',
        storageIds: [ids[newestIndex]]
      });
    }
  );

  it('does not choose between different sources with the same maximum Modified', () => {
    expect(
      compareNoteVersions([present('cloud', OLD_SOURCE), present('local', OTHER_SOURCE)])
    ).toEqual({
      versions: [group(OLD_SOURCE, ['cloud'], OLDER), group(OTHER_SOURCE, ['local'], OLDER)],
      freshness: { status: 'undetermined', reason: 'same-modified' }
    });
  });

  it('can rank a newer version above an older tie', () => {
    expect(
      compareNoteVersions([
        present('cloud-a', OLD_SOURCE),
        present('cloud-b', OTHER_SOURCE),
        present('local', NEWEST_SOURCE)
      ])
    ).toEqual({
      versions: [
        group(OLD_SOURCE, ['cloud-a'], OLDER),
        group(OTHER_SOURCE, ['cloud-b'], OLDER),
        group(NEWEST_SOURCE, ['local'], NEWEST)
      ],
      freshness: { status: 'latest', storageIds: ['local'] }
    });
  });

  it('compares timestamps as instants while keeping differently written sources distinct', () => {
    const offset = OLD_SOURCE.replace('2026-09-24T00:00:00.000Z', '2026-09-24T03:00:00.000+03:00');
    expect(compareNoteVersions([present('cloud', OLD_SOURCE), present('local', offset)])).toEqual({
      versions: [group(OLD_SOURCE, ['cloud'], OLDER), group(offset, ['local'], OLDER)],
      freshness: { status: 'undetermined', reason: 'same-modified' }
    });
  });

  it('keeps LF and CRLF sources distinct even when their parsed cards are equal', () => {
    const crlf = OLD_SOURCE.replaceAll('\n', '\r\n');
    expect(compareNoteVersions([present('cloud', OLD_SOURCE), present('local', crlf)])).toEqual({
      versions: [group(OLD_SOURCE, ['cloud'], OLDER), group(crlf, ['local'], OLDER)],
      freshness: { status: 'undetermined', reason: 'same-modified' }
    });
  });

  it.each([
    ['legacy', LEGACY_SOURCE],
    ['future format', FUTURE_SOURCE],
    ['invalid timestamp', INVALID_TIME_SOURCE],
    ['unsupported metadata', UNKNOWN_METADATA_SOURCE]
  ])('retains %s verbatim and leaves freshness unknown even with a provider date', (_, source) => {
    expect(
      compareNoteVersions([present('cloud', NEW_SOURCE), present('local', source, null, NEWEST)])
    ).toEqual({
      versions: [group(NEW_SOURCE, ['cloud'], NEWER), group(source, ['local'], null)],
      freshness: { status: 'undetermined', reason: 'unknown-modified' }
    });
  });

  it('recognizes identical legacy sources without inventing a document date', () => {
    expect(
      compareNoteVersions([present('cloud', LEGACY_SOURCE), present('local', LEGACY_SOURCE)])
    ).toEqual({
      versions: [group(LEGACY_SOURCE, ['cloud', 'local'], null)],
      freshness: { status: 'undetermined', reason: 'unknown-modified' }
    });
  });

  it('does not treat an unavailable storage with no observed files as empty', () => {
    expect(compareNoteVersions([{ storageId: 'offline-cloud', status: 'unavailable' }])).toEqual({
      versions: [],
      freshness: { status: 'undetermined', reason: 'unavailable' }
    });
  });

  it('retains known versions but cannot confirm a global latest while another storage is unavailable', () => {
    expect(
      compareNoteVersions([
        present('local', NEW_SOURCE),
        { storageId: 'backup', status: 'unavailable' }
      ])
    ).toEqual({
      versions: [group(NEW_SOURCE, ['local'], NEWER)],
      freshness: { status: 'undetermined', reason: 'unavailable' }
    });
  });

  it('does not use matching opaque revisions as proof of equal content across storages', () => {
    expect(
      compareNoteVersions([
        present('cloud-a', OLD_SOURCE, 'same'),
        present('cloud-b', OTHER_SOURCE, 'same')
      ])
    ).toEqual({
      versions: [group(OLD_SOURCE, ['cloud-a'], OLDER), group(OTHER_SOURCE, ['cloud-b'], OLDER)],
      freshness: { status: 'undetermined', reason: 'same-modified' }
    });
  });

  it('leaves frozen inputs untouched and returns independent version and freshness collections', () => {
    const copies: readonly NoteCopy[] = Object.freeze([
      Object.freeze(present('cloud', NEW_SOURCE)),
      Object.freeze(present('local', NEW_SOURCE))
    ]);
    const expected = {
      versions: [group(NEW_SOURCE, ['cloud', 'local'], NEWER)],
      freshness: { status: 'latest', storageIds: ['cloud', 'local'] }
    };
    const result = compareNoteVersions(copies);
    expect(result).toEqual(expected);
    result.versions[0].storageIds.push('only-in-returned-group');
    expect(result.freshness).toEqual(expected.freshness);
    expect(compareNoteVersions(copies)).toEqual(expected);
  });
});
