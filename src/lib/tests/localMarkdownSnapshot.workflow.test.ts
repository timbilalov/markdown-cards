import { historicalStorage } from './helpers/historicalStorage';
import { saveRepositoryPrototype } from './helpers/saveRepository';
import { onDocumentDownload } from './helpers/documentDownloadHttp';
import { setLegacyClientToken } from './helpers/legacyClientConfiguration';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { LocalMarkdownSnapshot } from '../services/dbService';
import { parseMarkdownDocument } from '../domain/markdown';
import { v1, v1Card } from './helpers/markdownReadFixtures';
import { mockNewCardDocumentHttp } from './helpers/newCardDocumentHttp';
import { NOW, storedCard } from './helpers/fixtures';
import legacy from './fixtures/migration-legacy.md?raw';
import migrated from './fixtures/migration-v1.md?raw';

vi.mock('$app/environment', () => ({ browser: true }));
let remote: ReturnType<typeof mockNewCardDocumentHttp>;
let db: typeof import('../services/dbService')['dbService'];
let DBService: typeof import('../services/dbService')['DBService'];
let cards: typeof import('../stores/cardStore');
const existingFilename = 'archive.md.note';
type NoteKind = 'new v1' | 'existing v1' | 'migrated legacy';

beforeEach(async () => {
  vi.resetModules();
  vi.setSystemTime(NOW);
  remote = mockNewCardDocumentHttp();
  ({ dbService: db, DBService } = await import('../services/dbService'));
  cards = await import('../stores/cardStore');
  setLegacyClientToken((await import('../services/cloudService')).cloudService, 'test-only-token');
  await (await import('../stores/cloudStore')).checkIsSessionAuthenticated();
});
afterEach(() => remote.http.assertHandled());

function requireDraft() {
  const draft = get(cards.cardStore);
  expect(draft).not.toBeNull();
  if (!draft) throw new Error('Expected editor draft');
  return draft;
}

async function open(kind: NoteKind = 'existing v1') {
  let filename = existingFilename;
  let expectedSource = v1;
  if (kind === 'new v1') {
    cards.openNewCard();
    const initial = requireDraft();
    filename = initial.meta.id;
    cards.cardStore.set({ ...structuredClone(v1Card), meta: { ...initial.meta } });
    expectedSource = v1.replace('\ntest-card\n', `\n${filename}\n`)
      .replace('2026-09-01T08:09:10.123Z', new Date(NOW).toISOString());
  } else {
    const original = kind === 'existing v1' ? v1 : legacy;
    remote.files.set(`${filename}.md`, original);
    onDocumentDownload(remote.http, { name: `${filename}.md`, file: `https://downloader.disk.yandex.ru/${filename}.md` },
      () => new Response(remote.files.get(`${filename}.md`)));
    await cards.loadCard(filename);
    if (kind === 'migrated legacy') {
      expect(cards.migrateCurrentCardFormat().status).toBe('success');
      expectedSource = migrated.replace('2026-09-24T00:00:00.000Z', new Date(NOW).toISOString());
    }
  }
  cards.cardStore.update(card => card && { ...card, title: 'Saved version' });
  expectedSource = expectedSource.replace(/^# .+$/m, '# Saved version');
  return {
    filename, source: expectedSource, saveMode: kind === 'new v1' ? 'create' : 'update'
  } satisfies LocalMarkdownSnapshot;
}

function fixtureCard(source: string) {
  const result = parseMarkdownDocument(source);
  expect(result.status).toBe('success');
  if (result.status !== 'success') throw new Error('Expected valid golden source');
  return result.document.card;
}

describe.each(['new v1', 'existing v1', 'migrated legacy'] as const)('local snapshot: %s Save through the real store', kind => {
  it.each([null, 503, 'network'] as const)('retains the exact upload snapshot until acknowledgement (response %s)', async failure => {
    const expected = await open(kind);
    const previousRemoteCache = await db.getMarkdownDocument(expected.filename);
    remote.setFailure(failure);
    const atUpload: (LocalMarkdownSnapshot | null)[] = [];
    // Wrap the transport boundary, retaining the real DB and HTTP implementation.
    const send = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/cloud/upload') {
        atUpload.push(await new DBService().getLocalMarkdownSnapshot(expected.filename));
      }
      return send(input, init);
    }));
    const draft = structuredClone(requireDraft());

    await cards.saveCard(expected.filename, draft);

    expect(atUpload).toEqual([{ ...expected, saveId: expect.any(String) }]);
    expect(remote.uploads).toEqual([{ path: `${expected.filename}.md`, content: expected.source,
      overwrite: String(expected.saveMode === 'update') }]);
    expect(await db.getCard(draft.meta.id)).toEqual(storedCard(fixtureCard(expected.source), expected.filename));
    expect(await historicalStorage.getPendingSyncOperations()).toEqual([]);
    if (failure === null) {
      expect(await new DBService().getLocalMarkdownSnapshot(expected.filename)).toBeNull();
      expect(await db.getMarkdownDocument(expected.filename)).toMatchObject({
        result: { status: 'success', document: { source: expected.source } }
      });
      expect(get(cards.cardSaveError)).toBeNull();
      expect(get(cards.cardSaveMessage)).toMatch(/сохранено.*Диске/i);
    } else {
      expect(await new DBService().getLocalMarkdownSnapshot(expected.filename)).toEqual({ ...expected, saveId: expect.any(String) });
      expect(await db.getMarkdownDocument(expected.filename)).toEqual(previousRemoteCache);
      expect(get(cards.cardStore)).toEqual(fixtureCard(expected.source));
      expect(get(cards.cardSaveError)).toMatch(/локально.*неизвестен/i);
      expect(get(cards.cardDocument)).toMatchObject({ saveMode: expected.saveMode });
    }
  });
});

