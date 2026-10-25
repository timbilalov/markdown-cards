import { reconcileBoardCards } from '../domain/board';
import { parseCloudModifiedTime } from '../utils/cloudMetadata';
import type { BoardCard, BoardLocalEntry, Card } from '../domain/types';
import type { CloudFile } from '../types/cloud';

export const BOARD_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
export type BoardCardLoadResult =
  | { status: 'loaded'; card: Card }
  | { status: 'unprojected' }
  | { status: 'unavailable' };
export interface BoardRefreshRecord {
  checkedAt: number;
  files: CloudFile[] | null;
  failedFilenames: string[];
  error: string | null;
  cachedFilenames: string[];
}
export interface BoardRefreshCache {
  read(): BoardRefreshRecord | null;
  write(record: BoardRefreshRecord): void;
  run(task: () => Promise<void>, signal: AbortSignal): Promise<void>;
}
export interface BoardLoadState {
  cards: BoardCard[]; loading: boolean; offline: boolean;
  source: 'indexeddb' | 'cloud' | 'mixed'; elapsed: number; error: string | null;
  progress: { completed: number; total: number } | null;
  pendingFilenames: string[];
  failedFilenames: string[];
  nextRefreshAt: number | null;
}
export interface BoardDependencies {
  init(): Promise<void>; readLocal(): Promise<BoardLocalEntry[]>;
  sync(signal?: AbortSignal): Promise<void>; files(): CloudFile[]; load(file: CloudFile, signal?: AbortSignal, forceRefresh?: boolean): Promise<BoardCardLoadResult>;
  checkIsOffline(): boolean; clock(): number;
  cloudError?(): string | null;
  refreshCache?(): BoardRefreshCache | null;
  now?(): number;
}
export async function loadBoard(deps: BoardDependencies, publish: (state: BoardLoadState) => void,
  signal: AbortSignal): Promise<void> {
  await createBoardLoader(deps, publish, signal).load();
}

export interface BoardLoader {
  load(): Promise<void>;
  refresh(): Promise<void>;
  retry(filename: string): Promise<void>;
}

