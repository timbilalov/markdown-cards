// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  createOutboxOperation, startOutboxDelivery, finishOutboxDelivery, recoverOutboxDelivery
} from '../domain/outbox';
import type {
  OutboxDraft, OutboxOperation, OutboxState, OutboxDeliveryOutcome,
  OutboxRetryPolicy, OutboxTransition
} from '../domain/outbox';
import type { RemoteBase } from '../domain/types';
import { readFileSync } from 'node:fs';

const NOW = 10_000;
const SOURCE = readFileSync(new URL('./fixtures/v1-card.md', import.meta.url), 'utf8');
const draft: OutboxDraft = {
  id: 'save-A', cardId: 'test-card', path: 'Архив 🗂.md.md', source: SOURCE,
  createOnly: false, base: { kind: 'present', revision: ' Revision/10 ' }, createdAt: 100
};
const policy: OutboxRetryPolicy = { baseDelayMs: 1000, maxDelayMs: 5000 };
const processing: OutboxState = { status: 'processing', deliveryId: 'delivery-A', startedAt: 9000 };

// Independent state fixtures: tests never need the RED constructor to arrange
// another function's inputs. Times/IDs are explicit, with no timers or cloud I/O.
function operation(state: OutboxState, attempts = 0): OutboxOperation {
  return { ...structuredClone(draft), attempts, state: structuredClone(state) };
}

function changed(op: OutboxOperation, state: OutboxState, attempts = op.attempts): OutboxTransition {
  return { status: 'changed', operation: { ...op, attempts, state } };
}

function finish(op: OutboxOperation, outcome: OutboxDeliveryOutcome, deliveryId = 'delivery-A') {
  return finishOutboxDelivery(op, { deliveryId, now: NOW, outcome }, policy);
}

const inactiveStates: OutboxState[] = [
  { status: 'pending', nextAttemptAt: 100 },
  { status: 'failed', reason: 'network', nextAttemptAt: NOW },
  { status: 'failed', reason: 'auth', nextAttemptAt: null },
  { status: 'uncertain', deliveryId: 'delivery-A', reason: 'network' },
  { status: 'conflict' },
  { status: 'completed', revision: null, completedAt: 9500 }
];

describe('outbox: one immutable Save, independent of the cloud provider', () => {
  it.each([
    { kind: 'present', revision: ' Revision/10 ' },
    { kind: 'present', revision: null },
    { kind: 'missing' },
    { kind: 'unknown' }
  ] satisfies RemoteBase[])('preserves the exact snapshot and base $kind/$revision', base => {
    const input = { ...draft, base, createOnly: base.kind === 'missing' };
    expect(createOutboxOperation(input)).toEqual({
      ...input, attempts: 0, state: { status: 'pending', nextAttemptAt: 100 }
    });
  });

  it('captures the base and input without retaining mutable caller-owned data', () => {
    const input = structuredClone(draft);
    const result = createOutboxOperation(input);
    const expected = { ...structuredClone(draft), attempts: 0,
      state: { status: 'pending', nextAttemptAt: 100 } };
    expect(result).toEqual(expected);
    input.id = 'later-save';
    input.path = 'another-file.md';
    input.source = 'later text';
    if (input.base.kind === 'present') input.base.revision = 'changed-base';
    expect(result).toEqual(expected);
  });
});

