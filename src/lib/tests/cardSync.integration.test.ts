import { historicalStorage } from './helpers/historicalStorage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CardSync, type SyncDependencies } from '../application/cardSync';
import { DBService } from '../services/dbService';
import { IndexedDbCardSaveRepository } from '../adapters/indexedDb/cardSaveRepository';
import { IndexedDbOutboxRepository } from '../adapters/indexedDb/outboxRepository';
import type { CloudStoragePort, CloudReadResult, CloudWriteResult } from '../ports/cloudStorage';
import { v1, v1Card } from './helpers/markdownReadFixtures';

const path = 'different-filename.md';
const document = { version: 1 as const, source: v1, card: v1Card };
let db: DBService;
let deps: SyncDependencies;
let sync: CardSync;
let remote: string | null;
let readResult: CloudReadResult | undefined;
let writeResult: CloudWriteResult | undefined;
let online: boolean;
let now: number;
let locked: boolean;
let writes: { path: string; source: string; createOnly?: boolean }[];

beforeEach(async () => {
  db = new DBService(); await db.init();
  const connection = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('MarkdownCardsDB');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  remote = 'original exact legacy source'; readResult = undefined; writeResult = undefined;
  online = true; now = 100; locked = false; writes = []; let id = 0;
  const cloud: CloudStoragePort = {
    getCapabilities: () => ({ revisions: false, conditionalCreate: true }),
    list: async () => ({ status: 'success', entries: [] }),
    read: vi.fn<CloudStoragePort['read']>(async () => readResult ?? (remote === null ? { status: 'not-found' } :
      { status: 'found', document: { path, source: remote, revision: null } })),
    write: vi.fn<CloudStoragePort['write']>(async request => {
      writes.push(request);
      if (writeResult) return writeResult;
      if (request.createOnly && remote !== null) return { status: 'conflict' };
      remote = request.source; return { status: 'written', revision: null };
    })
  };
  deps = {
    saves: new IndexedDbCardSaveRepository(connection), outbox: new IndexedDbOutboxRepository(connection), cloud,
    readCards: () => db.getAllCards(), readSource: async name => {
      const cached = await db.getMarkdownDocument(name);
      if (!cached) return null;
      return cached.result.status === 'success' ? cached.result.document.source : cached.result.source;
    },
    refresh: input => db.refreshMarkdownCache(input), now: () => now, newId: () => `id-${++id}`,
    checkIsOnline: () => online,
    exclusive: async task => { if (locked) return false; locked = true; try { await task(); return true; } finally { locked = false; } }
  };
  sync = new CardSync(deps);
});

const base = () => ({ base: { kind: 'present' as const, revision: null }, baseSource: 'original exact legacy source' });

