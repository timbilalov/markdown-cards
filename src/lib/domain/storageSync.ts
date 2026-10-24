import { parseMarkdownDocument } from './markdown';
import { checkIsMarkdownFilename } from './markdownFilename';

// Storage IDs identify configured instances, not provider types. Callers supply
// unique IDs, unique paths per listing and a complete snapshot of each storage
// (including the local one).
// These values contain exact source text; a provider date is display metadata.
export interface NoteVersion {
  source: string;
  revision: string | null;
  storageModifiedAt?: number;
}

export interface StoredNoteVersion extends NoteVersion {
  path: string;
  status: 'present';
}

// A successful listing establishes the filename even when its content cannot
// be read. Such an entry is neither missing nor a failure of the whole listing.
export type StoredNoteSnapshot = StoredNoteVersion | { path: string; status: 'unavailable' };

export type StorageSnapshot =
  | { storageId: string; status: 'available'; notes: readonly StoredNoteSnapshot[] }
  | { storageId: string; status: 'unavailable' };

export type NoteCopy =
  | ({ storageId: string; status: 'present' } & NoteVersion)
  | { storageId: string; status: 'missing' }
  | { storageId: string; status: 'unavailable' };

export interface NoteVersionGroup {
  source: string;
  storageIds: string[];
  // Modified from a fully supported v1 document, never the provider date.
  modifiedAt: number | null;
}

export type NoteFreshness =
  | { status: 'empty' }
  | { status: 'latest'; storageIds: string[] }
  | { status: 'undetermined'; reason: 'unavailable' | 'unknown-modified' | 'same-modified' };

export interface NoteComparison {
  versions: NoteVersionGroup[];
  freshness: NoteFreshness;
}

export interface NoteInventoryRow {
  path: string;
  copies: NoteCopy[];
  comparison: NoteComparison;
}

export interface NoteSyncSelection {
  paths: readonly string[];
  sourceStorageId: string;
  targetStorageIds: readonly string[];
}

export type ExpectedTargetNote =
  { status: 'missing' } | { status: 'present'; source: string; revision: string | null };

interface NoteSyncAddress {
  path: string;
  sourceStorageId: string;
  targetStorageId: string;
}

export type NoteSyncAction = NoteSyncAddress &
  (
    | {
        status: 'copy';
        source: string;
        sourceRevision: string | null;
        expectedTarget: ExpectedTargetNote;
      }
    | { status: 'skip'; reason: 'same-storage' | 'identical' | 'source-missing' }
    | {
        status: 'blocked';
        reason:
          | 'unknown-source'
          | 'unknown-target'
          | 'source-unavailable'
          | 'target-unavailable'
          | 'invalid-path'
          | 'context-changed';
      }
  );

export interface NoteSyncPlan {
  actions: NoteSyncAction[];
}

// This key is persisted in manual-sync plans and the journal.
export function noteStorageTargetKey(storage: {
  id: string;
  kind: 'cloud' | 'local';
  contextId: string | null;
}): string {
  return `${storage.kind}:${storage.contextId ?? storage.id}`;
}

// Groups retain first-seen order and exact sources, including unsupported text.
export function compareNoteVersions(copies: readonly NoteCopy[]): NoteComparison {
  const groups = new Map<string, NoteVersionGroup>();
  let checkHasUnavailable = false;

  for (const copy of copies) {
    if (copy.status === 'unavailable') checkHasUnavailable = true;
    if (copy.status !== 'present') continue;
    let group = groups.get(copy.source);
    if (!group) {
      const parsed = parseMarkdownDocument(copy.source);
      group = {
        source: copy.source,
        storageIds: [],
        modifiedAt: parsed.status === 'success' ? parsed.document.card.meta.modified : null
      };
      groups.set(copy.source, group);
    }
    group.storageIds.push(copy.storageId);
  }

  const versions = Array.from(groups.values());
  if (checkHasUnavailable)
    return { versions, freshness: { status: 'undetermined', reason: 'unavailable' } };
  if (versions.length === 0) return { versions, freshness: { status: 'empty' } };

  let latestModifiedAt = -Infinity;
  for (const version of versions) {
    if (version.modifiedAt === null) {
      return { versions, freshness: { status: 'undetermined', reason: 'unknown-modified' } };
    }
    latestModifiedAt = Math.max(latestModifiedAt, version.modifiedAt);
  }
  const latest = versions.filter(version => version.modifiedAt === latestModifiedAt);
  return {
    versions,
    freshness:
      latest.length === 1
        ? { status: 'latest', storageIds: [...latest[0].storageIds] }
        : { status: 'undetermined', reason: 'same-modified' }
  };
}

