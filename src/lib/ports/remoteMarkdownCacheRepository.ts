import type { Card } from '../domain/types';

export interface RemoteMarkdownCacheRefresh {
  // Validated filename without the final .md; independent of Card ID.
  filename: string;
  source: string;
  // Strictly decoded from source by the caller, or null for refused Markdown.
  card: Card | null;
  // Captured before download. Card is the exact cached projection read for the
  // incoming Card ID (including the stored meta.title alias), or null if absent.
  // Its fields must match, regardless of object-property insertion order.
  expected: { source: string | null; card: Card | null };
}

export type RemoteMarkdownCacheResult =
  | { status: 'updated' }
  | { status: 'retained'; reason: 'local-work' | 'changed' };

// Atomic cache replacement, not Save, delivery acknowledgement or conflict
// resolution. Borrow an existing v5 connection; no cloud I/O or schema changes.
export interface RemoteMarkdownCacheRepository {
  // Capture input before yielding. In ONE readwrite transaction over cards,
  // markdownDocuments, localMarkdownSnapshots, outbox and legacy syncQueue:
  //
  // 1. Retain on local work: any snapshot at filename, or a strict v1 snapshot
  //    whose Card ID matches the incoming Card. When writing a Card, a snapshot
  //    with undecodable source also blocks: its ownership cannot be established.
  //    Non-completed outbox/legacy rows block by relative .md path OR Card ID
  //    (legacy card.meta.id or top-level cardId for deletes). Completed history
  //    alone does not block a refresh.
  // 2. Otherwise retain if cached source differs from expected.source, or the
  //    Card being replaced differs from expected.card. Null means absence.
  //    For card=null, only the source is compared and written.
  // 3. Otherwise write exact source and, if supplied, Card plus meta.title alias
  //    atomically. Preserve timestamps and every draft/operation/unrelated row.
  //
  // Local-work takes precedence over changed. All results wait for commit;
  // failures reject after rollback with the original error, without retry.
  // Do not mark conflicts, acknowledge/recover work or regenerate Markdown.
  refresh(input: Readonly<RemoteMarkdownCacheRefresh>): Promise<RemoteMarkdownCacheResult>;
}
