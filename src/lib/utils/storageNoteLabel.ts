import { parseMarkdownDocument } from '../domain/markdown';
import type { NoteInventoryRow } from '../domain/storageSync';

export function storageNoteLabel(row: NoteInventoryRow): string {
  const { versions, freshness } = row.comparison;
  if (freshness.status === 'latest') {
    const latest = versions.find(version =>
      version.storageIds.some(id => freshness.storageIds.includes(id))
    );
    if (latest) {
      const parsed = parseMarkdownDocument(latest.source);
      if (parsed.status === 'success') return `${parsed.document.card.title} · ${row.path}`;
    }
    return row.path;
  }

  const titles = new Set<string>();
  for (const version of versions) {
    const parsed = parseMarkdownDocument(version.source);
    if (parsed.status === 'success') titles.add(parsed.document.card.title);
  }
  return titles.size > 1 ? `${row.path} · названия различаются` : row.path;
}