type IndexedStorage =
  | { status: 'available'; notes: ReadonlyMap<string, StoredNoteSnapshot> }
  | { status: 'unavailable' };

function indexSnapshots(snapshots: readonly StorageSnapshot[]): Map<string, IndexedStorage> {
  return new Map(
    snapshots.map(snapshot => [
      snapshot.storageId,
      snapshot.status === 'available'
        ? { status: 'available', notes: new Map(snapshot.notes.map(note => [note.path, note])) }
        : { status: 'unavailable' }
    ])
  );
}

function readNoteCopy(storageId: string, storage: IndexedStorage, path: string): NoteCopy {
  if (storage.status === 'unavailable') return { storageId, status: 'unavailable' };
  const note = storage.notes.get(path);
  if (!note) return { storageId, status: 'missing' };
  if (note.status === 'unavailable') return { storageId, status: 'unavailable' };
  return {
    storageId,
    status: 'present',
    source: note.source,
    revision: note.revision,
    ...(note.storageModifiedAt === undefined ? {} : { storageModifiedAt: note.storageModifiedAt })
  };
}

// Rows retain first-seen filename order; copies retain snapshot order. Filenames
// are case-sensitive here. Provider-specific path collisions must be checked by
// the execution boundary before writes to a case-insensitive storage.
export function buildNoteInventory(snapshots: readonly StorageSnapshot[]): NoteInventoryRow[] {
  const storages = indexSnapshots(snapshots);
  const paths = new Set<string>();
  for (const storage of storages.values()) {
    if (storage.status === 'available') {
      for (const path of storage.notes.keys()) paths.add(path);
    }
  }
  return Array.from(paths, path => {
    const copies = Array.from(storages, ([storageId, storage]) =>
      readNoteCopy(storageId, storage, path)
    );
    return { path, copies, comparison: compareNoteVersions(copies) };
  });
}

function planNoteCopy(
  storages: ReadonlyMap<string, IndexedStorage>,
  address: NoteSyncAddress
): NoteSyncAction {
  if (!checkIsMarkdownFilename(address.path))
    return { ...address, status: 'blocked', reason: 'invalid-path' };
  const sourceStorage = storages.get(address.sourceStorageId);
  const targetStorage = storages.get(address.targetStorageId);
  if (!sourceStorage) return { ...address, status: 'blocked', reason: 'unknown-source' };
  if (!targetStorage) return { ...address, status: 'blocked', reason: 'unknown-target' };
  if (address.sourceStorageId === address.targetStorageId) {
    return { ...address, status: 'skip', reason: 'same-storage' };
  }

  const source = readNoteCopy(address.sourceStorageId, sourceStorage, address.path);
  if (source.status === 'unavailable')
    return { ...address, status: 'blocked', reason: 'source-unavailable' };
  if (source.status === 'missing') return { ...address, status: 'skip', reason: 'source-missing' };
  const target = readNoteCopy(address.targetStorageId, targetStorage, address.path);
  if (target.status === 'unavailable')
    return { ...address, status: 'blocked', reason: 'target-unavailable' };
  if (target.status === 'present' && target.source === source.source) {
    return { ...address, status: 'skip', reason: 'identical' };
  }
  return {
    ...address,
    status: 'copy',
    source: source.source,
    sourceRevision: source.revision,
    expectedTarget:
      target.status === 'missing'
        ? { status: 'missing' }
        : { status: 'present', source: target.source, revision: target.revision }
  };
}

// A plan is a detached observation, not permission to write without rechecking.
// Source selection is explicit, independent of freshness or the active cloud.
// Each distinct selected path/target has one result, in path then target order.
// Execution, capabilities, locks, outbox and acknowledgements belong to later
// application/adapters work. The plan itself performs no storage I/O.
export function planNoteSync(
  snapshots: readonly StorageSnapshot[],
  selection: Readonly<NoteSyncSelection>
): NoteSyncPlan {
  const storages = indexSnapshots(snapshots);
  const targets = new Set(selection.targetStorageIds);
  const actions: NoteSyncAction[] = [];
  for (const path of new Set(selection.paths)) {
    for (const targetStorageId of targets) {
      actions.push(
        planNoteCopy(storages, {
          path,
          sourceStorageId: selection.sourceStorageId,
          targetStorageId
        })
      );
    }
  }
  return { actions };
}
