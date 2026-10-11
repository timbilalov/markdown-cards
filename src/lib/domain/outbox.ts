import type { CardId, RemoteBase, RemoteRevision } from './types';

// One immutable, validated Save. ID, time and delivery IDs come from the caller;
// the domain does not read clocks, generate randomness or perform storage/I/O.
// Path includes .md and is independent of Card ID. Source is the exact v1 text.
export interface OutboxDraft {
  id: string;
  cardId: CardId;
  path: string;
  source: string;
  createOnly: boolean;
  base: RemoteBase;
  // Exact original bytes are the preflight fallback for providers without revisions.
  baseSource?: string;
  previousSaveId?: string;
  createdAt: number;
}

export type OutboxFailureReason = 'network' | 'remote' | 'invalid-response'
  | 'auth' | 'validation' | 'unsupported';

export type OutboxState =
  | { status: 'pending'; nextAttemptAt: number }
  | { status: 'processing'; deliveryId: string; startedAt: number }
  | { status: 'failed'; reason: OutboxFailureReason; nextAttemptAt: number | null }
  | { status: 'uncertain'; deliveryId: string; reason: OutboxFailureReason | 'interrupted' }
  | { status: 'conflict' }
  | { status: 'completed'; revision: RemoteRevision | null; completedAt: number };

export interface OutboxOperation extends OutboxDraft {
  // Count unsuccessful delivery results, not starts, polls or crash recovery.
  attempts: number;
  state: OutboxState;
}

export interface OutboxRetryPolicy {
  // Positive finite milliseconds, maxDelayMs >= baseDelayMs; validated by caller.
  baseDelayMs: number;
  maxDelayMs: number;
}

export type OutboxDeliveryOutcome =
  | { status: 'written'; revision: RemoteRevision | null }
  | { status: 'conflict' }
  | { status: 'failed'; reason: OutboxFailureReason; outcome: 'not-written' | 'unknown' };

export type OutboxTransition =
  | { status: 'changed'; operation: OutboxOperation }
  | { status: 'ignored'; reason: 'invalid-state' | 'not-due' | 'retry-blocked' | 'stale-delivery' };

export function createOutboxOperation(draft: Readonly<OutboxDraft>): OutboxOperation {
  return {
    ...draft,
    base: { ...draft.base },
    attempts: 0,
    state: { status: 'pending', nextAttemptAt: draft.createdAt }
  };
}

// The use case must check remote divergence before starting a delivery. Due time
// alone does not authorize a write. Each start receives a fresh delivery ID.
export function startOutboxDelivery(
  operation: Readonly<OutboxOperation>,
  delivery: Readonly<{ deliveryId: string; now: number }>
): OutboxTransition {
  const { state } = operation;
  if (state.status !== 'pending' && state.status !== 'failed') {
    return { status: 'ignored', reason: 'invalid-state' };
  }
  if (state.nextAttemptAt === null) return { status: 'ignored', reason: 'retry-blocked' };
  if (delivery.now < state.nextAttemptAt) return { status: 'ignored', reason: 'not-due' };

  return changeOutboxState(operation, {
    status: 'processing', deliveryId: delivery.deliveryId, startedAt: delivery.now
  });
}

export function finishOutboxDelivery(
  operation: Readonly<OutboxOperation>,
  delivery: Readonly<{ deliveryId: string; now: number; outcome: OutboxDeliveryOutcome }>,
  policy: Readonly<OutboxRetryPolicy>
): OutboxTransition {
  if (operation.state.status !== 'processing') return { status: 'ignored', reason: 'invalid-state' };
  if (operation.state.deliveryId !== delivery.deliveryId) {
    return { status: 'ignored', reason: 'stale-delivery' };
  }

  const { outcome } = delivery;
  switch (outcome.status) {
    case 'written':
      return changeOutboxState(operation, {
        status: 'completed', revision: outcome.revision, completedAt: delivery.now
      });
    case 'conflict':
      return changeOutboxState(operation, { status: 'conflict' }, operation.attempts + 1);
    case 'failed': {
      // Uncertainty takes priority over the reason: even an auth error may
      // accompany an unknown write outcome and must not imply safe redelivery.
      if (outcome.outcome === 'unknown') {
        return changeOutboxState(operation, {
          status: 'uncertain', deliveryId: delivery.deliveryId, reason: outcome.reason
        }, operation.attempts + 1);
      }

      const isRetryable = outcome.reason === 'network' || outcome.reason === 'remote'
        || outcome.reason === 'invalid-response';
      const nextAttemptAt = isRetryable
        ? delivery.now + Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** operation.attempts)
        : null;
      return changeOutboxState(operation, {
        status: 'failed', reason: outcome.reason, nextAttemptAt
      }, operation.attempts + 1);
    }
  }
}

// A persisted processing state after a lost worker is uncertain, never pending
// or completed. Recovery is for abandoned work, not another worker's live lease.
export function recoverOutboxDelivery(operation: Readonly<OutboxOperation>): OutboxTransition {
  if (operation.state.status !== 'processing') return { status: 'ignored', reason: 'invalid-state' };
  return changeOutboxState(operation, {
    status: 'uncertain', deliveryId: operation.state.deliveryId, reason: 'interrupted'
  });
}

function changeOutboxState(
  operation: Readonly<OutboxOperation>,
  state: OutboxState,
  attempts = operation.attempts
): OutboxTransition {
  return {
    status: 'changed',
    operation: { ...operation, base: { ...operation.base }, attempts, state }
  };
}