describe('outbox: start only an eligible delivery, without consuming a failure attempt', () => {
  it.each([
    { status: 'pending', nextAttemptAt: NOW },
    { status: 'failed', reason: 'remote', nextAttemptAt: NOW },
    { status: 'failed', reason: 'network', nextAttemptAt: NOW - 1 }
  ] satisfies OutboxState[])('starts $status at or after its due time', state => {
    const op = operation(state, 2);
    const before = structuredClone(op);
    expect(startOutboxDelivery(op, { deliveryId: 'delivery-B', now: NOW })).toEqual(changed(op, {
      status: 'processing', deliveryId: 'delivery-B', startedAt: NOW
    }));
    expect(op).toEqual(before);
  });

  it.each([
    { status: 'pending', nextAttemptAt: NOW + 1 },
    { status: 'failed', reason: 'network', nextAttemptAt: NOW + 1 }
  ] satisfies OutboxState[])('does not start $status one millisecond early', state => {
    expect(startOutboxDelivery(operation(state), { deliveryId: 'delivery-B', now: NOW }))
      .toEqual({ status: 'ignored', reason: 'not-due' });
  });

  it('does not automatically retry a blocked authentication failure', () => {
    const op = operation({ status: 'failed', reason: 'auth', nextAttemptAt: null }, 1);
    expect(startOutboxDelivery(op, { deliveryId: 'delivery-B', now: NOW }))
      .toEqual({ status: 'ignored', reason: 'retry-blocked' });
  });

  it.each([
    processing,
    { status: 'uncertain', deliveryId: 'delivery-A', reason: 'network' },
    { status: 'conflict' },
    { status: 'completed', revision: 'remote-revision', completedAt: 9500 }
  ] satisfies OutboxState[])('never automatically restarts $status', state => {
    expect(startOutboxDelivery(operation(state), { deliveryId: 'delivery-B', now: NOW }))
      .toEqual({ status: 'ignored', reason: 'invalid-state' });
  });
});