describe('common Save and worker with real IndexedDB', () => {
  it.each([false, true])('keeps the committed Save truthful if a notification fails (online=%s)', async connected => {
    online = connected; deps.onChange = () => { throw new Error('Broken observer'); };
    expect(await sync.save(path, document, base())).toMatchObject({ status: connected ? 'synced' : 'offline', savedLocally: true });
    const current = await deps.saves.readCurrent(path);
    expect(connected ? current.remote?.source : current.draft?.source).toBe(v1);
    expect(writes).toHaveLength(connected ? 1 : 0);
  });

  it('distinguishes an unsupported write from invalid Markdown', async () => {
    writeResult = { status: 'unsupported', operation: 'create-only' };
    expect(await sync.save(path, document, base())).toMatchObject({ status: 'write-unsupported', savedLocally: true });
    expect((await deps.saves.readCurrent(path)).draft?.source).toBe(v1);
  });

  it('commits exact local draft/outbox offline and delivers it unchanged after reconnect', async () => {
    online = false;
    expect(await sync.save(path, document, base())).toMatchObject({ status: 'offline', savedLocally: true });
    const saved = await deps.saves.readCurrent(path);
    expect(saved.operation).toMatchObject({ source: v1, baseSource: base().baseSource, attempts: 0 });
    expect(saved.draft?.saveId).toBe(saved.operation?.id);
    expect(writes).toEqual([]);
    online = true; now = 500;
    expect(await sync.retry()).toBe('synced');
    expect(writes).toEqual([{ path, source: v1, createOnly: false }]);
    expect((await deps.saves.readCurrent(path)).draft).toBeNull();
    expect((await db.getCard(v1Card.meta.id))?.meta.modified).toBe(v1Card.meta.modified);
  });

  it('creates only when the remote path is absent', async () => {
    remote = null;
    expect(await sync.save(path, document, { base: { kind: 'missing' } })).toMatchObject({ status: 'synced' });
    expect(writes).toEqual([{ path, source: v1, createOnly: true }]);
  });

  it.each(['changed', 'deleted', 'created', 'unknown-base'] as const)('retains local work on %s without sending', async kind => {
    const context = kind === 'created' ? { base: { kind: 'missing' as const } }
      : kind === 'unknown-base' ? { base: { kind: 'unknown' as const } } : base();
    remote = kind === 'deleted' ? null : 'some other source';
    expect(await sync.save(path, document, context)).toMatchObject({ status: 'conflict', savedLocally: true });
    expect(writes).toEqual([]);
    expect((await deps.saves.readCurrent(path)).operation?.state.status).toBe('conflict');
    expect((await deps.saves.readCurrent(path)).draft?.source).toBe(v1);
  });

  it.each(['auth', 'network', 'remote'] as const)('does not turn read failure %s into absence', async reason => {
    readResult = { status: 'unavailable', reason };
    expect(await sync.save(path, document, base())).toMatchObject({ status: reason === 'auth' ? 'unauthorized' : 'remote-unavailable' });
    expect(writes).toEqual([]);
    expect((await deps.saves.readCurrent(path)).operation?.attempts).toBe(1);
  });

  it('obeys retry backoff, then rechecks remote before the next write', async () => {
    writeResult = { status: 'unavailable', reason: 'remote', outcome: 'not-written' };
    expect(await sync.save(path, document, base())).toMatchObject({ status: 'remote-unavailable' });
    await sync.retry(); expect(writes).toHaveLength(1);
    now += 1000; writeResult = undefined;
    expect(await sync.retry()).toBe('synced'); expect(writes).toHaveLength(2);
  });

  it('unblocks authentication only on explicit retry', async () => {
    writeResult = { status: 'unavailable', reason: 'auth', outcome: 'not-written' };
    expect(await sync.save(path, document, base())).toMatchObject({ status: 'unauthorized' });
    now += 50000; writeResult = undefined;
    await sync.retry(); expect(writes).toHaveLength(1);
    expect(await sync.retry(true)).toBe('synced'); expect(writes).toHaveLength(2);
  });

  it('keeps an unknown write outcome blocked across restart and newer Save', async () => {
    writeResult = { status: 'unavailable', reason: 'network', outcome: 'unknown' };
    expect(await sync.save(path, document, base())).toMatchObject({ status: 'uncertain' });
    sync = new CardSync(deps); writeResult = undefined; now += 10000;
    expect(await sync.retry(true)).toBe('uncertain');
    expect(await sync.save(path, document, base())).toMatchObject({ status: 'uncertain' });
    expect(writes).toHaveLength(1);
  });

  it('recovers an interrupted delivery as uncertain without replay', async () => {
    online = false; expect(await sync.save(path, document, base())).toMatchObject({ status: 'offline' });
    const row = (await deps.saves.readCurrent(path)).operation!;
    await deps.outbox.apply(row.id, { type: 'start', deliveryId: 'abandoned', now });
    online = true; sync = new CardSync(deps);
    expect(await sync.retry()).toBe('uncertain'); expect(writes).toEqual([]);
    expect((await deps.outbox.read(row.id))?.state).toEqual({ status: 'uncertain', deliveryId: 'abandoned', reason: 'interrupted' });
  });

  it('sends only the latest offline Save for a path', async () => {
    online = false; expect(await sync.save(path, document, base())).toMatchObject({ status: 'offline' });
    const newer = { ...document, source: v1.replace('Карточка 🗂', 'Latest'), card: { ...v1Card, title: 'Latest' } };
    await sync.save(path, newer, base()); online = true;
    expect(await sync.retry()).toBe('synced');
    expect(writes.map(write => write.source)).toEqual([newer.source]);
    expect((await deps.outbox.list()).every(row => row.state.status === 'completed')).toBe(true);
  });

  it('queues a newer create while another worker sends and follows its confirmed source as update', async () => {
    remote = null;
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const write = deps.cloud.write;
    deps.cloud.write = async request => { await wait; return write(request); };
    online = false;
    const saved = await sync.save(path, document, { base: { kind: 'missing' } });
    expect(saved).toMatchObject({ status: 'offline' });
    online = true;
    const first = sync.retry();
    await vi.waitFor(async () => expect((await deps.saves.readCurrent(path)).operation?.state.status).toBe('processing'));
    const newer = { ...document, source: v1.replace('Карточка 🗂', 'Latest'), card: { ...v1Card, title: 'Latest' } };
    expect(await new CardSync(deps).save(path, newer, { base: { kind: 'missing' }, previousSaveId: saved.saveId })).toMatchObject({ status: 'pending' });
    release(); await first; await sync.retry();
    expect(writes.map(write => [write.source, write.createOnly])).toEqual([[v1, true], [newer.source, false]]);
    expect((await deps.saves.readCurrent(path)).draft).toBeNull();
  });

  it('does not upload or claim local success if the atomic save fails', async () => {
    vi.spyOn(deps.saves, 'save').mockRejectedValue(new Error('quota'));
    expect(await sync.save(path, document, base())).toMatchObject({ status: 'storage-error', savedLocally: false });
    expect(writes).toEqual([]); expect((await deps.saves.readCurrent(path)).draft).toBeNull();
  });

  it('does not replay after the upload succeeds but acknowledgement fails', async () => {
    const spy = vi.spyOn(deps.saves, 'finishDelivery').mockRejectedValue(new Error('quota'));
    expect(await sync.save(path, document, base())).toMatchObject({ status: 'uncertain', savedLocally: true });
    spy.mockRestore(); sync = new CardSync(deps);
    expect(await sync.retry()).toBe('uncertain'); expect(writes).toHaveLength(1);
    expect((await deps.saves.readCurrent(path)).draft?.source).toBe(v1);
  });

  it('preserves historical snapshots without enrolling or overwriting them', async () => {
    await historicalStorage.saveLocalMarkdownSnapshot({ filename: path.slice(0, -3), source: v1, saveMode: 'update' });
    expect(await sync.load(path)).toMatchObject({ status: 'legacy', source: v1, origin: 'local' });
    expect(await sync.save(path, document, base())).toMatchObject({ status: 'legacy', savedLocally: false });
    expect(writes).toEqual([]); expect(await deps.outbox.list()).toEqual([]);
  });

  it('refuses an invalid source/path before local or remote changes', async () => {
    expect(await sync.save('../outside.md', document, base())).toMatchObject({ status: 'validation-error', savedLocally: false });
    expect(await sync.save(path, { ...document, source: 'not v1' }, base())).toMatchObject({ status: 'validation-error', savedLocally: false });
    expect(await deps.outbox.list()).toEqual([]); expect(writes).toEqual([]);
  });

  it('loads a pending source before contacting the remote', async () => {
    online = false; expect(await sync.save(path, document, base())).toMatchObject({ status: 'offline' });
    online = true;
    expect(await sync.load(path)).toMatchObject({ status: 'pending', source: v1, origin: 'local' });
    expect(deps.cloud.read).not.toHaveBeenCalled();
  });

  it('loads exact remote source and its editing base, caching without projection when requested', async () => {
    remote = v1;
    expect(await sync.load(path)).toMatchObject({ status: 'synced', source: v1, baseSource: v1, origin: 'cloud' });
    expect(await db.getCard(v1Card.meta.id)).toBeNull();
    expect(await deps.readSource(path.slice(0, -3))).toBe(v1);
  });

  it('bounds completed history while preserving pending work', async () => {
    for (let i = 0; i < 25; i++) {
      const context = { base: { kind: 'present' as const, revision: null }, baseSource: remote! };
      expect(await sync.save(path, document, context)).toMatchObject({ status: 'synced' });
    }
    expect((await deps.outbox.list()).length).toBeLessThanOrEqual(20);
  });
});

