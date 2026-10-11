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

// Preserve the board's legacy timestamp policy for display/refresh only.
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
        // Unknown remote time requires a read; retain the local date meanwhile.
        if (remote.modified !== undefined) display.modified = remote.modified;
        display.source = 'mixed';
        result.refreshFilenames.push(remote.filename);
      }
      result.cards.push(display);
    } else {
      result.cards.push({
        filename: remote.filename,
        title: remote.filename,
        modified: remote.modified,
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

  for (const card of cards) {
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
