import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { get, writable } from 'svelte/store';
import MarkdownPreview from '../components/MarkdownPreview.svelte';
import MarkdownPreviewHarness from './helpers/MarkdownPreviewHarness.svelte';
import { cardStore } from '../stores/cardStore';
import { v1Card } from './helpers/markdownReadFixtures';

vi.mock('../stores/cardStore', async () => {
  const { writable } = await import('svelte/store');
  return { cardStore: writable(null) };
});

const noFormatMessage = 'Формат заметки не определён. Откройте её заново.';
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

function expectMissingFormat() {
  expect(target.querySelector('[role="alert"]')?.textContent?.trim()).toBe(noFormatMessage);
  expect(target.querySelector('h1, h2, h3, ul, ol, img')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
}

describe('Preview requires an explicit current format', () => {
  it.each([
    ['omitted version', {}],
    ['explicit null version', { formatVersion: null }]
  ] as const)('refuses %s even for a representable Card without changing the draft', (_name, props) => {
    const draft = structuredClone(v1Card);
    cardStore.set(draft);
    component = mount(MarkdownPreview, { target, props });
    flushSync();

    expectMissingFormat();
    expect(get(cardStore)).toEqual(v1Card);
  });

  it('does not render raw HTML through an unversioned fallback', () => {
    // Inspect inert markup only; do not execute the handler or load resources.
    const draft = { ...structuredClone(v1Card), description: '<img src="x" onerror="void 0">' };
    const before = structuredClone(draft);
    cardStore.set(draft);
    component = mount(MarkdownPreview, { target });
    flushSync();

    expectMissingFormat();
    expect(target.querySelector('[onerror]')).toBeNull();
    expect(get(cardStore)).toEqual(before);
  });

  it('keeps unknown draft metadata instead of rendering a partial legacy representation', () => {
    const draft = { ...structuredClone(v1Card), meta: { ...v1Card.meta, futureRevision: 'KEEP-THIS' } };
    const before = structuredClone(draft);
    cardStore.set(draft);
    component = mount(MarkdownPreview, { target, props: { formatVersion: null } });
    flushSync();

    expectMissingFormat();
    expect(get(cardStore)).toEqual(before);
  });

  it('removes a previous v1 preview when the format disappears and recovers without remounting', () => {
    const draft = structuredClone(v1Card);
    const version = writable<1 | null>(1);
    cardStore.set(draft);
    component = mount(MarkdownPreviewHarness, { target, props: { version } });
    flushSync();
    expect(target.querySelector('h1')?.textContent).toBe(v1Card.title);
    expect(target.textContent).toContain('2026-09-25T12:34:56.789Z');

    version.set(null);
    flushSync();
    expectMissingFormat();
    expect(get(cardStore)).toEqual(v1Card);

    cardStore.set({ ...draft, title: 'Черновик после отказа' });
    version.set(1);
    flushSync();
    expect(target.querySelector('[role="alert"]')).toBeNull();
    expect(target.querySelector('h1')?.textContent).toBe('Черновик после отказа');
    expect(target.textContent).toContain('2026-09-25T12:34:56.789Z');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('clears the missing-format message for an empty store, then validates and renders the next v1 draft', () => {
    const version = writable<1 | null>(null);
    cardStore.set(structuredClone(v1Card));
    component = mount(MarkdownPreviewHarness, { target, props: { version } });
    flushSync();
    expectMissingFormat();

    cardStore.set(null);
    flushSync();
    expect(target.textContent?.trim()).toBe('');
    expect(target.querySelector('[role="alert"]')).toBeNull();

    const invalidDraft = { ...structuredClone(v1Card), description: '# KEEP-THIS-HEADING' };
    cardStore.set(invalidDraft);
    flushSync();
    expectMissingFormat();

    version.set(1);
    flushSync();
    expect(target.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
      'Изменения нельзя представить в текущем формате заметки. Проверьте содержимое в редакторе.');
    expect(target.querySelector('h1')).toBeNull();
    expect(get(cardStore)).toEqual(invalidDraft);

    cardStore.set(structuredClone(v1Card));
    flushSync();
    expect(target.querySelector('[role="alert"]')).toBeNull();
    expect(target.querySelector('h1')?.textContent).toBe(v1Card.title);
    expect(target.textContent).toContain('2026-09-01T08:09:10.123Z');
    expect(fetch).not.toHaveBeenCalled();
  });
});
