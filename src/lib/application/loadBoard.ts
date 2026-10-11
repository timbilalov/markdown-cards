import { reconcileBoardCards } from '../domain/board';
import { parseCloudModifiedTime } from '../utils/cloudMetadata';
import type { BoardCard, BoardLocalEntry, Card } from '../domain/types';
import type { CloudFile } from '../types/cloud';
export interface BoardLoadState {
  cards: BoardCard[]; loading: boolean; offline: boolean;
  source: 'indexeddb' | 'cloud' | 'mixed'; elapsed: number; error: string | null;
}
export interface BoardDependencies {
  init(): Promise<void>; readLocal(): Promise<BoardLocalEntry[]>;
  sync(signal?: AbortSignal): Promise<void>; files(): CloudFile[]; load(file: CloudFile, signal?: AbortSignal): Promise<Card | null>;
  checkIsOffline(): boolean; clock(): number;
  cloudError?(): string | null;
}
export async function loadBoard(deps: BoardDependencies, publish: (state: BoardLoadState) => void,
  signal: AbortSignal): Promise<void> {
  const start = deps.clock();
  let cards: BoardCard[] = [];
  let source: BoardLoadState['source'] = 'indexeddb';
  let error: string | null = null;
  let offline = false;
  const emit = () => {
    if (!signal.aborted) publish({ cards, source, error, offline, loading: false, elapsed: deps.clock() - start });
  };
  try {
    await deps.init();
    if (signal.aborted) return;
    const local = await deps.readLocal();
    if (signal.aborted) return;
    cards = reconcileBoardCards(local, []).cards;
    if (cards.length) emit();
    try {
      await deps.sync(signal);
      if (signal.aborted) return;
      offline = deps.checkIsOffline();
      error = deps.cloudError?.() ?? null;
      if (!offline && !error) {
        const files = new Map(deps.files().filter(file => file.name.endsWith('.md'))
          .map(file => [file.name.slice(0, -3), file]));
        const metadata = [...files].map(([filename, file]) => ({ filename, modified: parseCloudModifiedTime(file.modified) }));
        const projected = reconcileBoardCards(local, metadata);
        if (local.length) {
          for (const filename of projected.refreshFilenames) {
            if (signal.aborted) return;
            const file = files.get(filename);
            const display = projected.cards.find(card => card.filename === filename);
            if (!file || !display) continue;
            try {
              const loaded = await deps.load(file, signal);
              if (signal.aborted) return;
              if (loaded) {
                display.title = loaded.title; display.status = loaded.status; display.image = loaded.image;
                delete display.readOnly;
                if (parseCloudModifiedTime(file.modified) === undefined) display.modified = loaded.meta.modified;
              }
            } catch { /* Keep the complete local display when a single read fails. */ }
          }
        }
        cards = projected.cards;
        source = local.length && files.size ? 'mixed' : files.size ? 'cloud' : 'indexeddb';
      }
    } catch (failure) { offline = true; error = failure instanceof Error ? failure.message : 'Cloud unavailable'; }
  } catch (failure) { error = failure instanceof Error ? failure.message : 'Local storage unavailable'; }
  emit();
}
