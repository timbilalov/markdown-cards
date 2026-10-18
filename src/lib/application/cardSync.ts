import type { BoardLocalCard, Card, MarkdownDocument, RemoteBase } from '../domain/types';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../domain/markdown';
import { checkIsMarkdownFilename } from '../domain/markdownFilename';
import type { OutboxDeliveryOutcome, OutboxOperation } from '../domain/outbox';
import type { CardSaveSnapshot } from '../ports/cardSaveRepository';
import type { CardSaveRepository } from '../ports/cardSaveRepository';
import type { OutboxRepository } from '../ports/outboxRepository';
import type { CloudStoragePort, CloudUnavailableReason } from '../ports/cloudStorage';
import type { RemoteMarkdownCacheRefresh, RemoteMarkdownCacheResult } from '../ports/remoteMarkdownCacheRepository';

export interface EditBase { base: RemoteBase; baseSource?: string; previousSaveId?: string }
export type SyncStatus = 'synced' | 'pending' | 'offline' | 'unauthorized' | 'not-found'
  | 'conflict' | 'validation-error' | 'remote-unavailable' | 'uncertain' | 'storage-error'
  | 'legacy' | 'ownership-unavailable' | 'superseded' | 'write-unsupported';
export type SaveResult =
  | { status: 'validation-error' | 'legacy' | 'storage-error'; savedLocally: false; saveId?: never }
  | { status: SyncStatus; savedLocally: true; saveId: string };
export interface DeliveryStatusResult { status: SyncStatus; saveId?: string }
export interface LoadedSource extends EditBase {
  source: string; origin: 'local' | 'cloud'; saveMode: 'create' | 'update';
  status: SyncStatus; saveId?: string; readOnly?: boolean;
  loadFailure?: CloudUnavailableReason;
}
export interface SyncDependencies {
  saves: CardSaveRepository;
  outbox: OutboxRepository;
  cloud: CloudStoragePort;
  readListed?(path: string, signal?: AbortSignal): ReturnType<CloudStoragePort['read']>;
  readCards(): Promise<BoardLocalCard[]>;
  readSource(filename: string): Promise<string | null>;
  refresh(input: RemoteMarkdownCacheRefresh): Promise<RemoteMarkdownCacheResult>;
  now(): number;
  newId(): string;
  checkIsOnline(): boolean;
  // A process-wide/cross-tab lock. false means another owner is active; null
  // means the platform cannot guarantee ownership. Local Save needs no lock.
  exclusive(task: () => Promise<void>): Promise<boolean | null>;
  onChange?(): void;
  deliverySignal?: AbortSignal;
}

const policy = { baseDelayMs: 1000, maxDelayMs: 60_000 };

function stateStatus(operation: OutboxOperation): SyncStatus {
  switch (operation.state.status) {
    case 'completed': return 'synced';
    case 'conflict': return 'conflict';
    case 'uncertain': return 'uncertain';
    case 'failed': return operation.state.reason === 'auth' ? 'unauthorized'
      : operation.state.reason === 'validation' ? 'validation-error'
        : operation.state.reason === 'unsupported' ? 'write-unsupported' : 'remote-unavailable';
    default: return 'pending';
  }
}

function checkHasLinkedDraft(snapshot: CardSaveSnapshot, path: string): boolean {
  const { draft, operation } = snapshot;
  return !!draft && !!operation && draft.saveId === operation.id && operation.path === path
    && draft.source === operation.source && draft.saveMode === (operation.createOnly ? 'create' : 'update');
}

export class CardSync {
  constructor(private readonly deps: SyncDependencies) {}

  private changed(): void {
    try { void Promise.resolve(this.deps.onChange?.()).catch(error => console.warn('Sync notification failed', error)); }
    catch (error) { console.warn('Sync notification failed', error); }
  }

