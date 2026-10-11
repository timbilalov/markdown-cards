// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseMarkdownDocument, serializeMarkdownDocument } from '../domain/markdown';
import type { Card } from '../domain/types';
import v1 from './fixtures/v1-card.md?raw';
import minimal from './fixtures/v1-minimal.md?raw';
import legacy from './fixtures/legacy-card.md?raw';
import future from './fixtures/unsupported-version.md?raw';
import unknownMetadata from './fixtures/v1-unsupported-metadata.md?raw';

const card: Card = {
  title: 'Карточка 🗂',
  meta: {
    id: 'test-card',
    created: Date.parse('2026-09-01T08:09:10.123Z'),
    modified: Date.parse('2026-09-25T12:34:56.789Z')
  },
  description: 'Первый абзац **Markdown** и [ссылка](https://example.invalid).\n\nВторой абзац с `кодом`.',
  status: 'В процессе',
  tags: ['работа', 'test'],
  image: 'https://example.invalid/cover.png',
  sections: [
    { heading: 'Список', type: 'unordered', items: [
      { text: 'Обычный пункт', checked: false }, { text: 'Готовый пункт', checked: true }
    ] },
    { heading: 'Порядок', type: 'ordered', items: [
      { text: 'Первый', checked: false }, { text: 'Второй', checked: true }
    ] },
    { heading: 'Задачи', type: 'checklist', items: [
      { text: 'Проверить', checked: false }, { text: 'Сделано', checked: true }
    ] },
    { heading: 'Пустая секция', type: 'ordered', items: [] }
  ]
};

const minimalCard: Card = {
  title: 'Минимальная карточка',
  meta: {
    id: 'minimal-card',
    created: Date.parse('2026-09-01T00:00:00.000Z'),
    modified: Date.parse('2026-09-24T00:00:00.000Z')
  },
  description: '',
  sections: []
};

describe('Markdown v1: complete documents and normalization', () => {
  it('reads every field, list type and timestamp without losing the original source', () => {
    expect(parseMarkdownDocument(v1)).toEqual({
      status: 'success', document: { version: 1, source: v1, card }
    });
  });

  it('reads empty data without inventing optional fields', () => {
    expect(parseMarkdownDocument(minimal)).toEqual({
      status: 'success', document: { version: 1, source: minimal, card: minimalCard }
    });
  });

  it('normalizes CRLF in card text while retaining the exact original source', () => {
    const source = v1.replaceAll('\n', '\r\n');
    expect(parseMarkdownDocument(source)).toEqual({
      status: 'success', document: { version: 1, source, card }
    });
  });

  it('accepts an explicit timezone offset without losing milliseconds', () => {
    const source = v1.replace('2026-09-25T12:34:56.789Z', '2026-09-25T15:34:56.789+03:00');
    expect(parseMarkdownDocument(source)).toEqual({
      status: 'success', document: { version: 1, source, card }
    });
  });

  it('normalizes checklist X and redundant whole-item strikethrough', () => {
    const source = v1.replace('- [x] Сделано', '- [X] ~~Сделано~~');
    expect(parseMarkdownDocument(source)).toEqual({
      status: 'success', document: { version: 1, source, card }
    });
  });

  it.each(['unordered', 'ordered', 'checklist'] as const)('preserves an empty %s section', type => {
    const source = minimal.replace('## Meta', `### Пусто\n<!-- list-type: ${type} -->\n\n## Meta`);
    expect(parseMarkdownDocument(source)).toEqual({
      status: 'success',
      document: { version: 1, source, card: {
        ...minimalCard, sections: [{ heading: 'Пусто', type, items: [] }]
      } }
    });
  });

  it('preserves repeated list headings as separate ordered sections', () => {
    const source = v1.replace('### Порядок', '### Список');
    expect(parseMarkdownDocument(source)).toEqual({
      status: 'success',
      document: { version: 1, source, card: {
        ...card, sections: card.sections.map((section, index) =>
          index === 1 ? { ...section, heading: 'Список' } : section)
      } }
    });
  });
});

