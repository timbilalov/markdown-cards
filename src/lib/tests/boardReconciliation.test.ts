// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { reconcileBoardCards, deriveBoardColumns } from '../domain/board';
import { makeCard, NOW } from './helpers/fixtures';

// These decisions only request reads; they do not authorize uploads, deletion,
// or overwriting pending edits. Delivery decisions belong to CardSync.

describe('reconcileBoardCards: pure board projection', () => {
  it('returns an empty projection when both sources are empty', () => {
    expect(reconcileBoardCards([], [])).toEqual({ cards: [], refreshFilenames: [] });
  });

  it('retains a local-only card and all its visible fields', () => {
    const local = makeCard();
    expect(reconcileBoardCards([local], [])).toEqual({
      cards: [{
        filename: 'test-card', title: 'Карточка 🗂', modified: local.meta.modified,
        source: 'indexeddb', status: 'В процессе', image: 'https://example.invalid/cover.png'
      }],
      refreshFilenames: []
    });
  });

  it('uses the filename as a placeholder and requests content for a remote-only card', () => {
    // Provider-neutral metadata: no Yandex paths, filenames, URLs or API response.
    const remote = { filename: 'remote-only', modified: NOW };
    expect(reconcileBoardCards([], [remote])).toEqual({
      cards: [{
        filename: 'remote-only', title: 'remote-only', modified: NOW,
        source: 'cloud', status: undefined, image: undefined
      }],
      refreshFilenames: ['remote-only']
    });
  });

  it.each([-1, 0])('keeps a local card when remote modified is %i ms relative to it', delta => {
    const local = makeCard({ meta: { id: 'test-card', created: NOW, modified: NOW } });
    const result = reconcileBoardCards([local], [{ filename: 'test-card', modified: NOW + delta }]);
    expect(result).toEqual({
      cards: [{
        filename: 'test-card', title: local.title, modified: NOW, source: 'indexeddb',
        status: local.status, image: local.image
      }],
      refreshFilenames: []
    });
  });

  it('requests a newer remote version while preserving the local display until it arrives', () => {
    const local = makeCard({ meta: { id: 'test-card', created: NOW, modified: NOW } });
    expect(reconcileBoardCards([local], [{ filename: 'test-card', modified: NOW + 1 }])).toEqual({
      cards: [{
        filename: 'test-card', title: local.title, modified: NOW + 1, source: 'mixed',
        status: local.status, image: local.image
      }],
      refreshFilenames: ['test-card']
    });
  });

  it('merges overlapping sources once per filename, in remote order followed by local-only cards', () => {
    const local = makeCard();
    const localOnly = makeCard({ title: 'Локальная', meta: { ...local.meta, id: 'local-only' } });
    const current = makeCard({ title: 'Актуальная', meta: { ...local.meta, id: 'current', modified: NOW } });
    expect(reconcileBoardCards([localOnly, local, current], [
      { filename: 'test-card', modified: NOW },
      { filename: 'remote-only', modified: NOW },
      { filename: 'current', modified: NOW }
    ])).toEqual({
      cards: [
        { filename: 'test-card', title: local.title, modified: NOW, source: 'mixed', status: local.status, image: local.image },
        { filename: 'remote-only', title: 'remote-only', modified: NOW, source: 'cloud', status: undefined, image: undefined },
        { filename: 'current', title: current.title, modified: NOW, source: 'indexeddb', status: current.status, image: current.image },
        { filename: 'local-only', title: localOnly.title, modified: localOnly.meta.modified, source: 'indexeddb', status: localOnly.status, image: localOnly.image }
      ],
      refreshFilenames: ['test-card', 'remote-only']
    });
  });

  it('does not mutate inputs and returns independent display rows on repeated calls', () => {
    const local = makeCard();
    Object.freeze(local.meta);
    Object.freeze(local);
    const locals = Object.freeze([local]);
    const remotes = Object.freeze([Object.freeze({ filename: 'test-card', modified: NOW })]);
    const before = structuredClone({ locals, remotes });
    const first = reconcileBoardCards(locals, remotes);
    const second = reconcileBoardCards(locals, remotes);
    expect(first).toEqual(second);
    first.cards[0].title = 'Only the returned view changed';
    expect(second.cards[0].title).toBe('Карточка 🗂');
    expect({ locals, remotes }).toEqual(before);
  });
});

describe('deriveBoardColumns: pure grouping', () => {
  it('retains empty default columns in the current board order', () => {
    expect(deriveBoardColumns([])).toEqual([
      { status: 'Предстоящие', cards: [] },
      { status: 'В процессе', cards: [] },
      { status: 'Done', cards: [] }
    ]);
  });

  it('groups default, custom and absent statuses without changing card order', () => {
    const first = { filename: 'first', title: 'Первый', modified: NOW, source: 'indexeddb' as const, status: 'Done' };
    const custom = { filename: 'custom', title: 'Свой статус', modified: NOW, source: 'cloud' as const, status: 'Архив' };
    const noStatus = { filename: 'none', title: 'Без статуса', modified: NOW, source: 'mixed' as const };
    const emptyStatus = { filename: 'empty', title: 'Пустой статус', modified: NOW, source: 'indexeddb' as const, status: '' };
    const last = { ...first, filename: 'last', title: 'Последний' };
    const cards = Object.freeze([first, custom, noStatus, emptyStatus, last]);
    const before = structuredClone(cards);
    expect(deriveBoardColumns(cards)).toEqual([
      { status: 'Предстоящие', cards: [] },
      { status: 'В процессе', cards: [] },
      { status: 'Done', cards: [first, last] },
      { status: 'Архив', cards: [custom] },
      { status: 'Без статуса', cards: [noStatus, emptyStatus] }
    ]);
    expect(cards).toEqual(before);
  });

  it.each(['__proto__', 'constructor'])('accepts the custom status %s as data', status => {
    const card = { filename: 'custom', title: 'Карточка', modified: NOW, source: 'indexeddb' as const, status };
    expect(deriveBoardColumns([card])).toEqual([
      { status: 'Предстоящие', cards: [] },
      { status: 'В процессе', cards: [] },
      { status: 'Done', cards: [] },
      { status, cards: [card] }
    ]);
  });
});