  async save(path: string, document: MarkdownDocument, context: EditBase): Promise<SaveResult> {
    // Capture input before storage/network yields; timestamps come from the caller once.
    const input = structuredClone({ document, context });
    const parsed = parseMarkdownDocument(input.document.source);
    const submitted = serializeMarkdownDocument(input.document.card);
    const decoded = parsed.status === 'success' ? serializeMarkdownDocument(parsed.document.card) : null;
    if (!checkIsMarkdownFilename(path) || parsed.status !== 'success'
      || submitted.status !== 'success' || decoded?.status !== 'success' || submitted.markdown !== decoded.markdown) {
      return { status: 'validation-error', savedLocally: false };
    }
    let saveId: string;
    try {
      const current = await this.deps.saves.readCurrent(path);
      if (current.draft && !checkHasLinkedDraft(current, path)) return { status: 'legacy', savedLocally: false };
      saveId = this.deps.newId();
      await this.deps.saves.save({ id: saveId, path, document: parsed.document,
        base: input.context.base, baseSource: input.context.baseSource,
        // Only the editor can establish continuity with its previous Save.
        previousSaveId: input.context.previousSaveId,
        createOnly: input.context.base.kind === 'missing', createdAt: this.deps.now() });
      this.changed();
    } catch { return { status: 'storage-error', savedLocally: false }; }
    if (!this.deps.checkIsOnline()) return { status: 'offline', savedLocally: true, saveId };
    const result = await this.retry();
    if (result === 'ownership-unavailable' || result === 'storage-error') {
      return { status: result, savedLocally: true, saveId };
    }
    const own = await this.status(path, saveId, parsed.document.source);
    if (result === 'uncertain' && own.status === 'pending'
      && (await this.deps.saves.readCurrent(path)).operation?.state.status === 'processing') own.status = 'uncertain';
    return { ...own, savedLocally: true, saveId };
  }

  async status(path: string, saveId?: string, source?: string): Promise<DeliveryStatusResult> {
    try {
      const current = await this.deps.saves.readCurrent(path);
      if (current.draft && !checkHasLinkedDraft(current, path)) return { status: 'legacy' };
      if (saveId && current.draft?.saveId !== saveId) {
        const operation = await this.deps.outbox.read(saveId);
        const status = operation?.state.status === 'completed' || (!operation && source !== undefined && current.remote?.source === source)
          ? 'synced' : operation && operation.state.status !== 'pending' && operation.state.status !== 'failed'
            ? stateStatus(operation) : 'superseded';
        return { status, saveId };
      }
      if (!current.draft) return { status: 'synced' };
      const blocked = (await this.deps.outbox.list()).find(row => row.path === path
        && (row.state.status === 'uncertain' || row.state.status === 'conflict'));
      return { status: stateStatus(blocked ?? current.operation!), saveId: current.draft.saveId };
    } catch { return { status: 'storage-error' }; }
  }

  async retry(manual = false, signal?: AbortSignal): Promise<SyncStatus> {
    signal = signal && this.deps.deliverySignal ? AbortSignal.any([signal, this.deps.deliverySignal])
      : signal ?? this.deps.deliverySignal;
    if (signal?.aborted) return 'pending';
    if (!this.deps.checkIsOnline()) return 'offline';
    let status: SyncStatus = 'synced';
    try {
      const acquired = await this.deps.exclusive(async () => {
        if (signal?.aborted) return;
        // Exclusive ownership includes the HTTP request and local acknowledgement.
        // Therefore persisted processing rows here belong to a lost worker.
        for (const row of await this.deps.outbox.list()) {
          if (signal?.aborted) return;
          if (row.state.status === 'processing') {
            await this.deps.outbox.apply(row.id, { type: 'recover' }); this.changed();
          }
          if (manual && row.state.status === 'failed') await this.deps.outbox.apply(row.id, { type: 'retry', now: this.deps.now() });
        }
        const visited = new Set<string>();
        for (let pass = 0; pass < 100; pass++) {
          const rows = await this.deps.outbox.list();
          let progressed = false;
          for (const path of new Set(rows.map(row => row.path))) {
            if (signal?.aborted) return;
            const current = await this.deps.saves.readCurrent(path);
            const operation = current.operation;
            const blocked = rows.find(row => row.path === path && ['uncertain', 'conflict'].includes(row.state.status));
            if (blocked) { status = stateStatus(blocked); continue; }
            if (!current.draft) continue;
            if (!checkHasLinkedDraft(current, path) || !operation) { status = 'legacy'; continue; }
            const state = operation.state;
            if (visited.has(operation.id)) continue;
            if ((state.status !== 'pending' && state.status !== 'failed')
              || state.nextAttemptAt === null || state.nextAttemptAt > this.deps.now()) {
              status = stateStatus(operation); continue;
            }
            visited.add(operation.id); progressed = true;
            status = await this.deliver(operation, rows, signal);
          }
          if (!progressed) break;
        }
        if (visited.size) await this.deps.outbox.pruneCompleted(20);
      });
      return acquired === null ? 'ownership-unavailable' : acquired ? status : 'pending';
    } catch { return 'storage-error'; }
  }

