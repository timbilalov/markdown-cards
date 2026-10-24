import { DBService } from './dbService';
import { checkIsStorageContextId } from '../utils/storageValidation';

// An immutable database instance per verified context.
export function createContextDatabase(contextId: string): DBService {
  if (!checkIsStorageContextId(contextId)) throw new Error('Invalid storage context');
  return new DBService(`MarkdownCardsDB:${contextId}`);
}
