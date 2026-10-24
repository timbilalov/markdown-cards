import {
  noteStorageTargetKey,
  type NoteSyncPlan,
  type NoteSyncAction
} from '../domain/storageSync';
import type { CloudReadResult, CloudWriteResult } from '../ports/cloudStorage';
import type { NoteStorage } from '../ports/noteStorage';
import type { ManualSyncJournal } from '../ports/manualSyncJournal';
import { checkIsMarkdownFilename } from '../domain/markdownFilename';

export type NoteSyncOutcome =
  | CloudWriteResult
  | { status: 'skipped'; reason: Extract<NoteSyncAction, { status: 'skip' }>['reason'] }
  | { status: 'blocked'; reason: string };

export interface NoteSyncResult {
  path: string;
  sourceStorageId: string;
  targetStorageId: string;
  outcome: NoteSyncOutcome;
}

export interface NoteSyncDependencies {
  storages: ReadonlyMap<string, NoteStorage>;
  journal: Pick<ManualSyncJournal, 'begin' | 'settle'>;
  exclusive(task: () => Promise<void>): Promise<boolean | null>;
  newId(): string;
  now(): number;
}

const blocked = (reason: string): NoteSyncOutcome => ({ status: 'blocked', reason });
const unknown = (): CloudWriteResult => ({
  status: 'unavailable',
  reason: 'network',
  outcome: 'unknown'
});

async function read(storage: NoteStorage, path: string): Promise<CloudReadResult> {
  try {
    return await storage.read(path);
  } catch {
    return { status: 'unavailable', reason: 'remote' };
  }
}

function matches(
  read: CloudReadResult,
  path: string,
  source: string,
  revision: string | null
): boolean {
  return (
    read.status === 'found' &&
    read.document.path === path &&
    read.document.source === source &&
    (revision === null || read.document.revision === revision)
  );
}

function unavailable(result: CloudReadResult): boolean {
  return result.status === 'unavailable' || result.status === 'invalid';
}

export async function executeNoteSync(
  plan: NoteSyncPlan,
  dependencies: NoteSyncDependencies
): Promise<NoteSyncResult[]> {
  const actions = structuredClone(plan.actions);
  const storages = new Map(dependencies.storages);
  const results: NoteSyncResult[] = [];
  const address = (action: NoteSyncAction, outcome: NoteSyncOutcome): NoteSyncResult => ({
    path: action.path,
    sourceStorageId: action.sourceStorageId,
    targetStorageId: action.targetStorageId,
    outcome
  });
  async function execute(action: NoteSyncAction): Promise<NoteSyncOutcome> {
    if (action.status === 'blocked') return blocked(action.reason);
    if (action.status === 'skip' && action.reason !== 'identical')
      return { status: 'skipped', reason: action.reason };
    if (!checkIsMarkdownFilename(action.path)) return blocked('invalid-path');
    const source = storages.get(action.sourceStorageId);
    const target = storages.get(action.targetStorageId);
    if (!source || !target) return blocked(!source ? 'source-unavailable' : 'target-unavailable');
    const currentSource = await read(source, action.path);
    if (unavailable(currentSource)) return blocked('source-unavailable');
    if (
      action.status === 'copy' &&
      !matches(currentSource, action.path, action.source, action.sourceRevision)
    )
      return blocked('source-changed');
    if (!target.caseSensitive) {
      const fold = action.path.toLowerCase();
      if (
        actions.some(
          other =>
            other.status === 'copy' &&
            other.targetStorageId === action.targetStorageId &&
            other.path !== action.path &&
            other.path.toLowerCase() === fold
        )
      )
        return blocked('case-collision');
      try {
        const listing = await target.list();
        if (listing.status !== 'success') return blocked('target-unavailable');
        if (listing.entries.some(entry => !checkIsMarkdownFilename(entry.path)))
          return blocked('target-unavailable');
        if (
          listing.entries.some(
            entry => entry.path !== action.path && entry.path.toLowerCase() === fold
          )
        )
          return blocked('case-collision');
      } catch {
        return blocked('target-unavailable');
      }
    }
    const currentTarget = await read(target, action.path);
    if (unavailable(currentTarget)) return blocked('target-unavailable');
    // An identical skip stores no old sources: confirm current equality only.
    if (action.status === 'skip')
      return currentSource.status === 'found' &&
        currentTarget.status === 'found' &&
        currentSource.document.path === action.path &&
        currentTarget.document.path === action.path &&
        currentSource.document.source === currentTarget.document.source
        ? { status: 'skipped', reason: 'identical' }
        : blocked('no-longer-identical');
    const expected = action.expectedTarget;
    if (
      expected.status === 'missing'
        ? currentTarget.status !== 'not-found'
        : !matches(currentTarget, action.path, expected.source, expected.revision)
    )
      return blocked('target-changed');
    const operation = {
      id: dependencies.newId(),
      targetKey: noteStorageTargetKey(target),
      pathKey: target.caseSensitive ? action.path : action.path.toLowerCase(),
      path: action.path,
      sourceStorageId: source.id,
      targetStorageId: target.id,
      source: action.source,
      startedAt: dependencies.now()
    };
    try {
      if (!(await dependencies.journal.begin(operation))) return blocked('uncertain');
    } catch {
      return blocked('local-error');
    }
    let outcome: CloudWriteResult;
    try {
      outcome = await target.copy({
        path: action.path,
        source: action.source,
        expectedTarget: expected
      });
    } catch {
      outcome = unknown();
    }
    try {
      await dependencies.journal.settle(
        operation,
        outcome.status === 'unavailable' && outcome.outcome === 'unknown' ? 'unknown' : 'known'
      );
    } catch {
      return unknown();
    }
    return outcome;
  }
  let ownership: boolean | null;
  try {
    ownership = await dependencies.exclusive(async () => {
      for (const action of actions) {
        let outcome: NoteSyncOutcome;
        try {
          outcome = await execute(action);
        } catch {
          outcome = blocked('local-error');
        }
        results.push(address(action, outcome));
      }
    });
  } catch {
    ownership = null;
  }
  if (ownership !== true)
    return [
      ...results,
      ...actions
        .slice(results.length)
        .map(action =>
          address(action, blocked(ownership === false ? 'busy' : 'ownership-unavailable'))
        )
    ];
  return results;
}
