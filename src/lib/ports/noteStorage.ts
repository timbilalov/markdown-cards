import type { CloudStoragePort, CloudWriteResult } from './cloudStorage';
import type { ExpectedTargetNote } from '../domain/storageSync';

export interface NoteStorageReader extends Pick<CloudStoragePort, 'list' | 'read'> {
  id: string;
}

export interface NoteStorage extends NoteStorageReader {
  label: string;
  kind: 'cloud' | 'local';
  contextId: string | null;
  caseSensitive: boolean;
  copy(input: {
    path: string;
    source: string;
    expectedTarget: ExpectedTargetNote;
  }): Promise<CloudWriteResult>;
}
