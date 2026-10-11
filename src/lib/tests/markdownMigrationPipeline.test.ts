// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { runMarkdownMigrations } from '../domain/markdownMigration';
import type { MarkdownMigrationStep, MarkdownMigrationTransition } from '../domain/types';

// Synthetic versions exercise orchestration, not the schema of a future format.
const source = 'original\r\nKEEP-SOURCE\r\n';

describe('sequential Markdown migration registry', () => {
  it('finds each adjacent step by version and feeds it the previous output exactly once', () => {
    const first = vi.fn((text: string) => ({ status: 'success' as const, markdown: text + 'v1' }));
    const second = vi.fn((text: string) => ({ status: 'success' as const, markdown: text + 'v2' }));
    const steps = Object.freeze([
      Object.freeze({ fromVersion: 1, toVersion: 2, migrate: second }),
      Object.freeze({ fromVersion: 0, toVersion: 1, migrate: first })
    ]);
    const input = Object.freeze({ source, fromVersion: 0, toVersion: 2, steps });
    expect(runMarkdownMigrations(input)).toEqual({
      status: 'success', source, markdown: source + 'v1v2',
      appliedSteps: [{ fromVersion: 0, toVersion: 1 }, { fromVersion: 1, toVersion: 2 }]
    });
    expect(first.mock.calls).toEqual([[source]]);
    expect(second.mock.calls).toEqual([[source + 'v1']]);
    expect(steps.map(({ fromVersion, toVersion }) => ({ fromVersion, toVersion }))).toEqual([
      { fromVersion: 1, toVersion: 2 }, { fromVersion: 0, toVersion: 1 }
    ]);
  });

  it('starts at the requested version and stops at the target without running other steps', () => {
    const before = vi.fn();
    const current = vi.fn(() => ({ status: 'success' as const, markdown: 'target' }));
    const after = vi.fn();
    expect(runMarkdownMigrations({ source, fromVersion: 1, toVersion: 2, steps: [
      { fromVersion: 0, toVersion: 1, migrate: before },
      { fromVersion: 1, toVersion: 2, migrate: current },
      { fromVersion: 2, toVersion: 3, migrate: after }
    ] })).toEqual({
      status: 'success', source, markdown: 'target', appliedSteps: [{ fromVersion: 1, toVersion: 2 }]
    });
    expect(current.mock.calls).toEqual([[source]]);
    expect(before).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it('returns the exact source with no steps when the target is already reached', () => {
    const migrate = vi.fn();
    expect(runMarkdownMigrations({ source, fromVersion: 1, toVersion: 1, steps: [
      { fromVersion: 1, toVersion: 2, migrate }
    ] })).toEqual({ status: 'success', source, markdown: source, appliedSteps: [] });
    expect(migrate).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'unsupported' as const, reason: 'unsupported-content' as const },
    { status: 'invalid' as const, reason: 'invalid-timestamp' as const }
  ])('stops on $status and returns only the original source and failure', issue => {
    const first = vi.fn(() => ({ status: 'success' as const, markdown: 'PARTIAL' }));
    const failing = vi.fn(() => issue);
    const after = vi.fn();
    expect(runMarkdownMigrations({ source, fromVersion: 0, toVersion: 3, steps: [
      { fromVersion: 0, toVersion: 1, migrate: first },
      { fromVersion: 1, toVersion: 2, migrate: failing },
      { fromVersion: 2, toVersion: 3, migrate: after }
    ] })).toEqual({ ...issue, source });
    expect(first.mock.calls).toEqual([[source]]);
    expect(failing.mock.calls).toEqual([['PARTIAL']]);
    expect(after).not.toHaveBeenCalled();
  });

  it.each([
    ['empty registry', []],
    ['missing final step', [{ fromVersion: 0, toVersion: 1 }]],
    ['missing first step', [{ fromVersion: 1, toVersion: 2 }]],
    ['duplicate source version', [
      { fromVersion: 0, toVersion: 1 }, { fromVersion: 0, toVersion: 1 }, { fromVersion: 1, toVersion: 2 }
    ]],
    ['skipped version', [{ fromVersion: 0, toVersion: 2 }]],
    ['backward step', [{ fromVersion: 0, toVersion: 1 }, { fromVersion: 1, toVersion: 0 }]],
    ['self-loop', [{ fromVersion: 0, toVersion: 1 }, { fromVersion: 1, toVersion: 1 }]],
    ['negative version', [{ fromVersion: -1, toVersion: 0 }]],
    ['fractional version', [{ fromVersion: 0.5, toVersion: 1.5 }]]
  ] satisfies [string, MarkdownMigrationTransition[]][])(
    'rejects %s before invoking any migration', (_, transitions) => {
      const migrate = vi.fn(() => ({ status: 'success' as const, markdown: 'PARTIAL' }));
      const steps: MarkdownMigrationStep[] = transitions.map(transition => ({ ...transition, migrate }));
      expect(runMarkdownMigrations({ source, fromVersion: 0, toVersion: 2, steps })).toEqual({
        status: 'invalid', source, reason: 'invalid-migration-path'
      });
      expect(migrate).not.toHaveBeenCalled();
    }
  );

  it.each([
    [1, 0], [-1, 1], [0, -1], [0.5, 1], [0, 1.5],
    [NaN, 1], [0, Infinity], [0, Number.MAX_SAFE_INTEGER + 1]
  ])('rejects invalid bounds %s → %s without invoking a step', (fromVersion, toVersion) => {
    const migrate = vi.fn();
    expect(runMarkdownMigrations({ source, fromVersion, toVersion, steps: [
      { fromVersion: 0, toVersion: 1, migrate }
    ] })).toEqual({ status: 'invalid', source, reason: 'invalid-migration-path' });
    expect(migrate).not.toHaveBeenCalled();
  });
});
