// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { migrateMarkdownDocument } from '../domain/markdownMigration';
import type { Card } from '../domain/types';
import legacy from './fixtures/migration-legacy.md?raw';
import migrated from './fixtures/migration-v1.md?raw';
import legacyWithAlt from './fixtures/legacy-card.md?raw';
import minimalV1 from './fixtures/v1-minimal.md?raw';
import future from './fixtures/unsupported-version.md?raw';
import unknownMetadata from './fixtures/v1-unsupported-metadata.md?raw';

const transition = { fromVersion: 0, toVersion: 1 };
const card: Card = {
  title: 'Карточка 🗂',
  meta: {
    id: 'test-card',
    created: Date.parse('2026-09-01T00:00:00.000Z'),
    modified: Date.parse('2026-09-24T00:00:00.000Z')
  },
  status: 'В процессе',
  tags: ['работа', 'test'],
  image: 'https://example.invalid/cover.png',
  description: 'Первый абзац **Markdown** и [ссылка](https://example.invalid).\n\nВторой абзац с `кодом`.',
  sections: [
    { heading: 'Список', type: 'unordered', items: [
      { text: 'Обычный пункт', checked: false }, { text: 'Готовый пункт', checked: true }
    ] },
    { heading: 'Порядок', type: 'ordered', items: [
      { text: 'Первый', checked: false }, { text: 'Второй', checked: true }
    ] },
    { heading: 'Задачи', type: 'checklist', items: [
      { text: 'Проверить', checked: false }, { text: 'Сделано', checked: true },
      { text: 'Проверено', checked: true }
    ] },
    { heading: 'Пустая секция', type: 'unordered', items: [] }
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
const minimalLegacy = minimalV1
  .replace('<!-- markdown-cards: 1 -->\n\n', '')
  .replaceAll('T00:00:00.000Z', '');

function expectMigrated(source: string, markdown: string, expectedCard: Card) {
  expect(migrateMarkdownDocument(source)).toEqual({
    status: 'success', source,
    document: { version: 1, source: markdown, card: expectedCard },
    appliedSteps: [transition]
  });
}

describe('explicit legacy to v1 migration', () => {
  it('preserves every card field and emits the exact golden v1 document', () => {
    expectMigrated(legacy, migrated, card);
  });

  it('migrates minimal data without inventing optional fields', () => {
    expectMigrated(minimalLegacy, minimalV1, minimalCard);
  });

  it('retains the original CRLF source while emitting canonical LF', () => {
    expectMigrated(legacy.replaceAll('\n', '\r\n'), migrated, card);
  });

  it('retains existing timestamp precision and converts explicit offsets to UTC', () => {
    const source = legacy.replace('2026-09-24', '2026-09-24T15:34:56.789+03:00');
    expectMigrated(source, migrated.replace('2026-09-24T00:00:00.000Z', '2026-09-24T12:34:56.789Z'), {
      ...card, meta: { ...card.meta, modified: Date.parse('2026-09-24T12:34:56.789Z') }
    });
  });

  it('interprets a real date-only leap day as midnight UTC', () => {
    const source = minimalLegacy.replace('2026-09-01', '2024-02-29');
    expectMigrated(source, minimalV1.replace('2026-09-01', '2024-02-29'), {
      ...minimalCard, meta: { ...minimalCard.meta, created: Date.parse('2024-02-29T00:00:00.000Z') }
    });
  });

  it('preserves separate lists with repeated headings in their original order', () => {
    expectMigrated(legacy.replace('### Порядок', '### Список'), migrated.replace('### Порядок', '### Список'), {
      ...card,
      sections: card.sections.map((section, index) => index === 1 ? { ...section, heading: 'Список' } : section)
    });
  });

  it('assigns unordered to an empty legacy list whose original type is absent', () => {
    expectMigrated(
      minimalLegacy.replace('## Meta', '### Пусто\n\n## Meta'),
      minimalV1.replace('## Meta', '### Пусто\n<!-- list-type: unordered -->\n\n## Meta'),
      { ...minimalCard, sections: [{ heading: 'Пусто', type: 'unordered', items: [] }] }
    );
  });

  it('is idempotent when called again with the successfully migrated document', () => {
    const result = migrateMarkdownDocument(legacy);
    expect(result).toEqual({
      status: 'success', source: legacy,
      document: { version: 1, source: migrated, card }, appliedSteps: [transition]
    });
    if (result.status !== 'success') throw new Error('Expected a successful migration');
    expect(migrateMarkdownDocument(result.document.source)).toEqual({
      status: 'success', source: migrated,
      document: { version: 1, source: migrated, card }, appliedSteps: []
    });
  });

  it('validates current v1 and leaves even noncanonical source byte-for-byte unchanged', () => {
    const source = minimalV1.replace('2026-09-01T00:00:00.000Z', '2026-09-01T03:00:00+03:00')
      .replaceAll('\n', '\r\n');
    expect(migrateMarkdownDocument(source)).toEqual({
      status: 'success', source,
      document: { version: 1, source, card: minimalCard }, appliedSteps: []
    });
  });
});

describe('migration refuses any partial or ambiguous conversion', () => {
  it.each([
    ['image alt text not representable in v1', legacyWithAlt],
    ['unknown metadata', legacy + '\n### External revision\n\nKEEP-REVISION\n'],
    ['unknown root block', legacy + '\n## Notes\n\nKEEP-NOTE\n'],
    ['prose following a list', legacy.replace('### Порядок', 'KEEP-PROSE\n\n### Порядок')],
    ['nested list', legacy.replace('- Обычный пункт', '- Обычный пункт\n  - KEEP-NESTED')],
    ['partial strikethrough', legacy.replace('- Обычный пункт', '- До ~~середина~~ после')],
    ['raw HTML', legacy.replace('Второй абзац с `кодом`.', '<b>KEEP-HTML</b>')],
    ['fenced code', legacy.replace('Второй абзац с `кодом`.', '```js\nKEEP-CODE\n```')],
    ['unknown comment', legacy.replace('Второй абзац с `кодом`.', '<!-- KEEP-COMMENT -->')],
    ['v1 list marker without a document version', legacy.replace('### Список', '### Список\n<!-- list-type: unordered -->')]
  ])('retains the entire source and no converted document for %s', (_, source) => {
    expect(migrateMarkdownDocument(source)).toEqual({
      status: 'unsupported', source, reason: 'unsupported-content'
    });
  });

  it.each([
    ['missing title', minimalLegacy.replace('# Минимальная карточка\n\n', '')],
    ['missing Meta', minimalLegacy.slice(0, minimalLegacy.indexOf('## Meta'))],
    ['missing Created', minimalLegacy.replace('### Created\n\n2026-09-01\n\n', '')],
    ['duplicate ID', minimalLegacy.replace('### Created', '### ID\n\nother-id\n\n### Created')],
    ['duplicate Data', minimalLegacy.replace('## Data', '## Data\n\n## Data')],
    ['duplicate status', legacy.replace('- **Status:** В процессе', '- **Status:** В процессе\n- **Status:** Done')],
    ['mixed list types', legacy.replace('- Обычный пункт', '1. Обычный пункт')],
    ['contradictory unchecked item', legacy.replace('- [ ] Проверить', '- [ ] ~~Проверить~~')]
  ])('rejects %s instead of guessing a replacement', (_, source) => {
    expect(migrateMarkdownDocument(source)).toEqual({ status: 'invalid', source, reason: 'invalid-structure' });
  });

  it.each(['2026-02-29', '2026-02-30', '2026-13-01', '24/09/2026', 'not-a-date', '2026-09-24T12:00:00'])(
    'rejects impossible or ambiguous legacy timestamp %s', timestamp => {
      const source = minimalLegacy.replace('2026-09-24', timestamp);
      expect(migrateMarkdownDocument(source)).toEqual({ status: 'invalid', source, reason: 'invalid-timestamp' });
    }
  );

  it.each(['../outside', 'new', ''])('rejects unsafe or missing legacy ID %j', id => {
    const source = minimalLegacy.replace('minimal-card', id);
    expect(migrateMarkdownDocument(source)).toEqual({ status: 'invalid', source, reason: 'invalid-id' });
  });

  it('rejects a future version before interpreting its unfamiliar body', () => {
    expect(migrateMarkdownDocument(future)).toEqual({ status: 'unsupported', source: future, reason: 'unknown-version' });
  });

  it.each([
    ['nonnumeric', minimalV1.replace('markdown-cards: 1', 'markdown-cards: nope')],
    ['explicit zero is not unversioned legacy', minimalV1.replace('markdown-cards: 1', 'markdown-cards: 0')],
    ['misplaced', minimalLegacy + '\n<!-- markdown-cards: 1 -->\n'],
    ['repeated', minimalV1 + '\n<!-- markdown-cards: 1 -->\n']
  ])('rejects a %s version marker instead of treating it as legacy', (_, source) => {
    expect(migrateMarkdownDocument(source)).toEqual({ status: 'invalid', source, reason: 'invalid-version' });
  });

  it('refuses unsupported current v1 content without returning an editable document', () => {
    expect(migrateMarkdownDocument(unknownMetadata)).toEqual({
      status: 'unsupported', source: unknownMetadata, reason: 'unsupported-content'
    });
  });

  it('does not repair an invalid current v1 date by applying legacy rules', () => {
    const source = minimalV1.replace('2026-09-01T00:00:00.000Z', '2026-09-01');
    expect(migrateMarkdownDocument(source)).toEqual({ status: 'invalid', source, reason: 'invalid-timestamp' });
  });

  it('retains CRLF and unknown fragments exactly when migration fails', () => {
    const source = legacyWithAlt.replaceAll('\n', '\r\n');
    expect(migrateMarkdownDocument(source)).toEqual({ status: 'unsupported', source, reason: 'unsupported-content' });
  });
});