describe('independent files and late reads', () => {
  it('does not restore an older draft with the delivery status of its replacement', async () => {
    online = false; await sync.save(path, document, base());
    const original = deps.saves.readCurrent.bind(deps.saves);
    const captured = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    vi.spyOn(deps.saves, 'readCurrent').mockImplementationOnce(async path => {
      const snapshot = await original(path); captured.resolve(); await release.promise; return snapshot;
    });
    const loading = sync.load(path); await captured.promise;
    const source = v1.replace('Карточка 🗂', 'Replacement');
    online = true;
    await sync.save(path, { ...document, source, card: { ...v1Card, title: 'Replacement' } }, base());
    release.resolve();
    expect(await loading).toMatchObject({ source: v1, status: 'superseded' });
    expect(remote).toBe(source);
  });

  it('does not chain an independent editor to a processing Save from the same remote base', async () => {
    const started = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const write = deps.cloud.write;
    deps.cloud.write = async request => { started.resolve(); await release.promise; return write(request); };
    const first = sync.save(path, document, base());
    await started.promise;
    const replacement = { ...document, source: v1.replace('Карточка 🗂', 'Independent edit'),
      card: { ...v1Card, title: 'Independent edit' } };
    await new CardSync(deps).save(path, replacement, base());
    release.resolve(); await first; await sync.retry();
    expect(writes.map(row => row.source)).toEqual([v1]);
    expect(remote).toBe(v1);
    expect((await deps.saves.readCurrent(path)).operation?.state.status).toBe('conflict');
    expect((await deps.saves.readCurrent(path)).draft?.source).toBe(replacement.source);
  });

  it('keeps the editor base when another editor has queued a Save from a newer remote source', async () => {
    remote = 'newer source seen only by the other editor';
    online = false;
    await sync.save(path, document, { base: { kind: 'present', revision: null }, baseSource: remote });
    const other = (await deps.saves.readCurrent(path)).operation!;
    online = true;
    expect(await sync.save(path, document, base())).toMatchObject({ status: 'conflict', savedLocally: true });
    expect(writes).toEqual([]);
    expect((await deps.saves.readCurrent(path)).operation).toMatchObject({ baseSource: base().baseSource });
    expect(await deps.outbox.read(other.id)).toMatchObject({ source: v1 });
  });

  it('does not claim delivery of an older Save when only its replacement was uploaded', async () => {
    const originalSave = deps.saves.save.bind(deps.saves);
    const replaced = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(deps.saves, 'save').mockImplementationOnce(async draft => {
      const result = await originalSave(draft);
      replaced.resolve(); await release.promise; return result;
    });
    const first = sync.save(path, document, base());
    await replaced.promise;
    const source = v1.replace('Карточка 🗂', 'Replacement');
    const second = await sync.save(path, { ...document, source, card: { ...v1Card, title: 'Replacement' } }, base());
    release.resolve();
    expect(second.status).toBe('synced');
    expect((await first).status).not.toBe('synced');
    expect(writes.map(write => write.source)).toEqual([source]);
  });

  it('restores the blocking status of an older uncertain Save after a newer offline Save', async () => {
    writeResult = { status: 'unavailable', reason: 'network', outcome: 'unknown' };
    await sync.save(path, document, base());
    online = false;
    await sync.save(path, document, base());
    expect(await sync.load(path)).toMatchObject({ status: 'uncertain', source: v1 });
  });

  it('reports a successful Save independently of another file with uncertain delivery', async () => {
    writeResult = { status: 'unavailable', reason: 'network', outcome: 'unknown' };
    expect(await sync.save(path, document, base())).toMatchObject({ status: 'uncertain' });
    writeResult = undefined;
    expect(await sync.save('other.md', document, base())).toMatchObject({ status: 'synced', savedLocally: true });
  });

  it('does not reopen old remote text when a local Save was acknowledged during download', async () => {
    remote = v1;
    const started = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    deps.cloud.read = async () => {
      started.resolve(); await release.promise;
      return { status: 'found', document: { path, source: v1, revision: null } };
    };
    const loading = sync.load(path);
    await started.promise;
    const latest = v1.replace('Карточка 🗂', 'Latest confirmed');
    await deps.saves.save({ id: 'concurrent-save', path, document: { ...document, source: latest,
      card: { ...v1Card, title: 'Latest confirmed' } }, base: { kind: 'present', revision: null }, createOnly: false, createdAt: now });
    await deps.outbox.apply('concurrent-save', { type: 'start', now, deliveryId: 'delivered' });
    await deps.saves.finishDelivery('concurrent-save', { deliveryId: 'delivered', now, outcome: { status: 'written', revision: null },
      policy: { baseDelayMs: 1000, maxDelayMs: 60000 } });
    release.resolve();
    expect(await loading).toMatchObject({ source: latest, origin: 'local', baseSource: latest });
  });
});
it.each([null, 'base'])('uses atomic preflight revision when the cached base revision is %j', async revision => {
 deps.cloud.getCapabilities = () => ({revisions:true,conditionalCreate:true,conditionalUpdate:true});
 readResult = {status:'found',document:{path,source:'original exact legacy source',revision:'base'}};
 expect(await sync.save(path,document,{base:{kind:'present',revision},baseSource:base().baseSource})).toMatchObject({status:'synced'});
 expect(writes).toEqual([{path,source:v1,createOnly:false,expectedRevision:'base'}]);
});
it.each([null, 'base'])('retains the draft when atomic preflight revision changes during upload (cached=%j)', async revision => {
 deps.cloud.getCapabilities = () => ({revisions:true,conditionalCreate:true,conditionalUpdate:true});
 readResult = {status:'found',document:{path,source:'original exact legacy source',revision:'base'}};
 deps.cloud.write = async request => request.expectedRevision === 'base' ? {status:'conflict'} : {status:'written',revision:'overwritten'};
 expect(await sync.save(path,document,{base:{kind:'present',revision},baseSource:base().baseSource})).toMatchObject({status:'conflict',savedLocally:true});
 expect((await deps.saves.readCurrent(path)).draft?.source).toBe(v1);
});
