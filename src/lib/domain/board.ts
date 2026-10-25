import type { BoardCard, BoardColumn, BoardProjection, BoardLocalEntry, RemoteCardMetadata } from './types';

function localFilename(card: BoardLocalEntry): string {
  return 'sourceOnly' in card ? card.filename : card.filename ?? card.meta.id;
}
function localDisplay(card: BoardLocalEntry): BoardCard {
  if ('sourceOnly' in card) return { filename: card.filename, title: card.filename, source: 'indexeddb', readOnly: true };
  return {
    filename: localFilename(card),
    title: card.title,
    modified: card.meta.modified,
    source: 'indexeddb',
    status: card.status,
    image: card.image,
    ...(card.readOnly ? { readOnly: true } : {})
  };
}

// Provider timestamps request refreshes; display dates belong to documents.
// Pending writes and revision conflicts require the separate sync policy.
export function reconcileBoardCards(
  localCards: readonly BoardLocalEntry[],
  remoteMetadata: readonly RemoteCardMetadata[]
): BoardProjection {
  const locals = new Map(localCards.map(card => [localFilename(card), card]));
  const remotes = new Map(remoteMetadata.map(remote => [remote.filename, remote]));
  const result: BoardProjection = { cards: [], refreshFilenames: [] };

  for (const remote of remotes.values()) {
    const local = locals.get(remote.filename);
    if (local) {
      const display = localDisplay(local);
      if ('sourceOnly' in local || remote.modified === undefined || remote.modified > local.meta.modified) {
        // Retain the document date while reading, even if the provider's mtime
        // differs. Otherwise listing alone would reorder the cached board.
        display.source = 'mixed';
        result.refreshFilenames.push(remote.filename);
      }
      result.cards.push(display);
    } else {
      result.cards.push({
        filename: remote.filename,
        title: remote.filename,
        source: 'cloud'
      });
      result.refreshFilenames.push(remote.filename);
    }
  }

  for (const local of locals.values()) {
    if (!remotes.has(localFilename(local))) result.cards.push(localDisplay(local));
  }

  return result;
}

export function deriveBoardColumns(cards: readonly BoardCard[]): BoardColumn[] {
  const columns = new Map<string, BoardColumn>(
    ['Предстоящие', 'В процессе', 'Done'].map(status => [status, { status, cards: [] }])
  );

  // Both cached and downloaded cards use the document's Modified date. Unknown
  // dates go last; filename resolves equal dates independently of source order.
  for (const card of [...cards].sort((left, right) => {
    if (left.modified === undefined) {
      if (right.modified !== undefined) return 1;
    } else if (right.modified === undefined) return -1;
    else if (left.modified !== right.modified) return right.modified - left.modified;
    return left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0;
  })) {
    const status = card.status || 'Без статуса';
    let column = columns.get(status);
    if (!column) {
      column = { status, cards: [] };
      columns.set(status, column);
    }
    column.cards.push(card);
  }

  return Array.from(columns.values());
}