describe('Markdown v1: refuse partial reads and retain all source text', () => {
  it.each([
    ['unversioned legacy document', legacy, 'missing-version'],
    ['future version before attempting to parse its body', future, 'unknown-version'],
    ['unknown metadata', unknownMetadata, 'unsupported-content'],
    ['unknown top-level block', v1 + '\n## Notes\n\nKEEP-THIS-NOTE\n', 'unsupported-content'],
    ['prose inside a list', v1.replace('- Обычный пункт', 'KEEP-THIS-PROSE\n- Обычный пункт'), 'unsupported-content'],
    ['nested list', v1.replace('- Обычный пункт', '- Обычный пункт\n  - KEEP-NESTED'), 'unsupported-content'],
    ['raw HTML', v1.replace('Второй абзац с `кодом`.', '<img src="x" onerror="KEEP-THIS">'), 'unsupported-content'],
    ['fenced code block', v1.replace('Второй абзац с `кодом`.', '```js\nKEEP-CODE\n```'), 'unsupported-content'],
    ['unknown comment', v1.replace('Второй абзац с `кодом`.', '<!-- KEEP-COMMENT -->'), 'unsupported-content'],
    ['partial item strikethrough', v1.replace('- Обычный пункт', '- До ~~середина~~ после'), 'unsupported-content'],
    ['unknown list type', v1.replace('list-type: ordered', 'list-type: table'), 'unsupported-content']
  ])('rejects %s without returning an editable partial card', (_, source, reason) => {
    expect(parseMarkdownDocument(source)).toEqual({ status: 'unsupported', source, reason });
  });

  it.each([
    ['malformed version', v1.replace('markdown-cards: 1', 'markdown-cards: nope'), 'invalid-version'],
    ['repeated version marker', v1.replace('# Карточка', '<!-- markdown-cards: 1 -->\n\n# Карточка'), 'invalid-version'],
    ['missing title', v1.replace('# Карточка 🗂\n\n', ''), 'invalid-structure'],
    ['blank title', v1.replace('# Карточка 🗂', '# '), 'invalid-structure'],
    ['missing Data block', v1.replace('## Data\n\n', ''), 'invalid-structure'],
    ['repeated Data block', v1.replace('## Data', '## Data\n\n## Data'), 'invalid-structure'],
    ['missing Meta block', v1.slice(0, v1.indexOf('## Meta')), 'invalid-structure'],
    ['missing ID field', v1.replace('### ID\n\ntest-card\n\n', ''), 'invalid-structure'],
    ['duplicate ID', v1.replace('### Created', '### ID\n\nother-card\n\n### Created'), 'invalid-structure'],
    ['duplicate status', v1.replace('- **Status:** В процессе', '- **Status:** В процессе\n- **Status:** Done'), 'invalid-structure'],
    ['missing list type', v1.replace('<!-- list-type: unordered -->\n', ''), 'invalid-structure'],
    ['mixed list markers', v1.replace('- Обычный пункт', '1. Обычный пункт'), 'invalid-structure'],
    ['unchecked item marked complete', v1.replace('- [ ] Проверить', '- [ ] ~~Проверить~~'), 'invalid-structure'],
    ['unsafe ID', v1.replace('\ntest-card\n', '\n../outside\n'), 'invalid-id'],
    ['blank ID', v1.replace('\ntest-card\n', '\n \n'), 'invalid-id']
  ])('reports %s as invalid without a partial card', (_, source, reason) => {
    expect(parseMarkdownDocument(source)).toEqual({ status: 'invalid', source, reason });
  });

  it.each(['2026-09-25', 'not-a-date', '2026-02-30T12:34:56.789Z', '2026-09-25T12:34:56.789'])(
    'rejects invalid or ambiguous timestamp %s instead of defaulting to epoch', timestamp => {
      const source = v1.replace('2026-09-25T12:34:56.789Z', timestamp);
      expect(parseMarkdownDocument(source)).toEqual({
        status: 'invalid', source, reason: 'invalid-timestamp'
      });
    }
  );
});