export function createBoardLoader(deps: BoardDependencies, publish: (state: BoardLoadState) => void,
  signal: AbortSignal): BoardLoader {
  let start = deps.clock();
  const now = () => deps.now?.() ?? Date.now();
  let cards: BoardCard[] = [];
  let source: BoardLoadState['source'] = 'indexeddb';
  let error: string | null = null;
  let offline = false;
  let loading = true;
  let progress: BoardLoadState['progress'] = null;
  let pendingFilenames: string[] = [];
  let failedFilenames: string[] = [];
  const retryingFilenames = new Set<string>();
  let files = new Map<string, CloudFile>();
  let cache: BoardRefreshCache | null = null;
  let checkedAt: number | null = null;
  let listed = false;
  let hasPublished = false;
  let cachedFilenames: string[] = [];
  const persist = () => {
    // A pending retry has not resolved the original request failure yet.
    if (checkedAt !== null) cache?.write({ checkedAt, files: listed ? [...files.values()] : null,
      failedFilenames: [...new Set([...failedFilenames, ...retryingFilenames])], error, cachedFilenames });
  };
  const emit = () => {
    if (!signal.aborted) {
      hasPublished = true;
      publish({ cards, source, error, offline, loading, progress, pendingFilenames, failedFilenames,
        nextRefreshAt: checkedAt === null ? null : checkedAt + BOARD_REFRESH_INTERVAL_MS, elapsed: deps.clock() - start });
    }
  };
  async function refresh(filename: string, forceRefresh = false): Promise<void> {
    let result: BoardCardLoadResult = { status: 'unprojected' };
    try {
      result = forceRefresh ? await deps.load(files.get(filename)!, signal, true)
        : await deps.load(files.get(filename)!, signal);
    } catch { /* Unexpected local failures do not establish a cloud request error. */ }
    if (signal.aborted) return;
    if (result.status === 'loaded') {
      const loaded = result.card;
      if (!cachedFilenames.includes(filename)) cachedFilenames = [...cachedFilenames, filename];
      // Document dates are shared by cached and downloaded displays.
      cards = cards.map(card => {
        if (card.filename !== filename) return card;
        const display: BoardCard = { ...card, title: loaded.title, status: loaded.status,
          image: loaded.image, modified: loaded.meta.modified };
        delete display.readOnly;
        return display;
      });
    }
    if (result.status === 'unavailable') {
      if (!failedFilenames.includes(filename)) failedFilenames = [...failedFilenames, filename];
    } else failedFilenames = failedFilenames.filter(failed => failed !== filename);
    pendingFilenames = pendingFilenames.filter(pending => pending !== filename);
  }
  async function load(forceRefresh: boolean): Promise<void> {
    start = deps.clock();
    loading = true;
    progress = null;
    error = null;
    if (hasPublished) emit();
    try {
      await deps.init();
      if (signal.aborted) return;
      let local = await deps.readLocal();
      if (signal.aborted) return;
      cards = reconcileBoardCards(local, []).cards;
      source = 'indexeddb';
      offline = deps.checkIsOffline();
      emit();
      cache = deps.refreshCache?.() ?? null;
      const update = async () => {
        if (signal.aborted) return;
        const saved = cache?.read();
        listed = saved?.files != null;
        files = new Map((saved?.files ?? []).map(file => [file.name.slice(0, -3), file]));
        // A queued tab must read the cache populated by the previous lock owner.
        if (cache) local = await deps.readLocal();
        if (signal.aborted) return;
        const localNames = new Set(local.map(card => card.filename ?? ('meta' in card ? card.meta.id : '')));
        cachedFilenames = [...localNames];
        const canReuse = saved && (saved.files !== null || saved.error !== null)
          && saved.cachedFilenames.every(filename => localNames.has(filename));
        if (!forceRefresh && canReuse && now() >= saved.checkedAt && now() - saved.checkedAt < BOARD_REFRESH_INTERVAL_MS) {
          checkedAt = saved.checkedAt;
          cards = reconcileBoardCards(local, [...files].map(([filename, file]) => ({ filename, modified: parseCloudModifiedTime(file.modified) }))).cards;
          failedFilenames = saved.failedFilenames.filter(filename => files.has(filename));
          error = saved.error;
          return;
        }
        checkedAt = now();
        failedFilenames = [];
        // Record attempts too, so an unavailable provider is not polled on every visit.
        cache?.write({ checkedAt, files: saved?.files ?? null, failedFilenames: saved?.failedFilenames ?? [], error: saved?.error ?? null, cachedFilenames });
        try {
          await deps.sync(signal);
          if (signal.aborted) return;
          offline = deps.checkIsOffline();
          error = deps.cloudError?.() ?? null;
          if (!offline && !error) {
            files = new Map(deps.files().filter(file => file.name.endsWith('.md'))
              .map(file => [file.name.slice(0, -3), file]));
            const metadata = [...files].map(([filename, file]) => ({ filename, modified: parseCloudModifiedTime(file.modified) }));
            const projected = reconcileBoardCards(local, metadata);
            listed = true;
            cards = projected.cards;
            source = local.length && files.size ? 'mixed' : files.size ? 'cloud' : 'indexeddb';
            const refreshFilenames = forceRefresh ? [...files.keys()] : projected.refreshFilenames;
            progress = { completed: 0, total: refreshFilenames.length };
            pendingFilenames = [...refreshFilenames];
            persist();
            if (pendingFilenames.length) emit();
            for (const filename of refreshFilenames) {
              if (signal.aborted) return;
              await refresh(filename, forceRefresh);
              if (signal.aborted) return;
              progress = { completed: progress.completed + 1, total: progress.total };
              emit();
            }
          }
        } catch (failure) { offline = true; error = failure instanceof Error ? failure.message : 'Cloud unavailable'; }
        finally {
          if (!signal.aborted) checkedAt = now();
          persist();
        }
      };
      if (cache) await cache.run(update, signal);
      else await update();
    } catch (failure) { error = failure instanceof Error ? failure.message : 'Local storage unavailable'; }
    loading = false;
    emit();
  }
  let activeLoad: Promise<void> | undefined;
  const run = (forceRefresh: boolean) => {
    if (signal.aborted || pendingFilenames.length) return activeLoad ?? Promise.resolve();
    activeLoad ??= load(forceRefresh).finally(() => { activeLoad = undefined; });
    return activeLoad;
  };
  return {
    load: () => run(false),
    refresh: () => run(true),
    async retry(filename) {
      if (signal.aborted || (activeLoad && progress === null)
        || !failedFilenames.includes(filename) || pendingFilenames.includes(filename)) return;
      retryingFilenames.add(filename);
      pendingFilenames = [...pendingFilenames, filename];
      failedFilenames = failedFilenames.filter(failed => failed !== filename);
      emit();
      const update = async () => {
        if (signal.aborted) return;
        await refresh(filename, true);
        if (signal.aborted) return;
        retryingFilenames.delete(filename);
        const saved = cache?.read();
        // Another tab may have refreshed the listing since this board opened.
        // A retry owns only this note's result, not the full refresh snapshot.
        if (saved) cache?.write({ ...saved,
          failedFilenames: [...saved.failedFilenames.filter(failed => failed !== filename),
            ...failedFilenames.filter(failed => failed === filename)],
          cachedFilenames: [...new Set([...saved.cachedFilenames, ...cachedFilenames.filter(cached => cached === filename)])] });
        else persist();
      };
      try {
        if (cache) await cache.run(update, signal);
        else await update();
      } catch (failure) {
        if (!signal.aborted) {
          console.warn('Failed to retry board note:', failure);
          if (!failedFilenames.includes(filename)) failedFilenames = [...failedFilenames, filename];
          pendingFilenames = pendingFilenames.filter(pending => pending !== filename);
        }
      } finally {
        // An aborted main queue may still persist after this queued retry exits.
        if (!signal.aborted) retryingFilenames.delete(filename);
        emit();
      }
    }
  };
}
