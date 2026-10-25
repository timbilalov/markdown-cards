import type { StorageSnapshot, StoredNoteSnapshot } from '../domain/storageSync';
import { checkIsMarkdownFilename } from '../domain/markdownFilename';
import type { NoteStorageReader } from '../ports/noteStorage';

export interface StorageInventoryProgress {
  phase: 'listing' | 'reading';
  completed: number;
  total: number;
}

// Complete listings establish absence; failures retain named unreadable copies.
// One shared pool bounds source reads across all providers and local contexts.
export async function readStorageInventory(
  sources: readonly (NoteStorageReader | { id: string; unavailable: true })[],
  signal?: AbortSignal,
  onProgress?: (progress: StorageInventoryProgress) => void
): Promise<StorageSnapshot[]> {
  const publish = (progress: StorageInventoryProgress) => {
    if (!signal?.aborted) onProgress?.(progress);
  };
  let listedCount = 0;
  publish({ phase: 'listing', completed: 0, total: sources.length });
  const listed = await Promise.all(
    sources.map(async source => {
      try {
        if ('unavailable' in source || signal?.aborted) return null;
        const result = await source.list();
        if (signal?.aborted || result.status !== 'success') return null;
        const paths = new Set<string>();
        for (const entry of result.entries) {
          if (!checkIsMarkdownFilename(entry.path) || paths.has(entry.path)) return null;
          paths.add(entry.path);
        }
        return { source, entries: result.entries };
      } catch {
        return null;
      } finally {
        publish({ phase: 'listing', completed: ++listedCount, total: sources.length });
      }
    })
  );
  const notes = listed.map(
    result =>
      result?.entries.map(
        entry => ({ path: entry.path, status: 'unavailable' }) as StoredNoteSnapshot
      ) ?? []
  );
  const tasks = listed.flatMap((result, index) =>
    result
      ? result.entries.map((entry, noteIndex) => ({
          source: result.source,
          entry,
          index,
          noteIndex
        }))
      : []
  );
  let next = 0;
  let completed = 0;
  publish({ phase: 'reading', completed, total: tasks.length });
  await Promise.all(
    Array.from({ length: Math.min(4, tasks.length) }, async () => {
      while (!signal?.aborted) {
        const task = tasks[next++];
        if (!task) return;
        try {
          const read = await task.source.read(task.entry.path, signal);
          if (signal?.aborted) return;
          if (
            read.status === 'found' &&
            read.document.path === task.entry.path &&
            typeof read.document.source === 'string'
          ) {
            const { source, revision } = read.document;
            // A listing hint is separate from document Modified. With no provider
            // revisions it cannot prove that list/read observed the same version.
            notes[task.index][task.noteIndex] = {
              path: task.entry.path,
              status: 'present',
              source,
              revision,
              ...(task.entry.modifiedAt !== undefined && task.entry.revision === revision
                ? { storageModifiedAt: task.entry.modifiedAt }
                : {})
            };
          }
        } catch {
          /* The known filename stays unavailable; other reads continue. */
        } finally {
          publish({ phase: 'reading', completed: ++completed, total: tasks.length });
        }
      }
    })
  );
  return sources.map((source, index) =>
    listed[index] && !signal?.aborted
      ? { storageId: source.id, status: 'available', notes: notes[index] }
      : { storageId: source.id, status: 'unavailable' }
  );
}
