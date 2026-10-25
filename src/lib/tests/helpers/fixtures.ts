import type { Card } from '../../domain/types';
import type { CloudFile, CloudFileListResponse } from '../../types/cloud';
import type { BoardCardLoadResult } from '../../application/loadBoard';

export function boardReadResult(card: Card | null): BoardCardLoadResult {
  return card ? { status: 'loaded', card } : { status: 'unavailable' };
}

export const NOW = Date.parse('2026-09-25T12:34:56.789Z');
export const DAY = 24 * 60 * 60 * 1000;
// Only historical fixtures contain provider metadata; live DTOs remain minimal.
export interface LegacyCloudFile extends CloudFile {
  size?: number; etag?: string; type?: string; mime_type?: string; file?: string;
}

export function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    title: 'Карточка 🗂',
    meta: { id: 'test-card', created: Date.parse('2026-09-01'), modified: Date.parse('2026-09-24') },
    description: 'Текст **Markdown** с [ссылкой](https://example.invalid).',
    status: 'В процессе', tags: ['работа', 'test'], image: 'https://example.invalid/cover.png',
    sections: [{ heading: 'Задачи', type: 'checklist', items: [{ text: 'Проверить', checked: false }] }],
    ...overrides
  };
}

export function makeFile(overrides: Partial<LegacyCloudFile> = {}): LegacyCloudFile {
  return {
    name: 'test-card.md', path: 'disk:/md-cards/test-card.md',
    modified: new Date(NOW).toISOString(), size: 100,
    file: 'https://downloader.disk.yandex.ru/test-file', ...overrides
  };
}

// Legacy DBService adds meta.title for its title index; retain this assertion
// until the repository migration deliberately removes that storage detail.
export function storedCard(card: Card, filename = card.meta.id) {
  return { ...card, meta: { ...card.meta, title: card.title },
    ...(filename !== card.meta.id ? { filename } : {}) };
}

export function fileList(items: CloudFile[] = []): CloudFileListResponse {
  // Match the minimal API DTO; provider-only fields in historical fixtures
  // stay outside the browser transport.
  return {
    _embedded: { items: items.map(file => ({ name: file.name, path: file.name,
      ...(file.modified === undefined ? {} : { modified: file.modified }) })) }
  };
}