  private async deliver(operation: OutboxOperation, rows: OutboxOperation[], signal?: AbortSignal): Promise<SyncStatus> {
    let base = operation.base;
    let baseSource = operation.baseSource;
    let createOnly = operation.createOnly;
    let previous = operation.previousSaveId;
    const seen = new Set<string>();
    while (previous && !seen.has(previous)) {
      seen.add(previous);
      const ancestor = rows.find(row => row.id === previous && row.path === operation.path);
      if (!ancestor) break;
      if (ancestor.state.status === 'completed') {
        base = { kind: 'present', revision: ancestor.state.revision };
        baseSource = ancestor.source; createOnly = false; break;
      }
      previous = ancestor.previousSaveId;
    }
    let outcome: OutboxDeliveryOutcome | undefined;
    try {
      const remote = await this.deps.cloud.read(operation.path, signal);
      if (signal?.aborted) return 'pending';
      if (remote.status === 'unavailable') outcome = { status: 'failed', reason: remote.reason, outcome: 'not-written' };
      else if (remote.status === 'invalid') outcome = { status: 'failed', reason: 'validation', outcome: 'not-written' };
      else {
        const matches = base.kind === 'missing' ? remote.status === 'not-found'
          : base.kind === 'present' && remote.status === 'found' && (
            !!base.revision && !!remote.document.revision
              ? base.revision === remote.document.revision
              : baseSource !== undefined && baseSource === remote.document.source);
        if (!matches) outcome = { status: 'conflict' };
      }
    } catch { outcome = { status: 'failed', reason: 'network', outcome: 'not-written' }; }
    if (signal?.aborted) return 'pending';
    // A newer Save may have arrived during preflight. Only its current ID wins.
    if ((await this.deps.saves.readCurrent(operation.path)).draft?.saveId !== operation.id) return 'pending';
    const deliveryId = this.deps.newId();
    const started = await this.deps.outbox.apply(operation.id, { type: 'start', deliveryId, now: this.deps.now() });
    if (started.status !== 'changed') return 'pending';
    if (signal?.aborted) outcome = { status: 'failed', reason: 'network', outcome: 'not-written' };
    if (!outcome) {
      try {
        const result = await this.deps.cloud.write({ path: operation.path, source: operation.source, createOnly });
        if (result.status === 'written' || result.status === 'conflict') outcome = result;
        else outcome = { status: 'failed', reason: result.status === 'unavailable' ? result.reason
          : result.status === 'invalid' ? 'validation' : 'unsupported',
          outcome: result.status === 'unavailable' ? result.outcome : 'not-written' };
      } catch { outcome = { status: 'failed', reason: 'network', outcome: 'unknown' }; }
    }
    try {
      const finished = await this.deps.saves.finishDelivery(operation.id, {
        deliveryId, now: this.deps.now(), outcome, policy
      });
      this.changed();
      return finished.status === 'changed' ? stateStatus(finished.operation) : 'uncertain';
    } catch {
      // Keep processing durable: the next owner recovers it as uncertain.
      return 'uncertain';
    }
  }

