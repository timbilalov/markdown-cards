import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MarkdownPreview from '../components/MarkdownPreview.svelte';
import { cardStore } from '../stores/cardStore';
import { makeCard } from './helpers/fixtures';

vi.mock('../stores/cardStore', async () => {
  const { writable } = await import('svelte/store');
  return { cardStore: writable(null) };
});

let target: HTMLDivElement;
let component: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  target = document.createElement('div');
  document.body.append(target);
  cardStore.set(null);
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target.remove();
});

describe('Markdown preview: actual component', () => {
  it('renders Markdown from the current card and reacts to edits', () => {
    cardStore.set(makeCard());
    component = mount(MarkdownPreview, { target, props: { formatVersion: 1 } });
    flushSync();
    expect(target.querySelector('h1')?.textContent).toBe('Карточка 🗂');
    expect(target.querySelector('strong')?.textContent).toBe('Status:');
    cardStore.set(makeCard({ title: 'Изменённый заголовок' }));
    flushSync();
    expect(target.querySelector('h1')?.textContent).toBe('Изменённый заголовок');
  });
});
