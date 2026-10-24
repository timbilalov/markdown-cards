import type { DBService } from '../services/dbService';
import type { CloudListResult, CloudReadResult } from '../ports/cloudStorage';
import { checkIsMarkdownFilename } from '../domain/markdownFilename';

export class LocalNoteStorage {
  constructor(private readonly database: DBService) {}
  async list(): Promise<CloudListResult> {
    try {
      const cards = await this.database.getBoardCards();
      const paths = cards.map(
        card => `${'sourceOnly' in card ? card.filename : (card.filename ?? card.meta.id)}.md`
      );
      if (paths.some(path => !checkIsMarkdownFilename(path)))
        return { status: 'unavailable', reason: 'invalid-response' };
      return {
        status: 'success',
        entries: [...new Set(paths)].map(path => ({ path, revision: null }))
      };
    } catch {
      return { status: 'unavailable', reason: 'remote' };
    }
  }
  async read(path: string): Promise<CloudReadResult> {
    if (!checkIsMarkdownFilename(path)) return { status: 'invalid', reason: 'invalid-path' };
    try {
      const current = await (await this.database.getSyncRepositories()).saves.readCurrent(path);
      const source = current.draft ?? current.remote;
      if (source)
        return { status: 'found', document: { path, source: source.source, revision: null } };
      const listed = await this.list();
      if (listed.status !== 'success') return listed;
      return listed.entries.some(entry => entry.path === path)
        ? { status: 'unavailable', reason: 'invalid-response' }
        : { status: 'not-found' };
    } catch {
      return { status: 'unavailable', reason: 'remote' };
    }
  }
}
