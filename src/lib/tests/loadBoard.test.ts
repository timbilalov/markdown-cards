import { describe, expect, it, vi } from 'vitest';
import { loadBoard, type BoardLoadState, type BoardDependencies } from '../application/loadBoard';
import { makeCard, makeFile } from './helpers/fixtures';
function setup() {
  const states: BoardLoadState[] = [];
  const deps: BoardDependencies = { init: async () => {}, readLocal: async () => [makeCard()],
    sync: async () => {}, files: () => [makeFile()], load: vi.fn(async () => makeCard({ title: 'Remote' })),
    checkIsOffline: () => false, clock: () => 100 };
  return { states, deps, publish: (state: BoardLoadState) => { states.push(structuredClone(state)); } };
}
describe('board loading application scenario', () => {
  it('publishes local cards immediately, then merged cloud content', async () => {
    const { states, deps, publish } = setup();
    await loadBoard(deps, publish, new AbortController().signal);
    expect(states.map(state => [state.source, state.cards[0]?.title])).toEqual([
      ['indexeddb', 'Карточка 🗂'], ['mixed', 'Remote']
    ]);
    expect(states.at(-1)?.loading).toBe(false);
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
