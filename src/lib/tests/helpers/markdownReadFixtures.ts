import type { Card } from '../../domain/types';
import v1 from '../fixtures/v1-card.md?raw';
import legacy from '../fixtures/migration-legacy.md?raw';

export { v1 };

// Explicit golden expectation, independent of either production parser.
export const v1Card: Card = {
  title: 'Карточка 🗂',
  meta: {
    id: 'test-card',
    created: Date.parse('2026-09-01T08:09:10.123Z'),
    modified: Date.parse('2026-09-25T12:34:56.789Z')
  },
  description: 'Первый абзац **Markdown** и [ссылка](https://example.invalid).\n\nВторой абзац с `кодом`.',
  status: 'В процессе', tags: ['работа', 'test'], image: 'https://example.invalid/cover.png',
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

export const futureV1Shape = v1.replace('markdown-cards: 1', 'markdown-cards: 2');
export const unknownMetadata = v1 + '\n### External revision\n\nKEEP-THIS-REVISION\n';

// A future version deliberately retains v1-looking fields: a permissive
// parser must not be allowed to accept it just because the body looks familiar.
export const rejectedMarkdown: ReadonlyArray<readonly [string, string]> = [
  ['unmigrated legacy', legacy],
  ['future version', futureV1Shape],
  ['unknown metadata', unknownMetadata],
  ['malformed version marker', v1.replace('markdown-cards: 1', 'markdown-cards: broken')],
  ['invalid timestamp', v1.replace('2026-09-25T12:34:56.789Z', 'not-a-date')],
  ['unsafe ID', v1.replace('\ntest-card\n', '\n../outside\n')]
];