describe('local snapshot: Save ordering and late responses', () => {
  it('waits for durable local persistence before sending an upload', async () => {
    const expected = await open();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const prototype = await saveRepositoryPrototype();
    const persist = prototype.save;
    vi.spyOn(await saveRepositoryPrototype(), 'save').mockImplementation(async function (this: Awaited<ReturnType<typeof saveRepositoryPrototype>>, snapshot) {
      started.resolve();
      await release.promise;
      return await persist.call(this, snapshot);
    });
    const saving = cards.saveCard(expected.filename, requireDraft());
    try {
      const phase = await Promise.race([started.promise.then(() => 'persisting'), saving.then(() => 'finished')]);
      expect(phase).toBe('persisting');
      expect(remote.uploads).toEqual([]);
      expect(get(cards.cardSaving)).toBe(true);
    } finally {
      release.resolve();
      await saving;
    }
    expect(remote.uploads[0]?.content).toBe(expected.source);
  });

  it('acknowledges only after HTTP success, retaining the durable snapshot while a request is in flight', async () => {
    const expected = await open();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    remote.http.on('POST', '/api/cloud/upload', async () => {
      started.resolve();
      await release.promise;
      return Response.json({ success: true });
    });
    const saving = cards.saveCard(expected.filename, requireDraft());
    try {
      await started.promise;
      expect(await new DBService().getLocalMarkdownSnapshot(expected.filename)).toEqual({ ...expected, saveId: expect.any(String) });
      expect(get(cards.cardSaveMessage)).toBeNull();
    } finally {
      release.resolve();
      await saving;
    }
    expect(await db.getLocalMarkdownSnapshot(expected.filename)).toBeNull();
  });

  it('reports a local acknowledgement error separately from the successful upload and preserves the snapshot', async () => {
    const expected = await open('new v1');
    const acknowledge = vi.spyOn(await saveRepositoryPrototype(), 'finishDelivery').mockRejectedValue(new Error('ack transaction aborted'));

    await cards.saveCard(expected.filename, requireDraft());

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledge.mock.calls[0][1].outcome.status).toBe('written');
    expect(remote.files.get(`${expected.filename}.md`)).toBe(expected.source);
    expect(await new DBService().getLocalMarkdownSnapshot(expected.filename)).toEqual({ ...expected, saveId: expect.any(String) });
    expect(get(cards.cardSaveMessage)).toBeNull();
    expect(get(cards.cardSaveError)).toMatch(/локальн.*неизвестен/i);
    expect(get(cards.cardSaveError)).not.toMatch(/не на Диске/i);
    // Durable confirmation failed: recovery must not authorize another upload.
    expect(get(cards.cardDocument)).toMatchObject({ saveMode: 'create' });
  });

  it('does not acknowledge or announce a superseded snapshot as the current saved version', async () => {
    const expected = await open();
    const newer = { ...expected, source: expected.source.replace('# Saved version', '# Another saved version') };
    remote.http.on('POST', '/api/cloud/upload', async () => {
      await historicalStorage.saveLocalMarkdownSnapshot(newer);
      return Response.json({ success: true });
    });

    await cards.saveCard(expected.filename, requireDraft());

    expect(await new DBService().getLocalMarkdownSnapshot(expected.filename)).toEqual(newer);
    expect(await db.getMarkdownDocument(expected.filename)).toMatchObject({ result: { document: { source: v1 } } });
    expect(get(cards.cardSaveMessage)).toBeNull();
    expect(get(cards.cardSaveError)).toMatch(/локальная версия.*заблокирована/i);
  });

  it('acknowledges the old document after navigation without replacing the new editor or its status', async () => {
    const expected = await open();
    remote.http.on('POST', '/api/cloud/upload', () => {
      cards.openNewCard();
      return Response.json({ success: true });
    });

    await cards.saveCard(expected.filename, requireDraft());

    expect(await new DBService().getLocalMarkdownSnapshot(expected.filename)).toBeNull();
    expect(await db.getMarkdownDocument(expected.filename)).toMatchObject({ result: { document: { source: expected.source } } });
    expect(get(cards.cardDocument)).toMatchObject({ saveMode: 'create' });
    expect(requireDraft().title).toBe('New Card');
    expect(get(cards.cardSaveMessage)).toBeNull();
    expect(get(cards.cardSaveError)).toBeNull();
  });

  it('keeps edits made during upload out of the acknowledged snapshot and warns they are unsaved', async () => {
    const expected = await open();
    remote.http.on('POST', '/api/cloud/upload', () => {
      cards.cardStore.update(card => card && { ...card, title: 'Edited during upload' });
      return Response.json({ success: true });
    });

    await cards.saveCard(expected.filename, requireDraft());

    expect(await db.getMarkdownDocument(expected.filename)).toMatchObject({ result: { document: { source: expected.source } } });
    expect(await db.getLocalMarkdownSnapshot(expected.filename)).toBeNull();
    expect(requireDraft().title).toBe('Edited during upload');
    expect(get(cards.cardSaveMessage)).toMatch(/несохранённые изменения/i);
  });
});
