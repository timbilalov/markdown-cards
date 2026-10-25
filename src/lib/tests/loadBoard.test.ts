import type { BoardCardLoadResult } from '../application/loadBoard';
import { describe, expect, it, vi } from 'vitest';
import { BOARD_REFRESH_INTERVAL_MS, createBoardLoader, loadBoard, type BoardLoadState, type BoardDependencies, type BoardRefreshRecord } from '../application/loadBoard';
import { deriveBoardColumns } from '../domain/board';
import { boardReadResult, makeCard, makeFile, NOW } from './helpers/fixtures';
function setup() {
  const states: BoardLoadState[] = [];
  const deps: BoardDependencies = { init: async () => {}, readLocal: async () => [makeCard()],
    sync: async () => {}, files: () => [makeFile()], load: vi.fn(async () => boardReadResult(makeCard({ title: 'Remote' }))),
    checkIsOffline: () => false, clock: () => 100 };
  return { states, deps, publish: (state: BoardLoadState) => { states.push(structuredClone(state)); } };
}
describe('board loading application scenario', () => {
  it('publishes local cards immediately, then merged cloud content', async () => {
    const { states, deps, publish } = setup();
    await loadBoard(deps, publish, new AbortController().signal);
    expect([states[0], states.at(-1)].map(state => [state?.source, state?.cards[0]?.title])).toEqual([
      ['indexeddb', 'Карточка 🗂'], ['mixed', 'Remote']
    ]);
    expect(states[0]).toMatchObject({ loading: true, progress: null });
    expect(states.filter(state => state.progress).map(state => state.progress)).toEqual([
      { completed: 0, total: 1 }, { completed: 1, total: 1 }, { completed: 1, total: 1 }
    ]);
    expect(states.at(-1)?.loading).toBe(false);
  });
  it('loads full cloud-only cards without a local cache and publishes each completed read', async () => {
    const { states, deps, publish } = setup();
    deps.readLocal = async () => [];
    deps.files = () => [makeFile(), makeFile({ name: 'other.md' }), makeFile({ name: 'ignore.txt' })];
    const first = makeCard({ title: 'First', status: 'Done' });
    const second = makeCard({ title: 'Second', status: 'Предстоящие' });
    deps.load = vi.fn().mockResolvedValueOnce(boardReadResult(first)).mockResolvedValueOnce(boardReadResult(second));
    await loadBoard(deps, publish, new AbortController().signal);
    expect(deps.load).toHaveBeenCalledTimes(2);
    expect(states.find(state => state.progress?.completed === 1)).toMatchObject({
      loading: true, progress: { completed: 1, total: 2 }, cards: [
        { filename: 'test-card', title: first.title, status: first.status, image: first.image, modified: first.meta.modified },
        { filename: 'other', title: 'other' }
      ]
    });
    expect(states.at(-1)).toMatchObject({ loading: false, source: 'cloud', progress: { completed: 2, total: 2 },
      cards: [{ title: first.title, status: first.status }, { title: second.title, status: second.status }] });
  });
  it('continues after internal and cloud errors, marking only a refused cloud read as retryable', async () => {
    const { states, deps, publish } = setup();
    deps.files = () => [makeFile(), makeFile({ name: 'refused.md' }), makeFile({ name: 'ready.md' })];
    deps.load = vi.fn().mockRejectedValueOnce(new Error('read failed')).mockResolvedValueOnce(boardReadResult(null))
      .mockResolvedValueOnce(boardReadResult(makeCard({ title: 'Ready' })));
    await loadBoard(deps, publish, new AbortController().signal);
    expect(states.at(-1)).toMatchObject({ loading: false, progress: { completed: 3, total: 3 }, cards: [
      { filename: 'test-card', title: 'Карточка 🗂', status: 'В процессе' },
      { filename: 'refused', title: 'refused' }, { filename: 'ready', title: 'Ready' }
    ] });
    expect(states.at(-1)?.failedFilenames).toEqual(['refused']);
  });
  it.each(['success', 'unavailable', 'unprojected', 'error'])('marks all pending notes as loading and removes each after a %s result', async outcome => {
    const { states, deps, publish } = setup();
    deps.readLocal = async () => [makeCard(), makeCard({ meta: { id: 'current', created: NOW, modified: NOW } })];
    deps.files = () => [makeFile(), makeFile({ name: 'other.md' }), makeFile({ name: 'current.md' })];
    deps.load = vi.fn(async file => {
      expect(states.at(-1)?.pendingFilenames).toContain(file.name.slice(0, -3));
      if (outcome === 'error') throw new Error('read failed');
      if (outcome === 'unprojected') return { status: 'unprojected' } as const;
      return outcome === 'unavailable' ? boardReadResult(null) : boardReadResult(makeCard());
    });
    await loadBoard(deps, publish, new AbortController().signal);
    expect(states.map(state => state.pendingFilenames)).toEqual([
      [], ['test-card', 'other'], ['other'], [], []
    ]);
    expect(deps.load).toHaveBeenCalledTimes(2);
    expect(states.at(-1)?.loading).toBe(false);
    expect(states.at(-1)?.failedFilenames).toEqual(outcome === 'unavailable' ? ['test-card', 'other'] : []);
  });
  it('does not change previously published cards while refreshing content', async () => {
    const { deps } = setup();
    const states: BoardLoadState[] = [];
    await loadBoard(deps, state => { states.push(state); }, new AbortController().signal);
    expect(states.find(state => state.progress?.completed === 0)?.cards[0].title).toBe('Карточка 🗂');
    expect(states.at(-1)?.cards[0].title).toBe('Remote');
  });
  it('uses the same document dates and order for cached, refreshing and cold cloud boards', async () => {
    const { states, deps, publish } = setup();
    const locals = ['a-note', 'z-note'].map((id, index) => makeCard({
      meta: { id, created: NOW, modified: NOW + index }
    }));
    deps.readLocal = async () => locals;
    deps.files = () => locals.map(card => makeFile({ name: `${card.meta.id}.md`, modified: new Date(NOW + 100).toISOString() }));
    deps.load = async file => boardReadResult(locals.find(card => `${card.meta.id}.md` === file.name)!);
    await loadBoard(deps, publish, new AbortController().signal);
    const order = (state: BoardLoadState) => deriveBoardColumns(state.cards)
      .find(column => column.status === 'В процессе')?.cards.map(card => [card.filename, card.modified]);
    const expected = [['z-note', NOW + 1], ['a-note', NOW]];
    expect(states.map(order)).toEqual(states.map(() => expected));
    const coldStates: BoardLoadState[] = [];
    deps.readLocal = async () => [];
    await loadBoard(deps, state => { coldStates.push(state); }, new AbortController().signal);
    expect(order(coldStates.at(-1)!)).toEqual(expected);
  });
  it('stops progress publication and subsequent reads after cancellation during a download', async () => {
    const { states, deps, publish } = setup();
    const controller = new AbortController();
    deps.files = () => [makeFile(), makeFile({ name: 'other.md' })];
    deps.load = vi.fn(async () => { controller.abort(); return boardReadResult(makeCard()); });
    await loadBoard(deps, publish, controller.signal);
    expect(deps.load).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toMatchObject({ loading: true, progress: { completed: 0, total: 2 } });
  });
  it('does not perform cloud work after cancellation while local reads finish', async () => {
    const { states, deps, publish } = setup(); const controller = new AbortController();
    deps.readLocal = vi.fn(async () => { controller.abort(); return [makeCard()]; });
    deps.sync = vi.fn();
    await loadBoard(deps, publish, controller.signal);
    expect(deps.readLocal).toHaveBeenCalledTimes(1);
    expect(deps.sync).not.toHaveBeenCalled();
    expect(states).toEqual([]);
  });
  it('retains local cards and exposes an offline result when listing fails', async () => {
    const { states, deps, publish } = setup(); deps.sync = async () => { throw new Error('offline'); };
    await loadBoard(deps, publish, new AbortController().signal);
    expect(states.at(-1)).toMatchObject({ offline: true, source: 'indexeddb', error: 'offline' });
    expect(states.at(-1)?.cards[0].title).toBe('Карточка 🗂');
  });
  it('surfaces a failed local initialization without hanging in loading', async () => {
    const { states, deps, publish } = setup(); deps.init = async () => { throw new Error('blocked'); };
    await loadBoard(deps, publish, new AbortController().signal);
    expect(states.at(-1)).toMatchObject({ loading: false, error: 'blocked', cards: [] });
  });
});

