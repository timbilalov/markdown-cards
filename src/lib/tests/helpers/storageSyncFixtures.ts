import type {
  NoteCopy,
  NoteVersionGroup,
  StorageSnapshot,
  StoredNoteVersion,
  StoredNoteSnapshot
} from '../../domain/storageSync';
import minimal from '../fixtures/v1-minimal.md?raw';

export const OLDER = Date.parse('2026-09-24T00:00:00.000Z');
export const NEWER = Date.parse('2026-09-25T00:00:00.000Z');
export const NEWEST = Date.parse('2026-09-26T00:00:00.000Z');
export const OLD_SOURCE = minimal;
export const NEW_SOURCE = minimal.replace('2026-09-24T00:00:00.000Z', '2026-09-25T00:00:00.000Z');
export const NEWEST_SOURCE = minimal.replace(
  '2026-09-24T00:00:00.000Z',
  '2026-09-26T00:00:00.000Z'
);
export const OTHER_SOURCE = minimal.replace('Минимальная карточка', 'Другая версия 🗂');
export const LEGACY_SOURCE = '# Legacy note\r\n\r\nExact text ✓\r\n';
export const FUTURE_SOURCE = minimal.replace('markdown-cards: 1', 'markdown-cards: 99');
export const INVALID_TIME_SOURCE = minimal.replace('2026-09-24T00:00:00.000Z', 'not-a-date');
export const UNKNOWN_METADATA_SOURCE = minimal + '\n### External revision\n\nKEEP\n';

// Golden inputs/expectations never invoke any of the new domain functions.
export function note(
  path: string,
  source: string,
  revision: string | null = null,
  storageModifiedAt?: number
): StoredNoteVersion {
  return {
    path,
    status: 'present',
    source,
    revision,
    ...(storageModifiedAt === undefined ? {} : { storageModifiedAt })
  };
}

export function available(
  storageId: string,
  notes: readonly StoredNoteSnapshot[] = []
): StorageSnapshot {
  return { storageId, status: 'available', notes };
}

export function present(
  storageId: string,
  source: string,
  revision: string | null = null,
  storageModifiedAt?: number
): NoteCopy {
  return {
    storageId,
    status: 'present',
    source,
    revision,
    ...(storageModifiedAt === undefined ? {} : { storageModifiedAt })
  };
}

export function group(
  source: string,
  storageIds: string[],
  modifiedAt: number | null
): NoteVersionGroup {
  return { source, storageIds, modifiedAt };
}