describe('Markdown v1: validated canonical serialization', () => {
  it('writes the exact golden document with full UTC timestamps', () => {
    expect(serializeMarkdownDocument(card)).toEqual({ status: 'success', markdown: v1 });
  });

  it('writes a minimal document with a final newline and no optional metadata', () => {
    expect(serializeMarkdownDocument(minimalCard)).toEqual({ status: 'success', markdown: minimal });
  });

  it('round-trips a complete card and produces stable canonical Markdown', () => {
    const serialized = serializeMarkdownDocument(card);
    expect(serialized).toEqual({ status: 'success', markdown: v1 });
    if (serialized.status !== 'success') throw new Error('Expected serialization success');
    const parsed = parseMarkdownDocument(serialized.markdown);
    expect(parsed).toEqual({ status: 'success', document: { version: 1, source: v1, card } });
    if (parsed.status !== 'success') throw new Error('Expected parsing success');
    expect(serializeMarkdownDocument(parsed.document.card)).toEqual(serialized);
  });

  it('serializes a frozen card deterministically without mutating it', () => {
    const input = structuredClone(card);
    Object.freeze(input.meta);
    Object.freeze(input.tags);
    for (const section of input.sections) {
      section.items.forEach(Object.freeze);
      Object.freeze(section.items);
      Object.freeze(section);
    }
    Object.freeze(input.sections);
    Object.freeze(input);
    expect(serializeMarkdownDocument(input)).toEqual({ status: 'success', markdown: v1 });
    expect(serializeMarkdownDocument(input)).toEqual({ status: 'success', markdown: v1 });
    expect(input).toEqual(card);
  });

  it.each(['', 'new', '../outside', 'card.md'])('refuses to serialize invalid id %j', id => {
    expect(serializeMarkdownDocument({ ...card, meta: { ...card.meta, id } })).toEqual({
      status: 'invalid', reason: 'invalid-id'
    });
  });

  it.each([NaN, Infinity, 1.5, 8.64e15])('refuses invalid timestamp %s', modified => {
    expect(serializeMarkdownDocument({ ...card, meta: { ...card.meta, modified } })).toEqual({
      status: 'invalid', reason: 'invalid-timestamp'
    });
  });

  it.each([
    ['null', null],
    ['missing fields', {}],
    ['empty title', { ...card, title: '' }],
    ['wrong checked type', { ...card, sections: [{
      heading: 'Задачи', type: 'checklist', items: [{ text: 'Проверить', checked: 'false' }]
    }] }],
    ['unknown section type', { ...card, sections: [{ heading: 'Задачи', type: 'table', items: [] }] }],
    ['extra metadata', { ...card, meta: { ...card.meta, externalRevision: 'KEEP-THIS' } }],
    ['whitespace inside a tag', { ...card, tags: ['two words'] }]
  ])('refuses %s instead of emitting partial Markdown', (_, input) => {
    expect(serializeMarkdownDocument(input)).toEqual({ status: 'invalid', reason: 'invalid-card' });
  });

  it.each([
    ['heading in title', { ...card, title: 'Title\n## Meta' }],
    ['raw HTML', { ...card, description: '<img src="x" onerror="KEEP-THIS">' }],
    ['structural heading in description', { ...card, description: '## Meta\nKEEP-THIS' }],
    ['partial item strikethrough', { ...card, sections: [{
      heading: 'Список', type: 'unordered', items: [{ text: 'До ~~середина~~ после', checked: false }]
    }] }]
  ])('refuses unsupported content: %s', (_, input) => {
    expect(serializeMarkdownDocument(input)).toEqual({ status: 'invalid', reason: 'unsupported-content' });
  });
});