  async load(path: string, options: { projectCard?: boolean; listed?: boolean; modifiedAt?: number; expectedCards?: Card[]; checkIsCurrent?: () => boolean; signal?: AbortSignal } = {}): Promise<LoadedSource | { status: SyncStatus; detail?: string; projection?: Card; loadFailure?: CloudUnavailableReason }> {
    if (options.signal?.aborted) return { status: 'pending' };
    if (!checkIsMarkdownFilename(path)) return { status: 'validation-error' };
    const filename = path.slice(0, -3);
    try {
      const current = await this.deps.saves.readCurrent(path);
      if (current.draft) return this.restore(current, path);
      const cached = await this.deps.readSource(filename);
      const cards = options.projectCard ? options.expectedCards ?? await this.deps.readCards() : [];
      // A board-only freshness shortcut comes AFTER pending-draft recovery and
      // never grants editing/saving authority to a Card without its source.
      const projection = cards.find(card => ((card as BoardLocalCard).filename ?? card.meta.id) === filename);
      if (projection && options.modifiedAt !== undefined && projection.meta.modified >= options.modifiedAt) {
        return { status: 'synced', projection };
      }
      let status: SyncStatus = 'offline';
      let loadFailure: CloudUnavailableReason | undefined;
      if (this.deps.checkIsOnline()) {
        if (options.signal?.aborted || options.checkIsCurrent && !options.checkIsCurrent()) return { status: 'pending' };
        const remote = await (options.listed && this.deps.readListed ? this.deps.readListed(path, options.signal)
          : this.deps.cloud.read(path, options.signal));
        if (options.signal?.aborted || options.checkIsCurrent && !options.checkIsCurrent()) return { status: 'pending' };
        if (remote.status === 'found') {
          const parsed = parseMarkdownDocument(remote.document.source);
          const card = options.projectCard && parsed.status === 'success' ? parsed.document.card : null;
          let retained = false;
          try {
            const result = await this.deps.refresh({ filename, source: remote.document.source, card,
              expected: { source: cached, card: cards.find(row => row.meta.id === card?.meta.id) ?? null } });
            retained = result.status === 'retained';
          } catch (error) {
            console.warn(`Failed to cache Markdown source for ${filename}`, error);
            // The downloaded document is still readable even when caching fails.
            if (options.projectCard) return { status: 'storage-error' };
          }
          const after = await this.deps.saves.readCurrent(path);
          if (after.draft) return this.restore(after, path);
          if (retained && options.projectCard) return { status: 'pending' };
          if (retained && after.remote && after.remote.source !== cached) {
            return { status: 'pending', source: after.remote.source, origin: 'local', saveMode: 'update',
              base: { kind: 'present', revision: null }, baseSource: after.remote.source };
          }
          return { status: 'synced', source: remote.document.source, origin: 'cloud', saveMode: 'update',
            base: { kind: 'present', revision: remote.document.revision }, baseSource: remote.document.source };
        }
        status = remote.status === 'not-found' ? 'not-found' : remote.status === 'invalid' ? 'validation-error'
          : remote.reason === 'auth' ? 'unauthorized' : 'remote-unavailable';
        if (remote.status === 'unavailable') loadFailure = remote.reason;
      }
      const failure = loadFailure === undefined ? {} : { loadFailure };
      if (cached !== null) return { status, source: cached, origin: 'local', saveMode: 'update',
        base: { kind: 'present', revision: null }, baseSource: cached, readOnly: status === 'not-found', ...failure };
      return { status, ...failure };
    } catch (error) { return { status: 'storage-error', detail: error instanceof Error ? error.message : undefined }; }
  }

  private async restore(current: CardSaveSnapshot, path: string): Promise<LoadedSource> {
    const draft = current.draft!;
    const linked = checkHasLinkedDraft(current, path);
    return { source: draft.source, origin: 'local', saveMode: draft.saveMode,
      status: linked ? (await this.status(path, draft.saveId, draft.source)).status : 'legacy', saveId: draft.saveId,
      base: linked ? current.operation!.base : { kind: 'unknown' },
      baseSource: linked ? current.operation!.baseSource : undefined,
      previousSaveId: linked ? current.operation!.id : undefined };
  }
}
