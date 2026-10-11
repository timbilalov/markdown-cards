import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { get } from 'svelte/store';
import MarkdownPreview from '../components/MarkdownPreview.svelte';
import { cardStore } from '../stores/cardStore';
import { serializeMarkdownDocument } from '../domain/markdown';
import type { Card } from '../domain/types';
import { makeCard } from './helpers/fixtures';

vi.mock('../stores/cardStore', async () => {
  const { writable } = await import('svelte/store');
  return { cardStore: writable(null) };
});

let target: HTMLDivElement;
let component: ReturnType<typeof mount> | undefined;
const safeLink = '[safe](https://example.invalid/ok)';

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

function show(card: Card) {
  expect(serializeMarkdownDocument(card).status, 'Payload must reach the actual renderer through strict v1').toBe('success');
  cardStore.set(card);
  component = mount(MarkdownPreview, { target, props: { formatVersion: 1 } });
  flushSync();
  expect(target.querySelector('[role="alert"]')).toBeNull();
}

const fields: ReadonlyArray<readonly [string, Partial<Card>]> = [
  ['title', { title: '[blocked](javascript:void%200)' }],
  ['description', { description: `Before [blocked](JaVaScRiPt:void%200) after ${safeLink}` }],
  ['status', { status: '[blocked](jav&#x61;script:void%200)' }],
  ['tag', { tags: ['[blocked](javascript:void%200)'] }],
  ['section heading', { sections: [{ heading: '[blocked](javascript&#58;void%200)', type: 'unordered', items: [] }] }],
  ...(['unordered', 'ordered', 'checklist'] as const).map((type): [string, Partial<Card>] => [
    `${type} item`, { sections: [{ heading: 'Tasks', type, items: [{ text: '[blocked](data:text/html;base64,PGI+dGVzdDwvYj4=)', checked: true }] }] }
  ])
];

describe('Actual preview sanitizes every Card field without rewriting the draft', () => {
  it.each(fields)('neutralizes a link in %s and recovers after editing raw HTML', (_name, fields) => {
    const card = makeCard({ description: safeLink, ...structuredClone(fields) });
    const before = structuredClone(card);
    const serializedBefore = serializeMarkdownDocument(card);
    show(card);

    expect(target.textContent).toContain('blocked');
    expect([...target.querySelectorAll('a[href]')].map(a => a.getAttribute('href'))).toEqual([
      'https://example.invalid/ok'
    ]);
    expect(get(cardStore)).toEqual(before);
    expect(serializeMarkdownDocument(get(cardStore))).toEqual(serializedBefore);

    // A later invalid edit still follows the existing whole-document refusal.
    const invalid = { ...before, description: '<img src="x" onerror="void 0">' };
    cardStore.set(invalid);
    flushSync();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('Изменения нельзя представить');
    expect(target.querySelector('h1, a, img, [onerror]')).toBeNull();
    expect(get(cardStore)).toEqual(invalid);

    cardStore.set(makeCard({ description: safeLink }));
    flushSync();
    expect(target.querySelector('[role="alert"]')).toBeNull();
    expect(target.querySelector('h1')?.textContent).toBe('Карточка 🗂');
    expect(target.querySelector('a')?.getAttribute('href')).toBe('https://example.invalid/ok');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['javascript:void%200', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'file:///private/image.png'])(
    'removes unsafe cover src %s and reacts to a safe replacement', image => {
      const card = makeCard({ image });
      const before = structuredClone(card);
      show(card);

      expect(target.querySelector('h1')?.textContent).toBe(card.title);
      expect(target.querySelector('img[src]')).toBeNull();
      expect(get(cardStore)).toEqual(before);

      cardStore.set({ ...card, image: '/images/cover.png' });
      flushSync();
      expect(target.querySelector('img')?.getAttribute('src')).toBe('/images/cover.png');
      expect(fetch).not.toHaveBeenCalled();
    });
});
