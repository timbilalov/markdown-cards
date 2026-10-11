import type {
  OutboxDeliveryOutcome, OutboxDraft, OutboxOperation, OutboxRetryPolicy, OutboxTransition
} from '../domain/outbox';
import type { MarkdownDocument } from '../domain/types';
import type { StoredMarkdownSource } from './markdownSourceRepository';

// The caller supplies one validated v1 document and a validated relative .md
// path. Card ID and exact source are derived from that same document, not from
// separately supplied values. IDs, timestamps, base and intent belong to the
// caller; the repository does not parse, serialize or contact the cloud.
export type CardSaveDraft = Omit<OutboxDraft, 'cardId' | 'source'> & {
  document: MarkdownDocument;
};

// New records in the existing localMarkdownSnapshots store. Historical rows
// without saveId remain untouched; they are not silently enrolled in outbox.
// filename is the path with only its final .md suffix removed, not Card ID.
export interface SavedMarkdownDraft {
  filename: string;
  source: string;
  saveMode: 'create' | 'update';
  saveId: string;
}

// Historical snapshots have no Save ID and must remain readable as local work.
export type StoredMarkdownDraft = Omit<SavedMarkdownDraft, 'saveId'> & { saveId?: string };

export interface CardSaveSnapshot {
  draft: StoredMarkdownDraft | null;
  // Only the row addressed by draft.saveId, even if its payload disagrees with
  // the draft. Null means no link or a missing row, not successful delivery.
  operation: OutboxOperation | null;
  remote: StoredMarkdownSource | null;
}

export interface CardSaveDelivery {
  deliveryId: string;
  now: number;
  outcome: OutboxDeliveryOutcome;
  policy: OutboxRetryPolicy;
}

export type CardSaveDeliveryResult =
  | { status: 'missing' }
  | Extract<OutboxTransition, { status: 'ignored' }>
  | {
      status: 'changed';
      operation: OutboxOperation;
      // retained: non-successful delivery left drafts/cache untouched.
      // Other values describe acknowledgement of a successful delivery.
      draft: 'confirmed' | 'superseded' | 'missing' | 'retained';
    };

export interface CardSaveRepository {
  // Read current draft, its linked operation and cached remote source in ONE
  // readonly transaction. The caller supplies a validated relative .md path;
  // strip only its final suffix to address the filename-based stores.
  // Preserve all fields, exact sources, legacy drafts and every outbox state.
  // Do not infer a link by Card ID, path, timestamps or another operation; an
  // orphan retains its saveId with operation=null. Return inconsistent linked
  // data verbatim for the application to diagnose, never silently repair it.
  //
  // Return detached records only after commit, including absent data. Storage
  // failures reject after abort, with original errors and no automatic retry.
  // No writes, parsing, migration, schema repair, cloud I/O or open/close here.
  // This is a storage snapshot, not a sync-state or delivery-eligibility policy.
  readCurrent(path: string): Promise<CardSaveSnapshot>;

  // Commit Card projection (including meta.title index alias), current draft
  // and a fresh pending outbox operation in ONE readwrite transaction. Capture
  // nested input before yielding. Return the committed operation, detached
  // from both caller input and storage. Do not change document timestamps.
  //
  // A duplicate Save ID rejects even for equal content or a completed operation,
  // rolling back all writes. A new ID may replace the addressed current draft;
  // preserve every older outbox row, other draft, remote source and legacy row.
  // Fulfil only after commit; failures reject after rollback, without retries.
  // Scheduling and cloud I/O belong to the application, outside the transaction.
  save(draft: Readonly<CardSaveDraft>): Promise<OutboxOperation>;

  // Capture input before yielding. Read the operation and apply the existing
  // delivery lifecycle within ONE transaction over outbox, current drafts and
  // remote source cache. Missing IDs, invalid states and stale delivery IDs
  // make no changes; every result waits for commit, failures for rollback.
  //
  // On written: complete the operation with its revision/time. Only a current
  // draft matching Save ID, exact source and create/update mode is acknowledged:
  // cache that operation's source and delete that draft in the same transaction.
  // Missing, legacy or superseded drafts do not permit a remote-cache update;
  // the successful operation still completes. Other outcomes retain all drafts
  // and cached sources. Card projections/timestamps and other rows never change.
  // No retries, cloud I/O, clocks, schema repair or connection ownership here.
  finishDelivery(id: string, delivery: Readonly<CardSaveDelivery>): Promise<CardSaveDeliveryResult>;
}
