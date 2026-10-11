import type { Card, CardId } from '../domain/types';

// The existing Card projection cache, keyed by Card ID, not Markdown filename.
// This is not a draft/outbox save or a persisted domain StoredCard/SyncState.
export interface LocalCardRepository {
  // Only absence returns null; storage failures reject.
  read(id: CardId): Promise<Card | null>;
  // Complete list in ascending IndexedDB primary-key order; [] for an empty cache.
  list(): Promise<Card[]>;
  // Preserve Card fields/timestamps and the deployed meta.title index alias.
  // Writes fulfil only after commit and capture input before the first await.
  write(card: Readonly<Card>): Promise<void>;
  // Low-level removal, idempotent for a missing ID. Cleanup eligibility belongs
  // to the caller; this operation does not remove a draft, source or queue row.
  delete(id: CardId): Promise<void>;
}