describe('outbox: delivery results, backoff and acknowledgement', () => {
  it.each([' opaque/2 ', null])('confirms success with revision %s without incrementing attempts', revision => {
    const op = operation(processing, 2);
    expect(finish(op, { status: 'written', revision })).toEqual(changed(op, {
      status: 'completed', revision, completedAt: NOW
    }));
  });

  it.each(['network', 'remote', 'invalid-response'] as const)(
    'schedules the first known-not-written %s failure after the base delay', reason => {
      const op = operation(processing);
      expect(finish(op, { status: 'failed', reason, outcome: 'not-written' })).toEqual(changed(op, {
        status: 'failed', reason, nextAttemptAt: NOW + 1000
      }, 1));
    }
  );

  it.each([
    [1, 2000], [2, 4000], [3, 5000], [2000, 5000]
  ])('backs off after %i prior failures with delay %i ms, capped without overflow', (attempts, delay) => {
    const op = operation(processing, attempts);
    expect(finish(op, { status: 'failed', reason: 'network', outcome: 'not-written' }))
      .toEqual(changed(op, { status: 'failed', reason: 'network', nextAttemptAt: NOW + delay }, attempts + 1));
  });

  it('uses the caller-supplied retry policy and result time', () => {
    const op = operation(processing, 2);
    expect(finishOutboxDelivery(op, {
      deliveryId: 'delivery-A', now: 50_000,
      outcome: { status: 'failed', reason: 'remote', outcome: 'not-written' }
    }, { baseDelayMs: 200, maxDelayMs: 600 })).toEqual(changed(op, {
      status: 'failed', reason: 'remote', nextAttemptAt: 50_600
    }, 3));
  });

  it.each(['auth', 'validation', 'unsupported'] as const)(
    'retains a %s failure without scheduling an automatic retry', reason => {
      const op = operation(processing, 2);
      expect(finish(op, { status: 'failed', reason, outcome: 'not-written' }))
        .toEqual(changed(op, { status: 'failed', reason, nextAttemptAt: null }, 3));
    }
  );

  it.each(['network', 'remote', 'invalid-response', 'auth'] as const)(
    'retains an unknown %s outcome as uncertain, never as retryable or completed', reason => {
      const op = operation(processing, 2);
      expect(finish(op, { status: 'failed', reason, outcome: 'unknown' }))
        .toEqual(changed(op, { status: 'uncertain', deliveryId: 'delivery-A', reason }, 3));
    }
  );

  it('retains a rejected create-only delivery as a conflict without selecting a winner', () => {
    const op = { ...operation(processing), createOnly: true, base: { kind: 'missing' as const } };
    expect(finish(op, { status: 'conflict' })).toEqual(changed(op, { status: 'conflict' }, 1));
  });

  it.each(inactiveStates)('ignores results when the operation is $status', state => {
    const op = operation(state, 2);
    const before = structuredClone(op);
    expect(finish(op, { status: 'written', revision: 'late' }))
      .toEqual({ status: 'ignored', reason: 'invalid-state' });
    expect(op).toEqual(before);
  });

  it.each([
    { status: 'written', revision: 'late' },
    { status: 'failed', reason: 'network', outcome: 'not-written' },
    { status: 'conflict' }
  ] satisfies OutboxDeliveryOutcome[])('ignores a stale $status result from an earlier delivery', outcome => {
    const op = operation({ status: 'processing', deliveryId: 'delivery-B', startedAt: NOW }, 1);
    expect(finish(op, outcome)).toEqual({ status: 'ignored', reason: 'stale-delivery' });
  });

  it('counts a duplicate failure once and ignores a late success for that delivery', () => {
    const op = operation(processing);
    const outcome = { status: 'failed', reason: 'network', outcome: 'not-written' } as const;
    const result = finish(op, outcome);
    expect(result).toEqual(changed(op, { status: 'failed', reason: 'network', nextAttemptAt: 11_000 }, 1));
    if (result.status !== 'changed') throw new Error('Expected a failed operation');
    expect(finish(result.operation, outcome)).toEqual({ status: 'ignored', reason: 'invalid-state' });
    expect(finish(result.operation, { status: 'written', revision: 'late' }))
      .toEqual({ status: 'ignored', reason: 'invalid-state' });
  });

  it('keeps the Save ID, source, base and create-only intent across a retry and final success', () => {
    const original = { ...operation(processing), createOnly: true, base: { kind: 'missing' as const } };
    const failed = finish(original, { status: 'failed', reason: 'remote', outcome: 'not-written' });
    expect(failed).toEqual(changed(original, { status: 'failed', reason: 'remote', nextAttemptAt: 11_000 }, 1));
    if (failed.status !== 'changed') throw new Error('Expected a failed operation');
    const started = startOutboxDelivery(failed.operation, { deliveryId: 'delivery-B', now: 11_000 });
    expect(started).toEqual(changed(original, {
      status: 'processing', deliveryId: 'delivery-B', startedAt: 11_000
    }, 1));
    if (started.status !== 'changed') throw new Error('Expected a processing operation');
    expect(finishOutboxDelivery(started.operation, {
      deliveryId: 'delivery-B', now: 11_001, outcome: { status: 'written', revision: 'new' }
    }, policy)).toEqual(changed(original, { status: 'completed', revision: 'new', completedAt: 11_001 }, 1));
  });

  it('is deterministic on frozen input without mutating the operation, result or policy', () => {
    const op = operation(processing, 1);
    Object.freeze(op.base);
    Object.freeze(op.state);
    Object.freeze(op);
    const outcome = Object.freeze({ status: 'failed', reason: 'remote', outcome: 'not-written' } as const);
    const input = Object.freeze({ deliveryId: 'delivery-A', now: NOW, outcome });
    const config = Object.freeze({ ...policy });
    const before = structuredClone({ op, input, config });
    const expected = changed(op, { status: 'failed', reason: 'remote', nextAttemptAt: 12_000 }, 2);
    expect(finishOutboxDelivery(op, input, config)).toEqual(expected);
    expect(finishOutboxDelivery(op, input, config)).toEqual(expected);
    expect({ op, input, config }).toEqual(before);
  });
});

describe('outbox: recover an abandoned delivery without inventing its remote outcome', () => {
  it('retains an interrupted operation as uncertain without consuming another attempt', () => {
    const op = operation(processing, 2);
    const before = structuredClone(op);
    const recovered = recoverOutboxDelivery(op);
    expect(recovered).toEqual(changed(op, {
      status: 'uncertain', deliveryId: 'delivery-A', reason: 'interrupted'
    }));
    expect(op).toEqual(before);
    if (recovered.status !== 'changed') throw new Error('Expected an uncertain operation');
    expect(recoverOutboxDelivery(recovered.operation)).toEqual({ status: 'ignored', reason: 'invalid-state' });
    expect(startOutboxDelivery(recovered.operation, { deliveryId: 'delivery-B', now: NOW }))
      .toEqual({ status: 'ignored', reason: 'invalid-state' });
  });

  it.each(inactiveStates)('does not recover or discard $status data', state => {
    const op = operation(state, 2);
    const before = structuredClone(op);
    expect(recoverOutboxDelivery(op)).toEqual({ status: 'ignored', reason: 'invalid-state' });
    expect(op).toEqual(before);
  });
});
