import type { Card, CardId } from '../../domain/types';
import type { LocalCardRepository } from '../../ports/localCardRepository';
import { runIndexedDbTransaction } from './transaction';

// Borrow the owner's open connection; only the existing cards store is in scope.
// Opening/upgrading/closing connections and cleanup policy stay with the owner.
export class IndexedDbLocalCardRepository implements LocalCardRepository {
  constructor(private readonly database: IDBDatabase) {}

  async read(id: CardId): Promise<Card | null> {
    let card: Card | null = null;
    await runIndexedDbTransaction(this.database, 'cards', 'readonly', transaction => {
      const request: IDBRequest<Card | undefined> = transaction.objectStore('cards').get(id);
      request.addEventListener('success', () => {
        card = request.result ?? null;
      }, { once: true });
    });
    return card;
  }

  async list(): Promise<Card[]> {
    let cards: Card[] = [];
    await runIndexedDbTransaction(this.database, 'cards', 'readonly', transaction => {
      const request: IDBRequest<Card[]> = transaction.objectStore('cards').getAll();
      request.addEventListener('success', () => {
        cards = request.result;
      }, { once: true });
    });
    return cards;
  }

  async write(card: Readonly<Card>): Promise<void> {
    await runIndexedDbTransaction(this.database, 'cards', 'readwrite', transaction => {
      // put clones nested input synchronously, before the first await. Keep the
      // deployed index alias without mutating the caller's Card or timestamps.
      transaction.objectStore('cards').put({
        ...card,
        meta: { ...card.meta, title: card.title }
      });
    });
  }

  async delete(id: CardId): Promise<void> {
    await runIndexedDbTransaction(this.database, 'cards', 'readwrite', transaction => {
      transaction.objectStore('cards').delete(id);
    });
  }
}
