import type { BoardRefreshCache, BoardRefreshRecord } from '../application/loadBoard';
import { checkIsMarkdownFilename } from '../domain/markdownFilename';
import { getStorageSession } from './storageSession';

const prefix = 'markdown-cards:board-refresh:v1:';
const fallback = new Map<string, BoardRefreshRecord>();
const unavailable = new Set<string>();
const running = new Map<string, Promise<void>>();

function parse(value: string | null): BoardRefreshRecord | null {
  if (!value) return null;
  try {
    const record = JSON.parse(value);
    if (!record || !Number.isFinite(record.checkedAt) || record.checkedAt < 0
      || (record.error !== null && typeof record.error !== 'string')
      || !Array.isArray(record.failedFilenames) || !record.failedFilenames.every((name: unknown) => typeof name === 'string')
      || !Array.isArray(record.cachedFilenames) || !record.cachedFilenames.every((name: unknown) => typeof name === 'string')
      || (record.files !== null && (!Array.isArray(record.files) || !record.files.every((file: { name?: unknown; path?: unknown }) =>
        file && checkIsMarkdownFilename(file.name) && typeof file.path === 'string')))) return null;
    // Older snapshots mixed parser/storage failures with failed cloud requests.
    // Discard only those ambiguous badges, keeping the interval and file hints.
    const { requestFailuresOnly, ...snapshot } = record;
    return { ...snapshot, failedFilenames: requestFailuresOnly === true ? snapshot.failedFilenames : [] };
  } catch { return null; }
}

// Only listing hints and the refresh time are stored here; Markdown stays in IndexedDB.
export function boardRefreshCache(): BoardRefreshCache | null {
  const contextId = getStorageSession()?.descriptor?.contextId;
  if (!contextId) return null;
  const key = prefix + contextId;
  return {
    read() {
      if (unavailable.has(key)) return fallback.get(key) ?? null;
      try { return parse(localStorage.getItem(key)); }
      catch { return fallback.get(key) ?? null; }
    },
    write(record) {
      fallback.set(key, structuredClone(record));
      try { localStorage.setItem(key, JSON.stringify({ ...record, requestFailuresOnly: true })); }
      catch { unavailable.add(key); }
    },
    async run(task, signal) {
      if (navigator.locks?.request) {
        await navigator.locks.request(key, { signal }, async () => { if (!signal.aborted) await task(); });
        return;
      }
      const previous = running.get(key) ?? Promise.resolve();
      const current = previous.catch(() => {}).then(async () => { if (!signal.aborted) await task(); });
      running.set(key, current);
      try { await current; }
      finally { if (running.get(key) === current) running.delete(key); }
    }
  };
}
