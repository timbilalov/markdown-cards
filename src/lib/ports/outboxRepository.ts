import type {
  OutboxDeliveryOutcome, OutboxOperation, OutboxRetryPolicy, OutboxTransition
} from '../domain/outbox';

export type OutboxEvent =
  | { type: 'start'; deliveryId: string; now: number }
  | { type: 'finish'; deliveryId: string; now: number; outcome: OutboxDeliveryOutcome; policy: OutboxRetryPolicy }
  | { type: 'recover' }
  | { type: 'retry'; now: number };

export type OutboxApplyResult = OutboxTransition | { status: 'missing' };

// Low-level operation storage, keyed by stable Save ID, not Card ID or path.
// This is not the application Save boundary: draft + operation must be committed
// by CardSaveRepository in one multi-store transaction, never Card.write then add.
export interface OutboxRepository {
  // Only absence returns null. Reads/listing include blocked/completed records.
  read(id: string): Promise<OutboxOperation | null>;
  // Complete list in ascending IndexedDB primary-key order, not delivery order.
  list(): Promise<OutboxOperation[]>;
  // Insert a validated operation; an existing ID rejects, even for equal data.
  // Capture nested input before yielding. Do not overwrite an existing Save.
  add(operation: Readonly<OutboxOperation>): Promise<void>;
  // Read current state, evaluate the domain transition and persist a change in
  // ONE transaction. Capture event before yielding; return only after commit.
  // No general update/delete: immutable payload and blocked work stay intact.
  apply(id: string, event: Readonly<OutboxEvent>): Promise<OutboxApplyResult>;
  // Keep all work/evidence for paths with a draft or blocked delivery. For
  // fully acknowledged paths discard superseded unsent work and bound history.
  pruneCompleted(limit: number): Promise<void>;
}
