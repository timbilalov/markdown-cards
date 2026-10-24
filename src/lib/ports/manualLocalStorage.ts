import type { NoteStorage } from './noteStorage';
import type { StoredMarkdownDraft } from './cardSaveRepository';
import type { StoredMarkdownSource } from './markdownSourceRepository';
import type { OutboxOperation } from '../domain/outbox';

export interface ManualSyncArchive {
  id: string;
  path: string;
  createdAt: number;
  draft: StoredMarkdownDraft | null;
  remote: StoredMarkdownSource | null;
  operations: OutboxOperation[];
}

export interface ManualLocalStorage {
  copy: NoteStorage['copy'];
  prepareCloud(path: string): Promise<'ready' | 'uncertain'>;
  finishCloud(path: string, source: string): Promise<void>;
  protect(path: string): Promise<void>;
  archives(): Promise<ManualSyncArchive[]>;
}
