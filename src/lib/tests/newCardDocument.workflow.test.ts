import { saveRepositoryPrototype } from './helpers/saveRepository';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLegacyClientToken } from './helpers/legacyClientConfiguration';
import { get } from 'svelte/store';
import { parseCardId } from '../domain/cardId';
import { parseMarkdownDocument } from '../domain/markdown';
import { mockCardDocumentHttp, documentSlug } from './helpers/cardDocumentHttp';
import { NOW } from './helpers/fixtures';
import future from './fixtures/unsupported-version.md?raw';

vi.mock('$app/environment', () => ({ browser: true }));

let remote: ReturnType<typeof mockCardDocumentHttp>;
let cards: typeof import('../stores/cardStore');
let db: typeof import('../services/dbService')['dbService'];

beforeEach(async () => {
  vi.resetModules();
  vi.setSystemTime(NOW);
  remote = mockCardDocumentHttp(future);
  cards = await import('../stores/cardStore');
  db = (await import('../services/dbService')).dbService;
  setLegacyClientToken((await import('../services/cloudService')).cloudService, 'test-only-token');
  await (await import('../stores/cloudStore')).checkIsSessionAuthenticated();
});

afterEach(() => remote.http.assertHandled());

describe('new document session through the actual store', () => {
  it('opens a supported v1 draft with a safe ID and exact timestamps, without persistence or cloud writes', async () => {
    const write = vi.spyOn(db, 'saveCard');
    const queue = vi.spyOn(await saveRepositoryPrototype(), 'save');

    cards.openNewCard();

    const draft = get(cards.cardStore);
    expect(draft).toMatchObject({ title: 'New Card', description: '', sections: [],
      meta: { created: NOW, modified: NOW } });
    if (!draft) throw new Error('Expected a new draft');
    expect(parseCardId(draft.meta.id)).toEqual({ status: 'success', id: draft.meta.id });
    const document = get(cards.cardDocument);
    expect(document).toMatchObject({ status: 'loaded', filename: draft.meta.id,
      result: { status: 'success', document: { version: 1, card: draft } } });
    if (!document) throw new Error('Expected a new document');
    expect(parseMarkdownDocument(cards.getCardDocumentSource(document))).toMatchObject({
      status: 'success', document: { version: 1, card: draft }
    });
    expect(write).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(remote.uploads).toEqual([]);
    expect(remote.downloads).toEqual([]);
    expect(await db.getCard(draft.meta.id)).toBeNull();
  });

  it('opens an independent v1 draft after a refused existing document without inheriting its error or filename', async () => {
    await cards.loadCard(documentSlug);
    cards.migrateCurrentCardFormat();
    const write = vi.spyOn(db, 'saveCard');

    cards.openNewCard();

    const document = get(cards.cardDocument);
    expect(document).toMatchObject({ status: 'loaded', result: { status: 'success', document: { version: 1 } } });
    if (!document) throw new Error('Expected a new document');
    expect(cards.getCardDocumentMessage(document)).toBeNull();
    expect(document.filename).not.toBe(documentSlug);
    expect(get(cards.cardStore)).toMatchObject({ title: 'New Card', meta: { id: document.filename } });
    expect(get(cards.cardSaveError)).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(remote.uploads).toEqual([]);
    expect(remote.readRemoteSource()).toBe(future);
  });
});