describe('retrying individual board notes', () => {
  it('clears the retry error when the cloud returns content that cannot be projected as a Card', async () => {
    const { states, deps, publish } = setup();
    deps.load = vi.fn().mockResolvedValueOnce({ status: 'unavailable' }).mockResolvedValueOnce({ status: 'unprojected' });
    const board = createBoardLoader(deps, publish, new AbortController().signal);
    await board.load();
    await board.retry('test-card');
    expect(states.at(-1)).toMatchObject({ pendingFilenames: [], failedFilenames: [], cards: [{ title: 'Карточка 🗂' }] });
  });
  it.each([true, false])('retries only the failed note and keeps its cached display until completion (success=%s)', async succeeds => {
    const { states, deps, publish } = setup();
    const response = Promise.withResolvers<BoardCardLoadResult>();
    deps.sync = vi.fn(async () => {});
    deps.load = vi.fn().mockResolvedValueOnce(boardReadResult(null)).mockImplementationOnce(() => response.promise);
    const signal = new AbortController().signal;
    const board = createBoardLoader(deps, publish, signal);
    await board.load();
    expect(states.at(-1)?.failedFilenames).toEqual(['test-card']);
    const retry = board.retry('test-card');
    await board.retry('test-card');
    await board.retry('not-on-the-board');
    expect(deps.load).toHaveBeenCalledTimes(2);
    expect(deps.load).toHaveBeenLastCalledWith(makeFile(), signal, true);
    expect(states.at(-1)).toMatchObject({ pendingFilenames: ['test-card'], failedFilenames: [],
      cards: [{ title: 'Карточка 🗂' }] });
    response.resolve(boardReadResult(succeeds ? makeCard({ title: 'Updated', status: 'Done' }) : null));
    await retry;
    expect(states.at(-1)).toMatchObject({ pendingFilenames: [],
      failedFilenames: succeeds ? [] : ['test-card'],
      cards: [{ title: succeeds ? 'Updated' : 'Карточка 🗂', status: succeeds ? 'Done' : 'В процессе' }] });
    expect(deps.sync).toHaveBeenCalledTimes(1);
  });

  it('keeps a retry pending when the initial queue finishes and preserves both results', async () => {
    const { states, deps, publish } = setup();
    const other = Promise.withResolvers<BoardCardLoadResult>();
    const repeated = Promise.withResolvers<BoardCardLoadResult>();
    deps.files = () => [makeFile(), makeFile({ name: 'other.md' })];
    deps.load = vi.fn().mockResolvedValueOnce(boardReadResult(null)).mockImplementationOnce(() => other.promise)
      .mockImplementationOnce(() => repeated.promise);
    const board = createBoardLoader(deps, publish, new AbortController().signal);
    const initial = board.load();
    await vi.waitFor(() => expect(states.at(-1)?.failedFilenames).toEqual(['test-card']));
    const retry = board.retry('test-card');
    expect(states.at(-1)?.pendingFilenames).toEqual(['other', 'test-card']);
    other.resolve(boardReadResult(makeCard({ title: 'Other loaded' })));
    await initial;
    expect(states.at(-1)).toMatchObject({ loading: false, pendingFilenames: ['test-card'] });
    repeated.resolve(boardReadResult(makeCard({ title: 'Retried' })));
    await retry;
    expect(states.at(-1)).toMatchObject({ pendingFilenames: [], failedFilenames: [],
      cards: [{ filename: 'test-card', title: 'Retried' }, { filename: 'other', title: 'Other loaded' }] });
  });

  it('ignores a retry response and further retry requests after unmount cancellation', async () => {
    const { states, deps, publish } = setup();
    const response = Promise.withResolvers<BoardCardLoadResult>();
    deps.load = vi.fn().mockResolvedValueOnce(boardReadResult(null)).mockImplementationOnce(() => response.promise);
    const controller = new AbortController();
    const board = createBoardLoader(deps, publish, controller.signal);
    await board.load();
    const retry = board.retry('test-card');
    controller.abort();
    const previous = structuredClone(states);
    response.resolve(boardReadResult(makeCard({ title: 'Late' })));
    await retry;
    await board.retry('test-card');
    expect(states).toEqual(previous);
    expect(deps.load).toHaveBeenCalledTimes(2);
  });
});

