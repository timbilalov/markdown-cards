import { derived, writable, type Writable, type Readable } from 'svelte/store';
import type { OpenedCardDocument } from './cardStore';
import type { Card } from '../domain/types';
import type { CloudFile, SyncStatus } from '../types/cloud';
import type { SyncStatus as DeliveryStatus } from '../application/cardSync';

export interface AppState {
  dbInitialized: boolean; dbError: string | null;
  files: CloudFile[]; authenticated: boolean; cloudStatus: SyncStatus;
  card: Card | null; document: OpenedCardDocument | null;
  loading: boolean; loadSource: 'indexeddb' | 'cloud' | null; loadTime: number; loadWarning: string | null;
  saving: boolean; saveError: string | null; saveMessage: string | null;
  offline: boolean; delivery: DeliveryStatus | 'idle';
}
const state = writable<AppState>({
  dbInitialized: false, dbError: null,
  files: [], authenticated: false, cloudStatus: { isSyncing: false, lastSync: null, error: null },
  card: null, document: null, loading: false, loadSource: null, loadTime: 0, loadWarning: null,
  saving: false, saveError: null, saveMessage: null, offline: false, delivery: 'idle'
});
export const appState: Readable<AppState> = { subscribe: state.subscribe };

// Named views for Svelte bindings share one state; Svelte's $ syntax
// automatically releases the subscription with its component.
export function stateField<K extends keyof AppState>(key: K): Writable<AppState[K]> {
  return {
    subscribe: derived(state, value => value[key]).subscribe,
    set: value => state.update(current => ({ ...current, [key]: value })),
    update: change => state.update(current => ({ ...current, [key]: change(current[key]) }))
  };
}