describe('board refresh interval and manual refresh', () => {
  function cached() {
    const result = setup();
    let timestamp = NOW;
    let record: BoardRefreshRecord | null = null;
    result.deps.now = () => timestamp;
    result.deps.sync = vi.fn(async () => {});
    result.deps.refreshCache = () => ({ read: () => record, write: value => { record = structuredClone(value); },
      run: task => task() });
    const board = () => createBoardLoader(result.deps, result.publish, new AbortController().signal);
    return { ...result, board, advance: (milliseconds: number) => { timestamp += milliseconds; }, snapshot: () => record };
  }

  it('shows cached notes without network work on another visit until the ten-minute boundary', async () => {
    const { board, deps, advance, states } = cached();
    await board().load();
    advance(BOARD_REFRESH_INTERVAL_MS - 1);
    await board().load();
    expect(deps.sync).toHaveBeenCalledTimes(1);
    expect(deps.load).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toMatchObject({ loading: false, source: 'indexeddb', nextRefreshAt: NOW + BOARD_REFRESH_INTERVAL_MS });
    advance(1);
    await board().load();
    expect(deps.sync).toHaveBeenCalledTimes(2);
  });

  it('forces every listed note to be read manually, including notes with a current local timestamp', async () => {
    const { board, deps, advance } = cached();
    deps.readLocal = async () => [makeCard({ meta: { id: 'test-card', created: NOW, modified: NOW } })];
    const loader = board();
    await loader.load();
    expect(deps.load).not.toHaveBeenCalled();
    advance(1);
    await loader.refresh();
    expect(deps.sync).toHaveBeenCalledTimes(2);
    expect(deps.load).toHaveBeenLastCalledWith(makeFile(), expect.any(AbortSignal), true);
    await loader.load();
    expect(deps.sync).toHaveBeenCalledTimes(2);
  });

  it('deduplicates refresh clicks while a full refresh is running', async () => {
    const { board, deps } = cached();
    const response = Promise.withResolvers<BoardCardLoadResult>();
    deps.load = vi.fn(() => response.promise);
    const loader = board();
    const first = loader.refresh();
    const second = loader.refresh();
    await vi.waitFor(() => expect(deps.load).toHaveBeenCalledTimes(1));
    response.resolve(boardReadResult(makeCard()));
    await Promise.all([first, second]);
    expect(deps.sync).toHaveBeenCalledTimes(1);
  });

  it('does not start an individual retry while a full refresh is listing the same notes', async () => {
    const { board, deps } = cached();
    deps.load = vi.fn().mockResolvedValueOnce(boardReadResult(null)).mockResolvedValue(boardReadResult(makeCard()));
    const loader = board();
    await loader.load();
    const listed = Promise.withResolvers<void>();
    deps.sync = vi.fn(() => listed.promise);
    const refresh = loader.refresh();
    await vi.waitFor(() => expect(deps.sync).toHaveBeenCalledTimes(1));
    await loader.retry('test-card');
    expect(deps.load).toHaveBeenCalledTimes(1);
    listed.resolve(); await refresh;
    expect(deps.load).toHaveBeenCalledTimes(2);
  });

  it('keeps note errors retryable on cached visits without repeating the full load', async () => {
    const { board, deps, states } = cached();
    deps.readLocal = async () => [];
    deps.load = vi.fn().mockResolvedValueOnce(boardReadResult(null)).mockResolvedValueOnce(boardReadResult(makeCard({ title: 'Retried' })));
    await board().load();
    const next = board();
    await next.load();
    expect(deps.load).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toMatchObject({ failedFilenames: ['test-card'], cards: [{ filename: 'test-card' }] });
    await next.retry('test-card');
    expect(deps.sync).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toMatchObject({ failedFilenames: [], cards: [{ title: 'Retried' }] });
  });

  it('preserves a failed note for retry after the user leaves during its retry', async () => {
    const { deps, states, publish, snapshot } = cached();
    const response = Promise.withResolvers<BoardCardLoadResult>();
    deps.load = vi.fn().mockResolvedValueOnce(boardReadResult(null)).mockImplementationOnce(() => response.promise);
    const controller = new AbortController();
    const loader = createBoardLoader(deps, publish, controller.signal);
    await loader.load();
    const retry = loader.retry('test-card');
    await vi.waitFor(() => expect(deps.load).toHaveBeenCalledTimes(2));
    controller.abort();
    response.resolve(boardReadResult(null));
    await retry;
    expect(snapshot()?.failedFilenames).toEqual(['test-card']);
    await createBoardLoader(deps, publish, new AbortController().signal).load();
    expect(states.at(-1)?.failedFilenames).toEqual(['test-card']);
    expect(deps.sync).toHaveBeenCalledTimes(1);
  });

  it('keeps an unresolved retry failure when the main queue finishes first', async () => {
    const { deps, states, publish, snapshot } = cached();
    const other = Promise.withResolvers<BoardCardLoadResult>();
    const repeated = Promise.withResolvers<BoardCardLoadResult>();
    deps.files = () => [makeFile(), makeFile({ name: 'other.md' })];
    deps.load = vi.fn().mockResolvedValueOnce(boardReadResult(null)).mockImplementationOnce(() => other.promise)
      .mockImplementationOnce(() => repeated.promise);
    const controller = new AbortController();
    const loader = createBoardLoader(deps, publish, controller.signal);
    const initial = loader.load();
    await vi.waitFor(() => expect(states.at(-1)?.failedFilenames).toEqual(['test-card']));
    const retry = loader.retry('test-card');
    other.resolve(boardReadResult(makeCard()));
    await initial;
    expect(snapshot()?.failedFilenames).toEqual(['test-card']);
    controller.abort();
    repeated.resolve(boardReadResult(null));
    await retry;
    expect(snapshot()?.failedFilenames).toEqual(['test-card']);
  });

  it('keeps the failure when a queued retry is cancelled before the main queue unwinds', async () => {
    const { deps, states, publish, snapshot } = cached();
    const cache = deps.refreshCache!()!;
    const other = Promise.withResolvers<BoardCardLoadResult>();
    cache.run = vi.fn().mockImplementationOnce(task => task()).mockImplementationOnce((_task, signal) =>
      new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
    deps.refreshCache = () => cache;
    deps.files = () => [makeFile(), makeFile({ name: 'other.md' })];
    deps.load = vi.fn().mockResolvedValueOnce(boardReadResult(null)).mockImplementationOnce(() => other.promise);
    const controller = new AbortController();
    const loader = createBoardLoader(deps, publish, controller.signal);
    const initial = loader.load();
    await vi.waitFor(() => expect(states.at(-1)?.failedFilenames).toEqual(['test-card']));
    const retry = loader.retry('test-card');
    controller.abort();
    await retry;
    other.resolve(boardReadResult(null));
    await initial;
    expect(snapshot()?.failedFilenames).toEqual(['test-card']);
  });

  it('does not replace newer refresh hints when retrying from an older tab', async () => {
    const { board, deps, advance, snapshot, states } = cached();
    const locals = [makeCard()];
    deps.readLocal = async () => locals;
    deps.load = vi.fn().mockResolvedValueOnce(boardReadResult(null)).mockImplementation(async file => {
      const card = makeCard({ meta: { id: file.name.slice(0, -3), created: NOW, modified: NOW } });
      const existing = locals.findIndex(local => local.meta.id === card.meta.id);
      if (existing >= 0) locals[existing] = card;
      else locals.push(card);
      return boardReadResult(card);
    });
    const olderTab = board();
    await olderTab.load();
    advance(BOARD_REFRESH_INTERVAL_MS);
    deps.files = () => [makeFile(), makeFile({ name: 'new-note.md' })];
    await board().refresh();
    const newer = structuredClone(snapshot());
    await olderTab.retry('test-card');
    expect(snapshot()).toEqual(newer);
    await board().load();
    expect(deps.sync).toHaveBeenCalledTimes(2);
    expect(states.at(-1)?.cards.map(card => card.filename)).toEqual(['test-card', 'new-note']);
  });

  it('does not suppress a cold load after the local note cache has been cleared', async () => {
    const { board, deps } = cached();
    await board().load();
    deps.readLocal = async () => [];
    await board().load();
    expect(deps.sync).toHaveBeenCalledTimes(2);
  });

  it('does not restart the full queue when the user returns after cancelling a partial refresh', async () => {
    const { deps, states, publish } = cached();
    let local: ReturnType<typeof makeCard>[] = [];
    deps.readLocal = async () => local;
    deps.files = () => [makeFile(), makeFile({ name: 'other.md' })];
    const controller = new AbortController();
    deps.load = vi.fn(async file => {
      if (file.name === 'other.md') { controller.abort(); return boardReadResult(null); }
      local = [makeCard()];
      return boardReadResult(local[0]);
    });
    await createBoardLoader(deps, publish, controller.signal).load();
    await createBoardLoader(deps, publish, new AbortController().signal).load();
    expect(deps.sync).toHaveBeenCalledTimes(1);
    expect(deps.load).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toMatchObject({ loading: false, pendingFilenames: [], cards: [
      { filename: 'test-card', title: 'Карточка 🗂' }, { filename: 'other', title: 'other' }
    ] });
  });

  it('throttles failed listings too, while allowing an immediate explicit refresh', async () => {
    const { board, deps, states } = cached();
    deps.sync = vi.fn().mockRejectedValueOnce(new Error('Listing unavailable')).mockResolvedValue(undefined);
    await board().load();
    const next = board();
    await next.load();
    expect(deps.sync).toHaveBeenCalledTimes(1);
    expect(states.at(-1)?.error).toBe('Listing unavailable');
    await next.refresh();
    expect(deps.sync).toHaveBeenCalledTimes(2);
    expect(states.at(-1)?.error).toBeNull();
  });
});
