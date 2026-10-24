import type { RemoteRevision } from '../domain/types';

// Paths are relative to the configured storage root and independent of Card ID.
// Input/path validation belongs at the adapter boundary; no provider URLs here.
export interface CloudEntry {
  path: string;
  revision: RemoteRevision | null;
}

export interface CloudListEntry extends CloudEntry {
  // Optional Unix milliseconds for display/cache freshness only, never a revision.
  // Omitted means unknown; adapters must not substitute the current time or zero.
  modifiedAt?: number;
}

export interface CloudDocument extends CloudEntry {
  source: string;
}

// expectedRevision requires atomic revision equality; unsupported adapters must
// refuse it without silently falling back to an unconditional write.
export interface CloudStorageCapabilities {
  revisions: boolean;
  conditionalCreate: boolean;
  conditionalUpdate?: boolean;
  caseSensitivePaths?: boolean;
}

export type CloudUnavailableReason = 'auth' | 'network' | 'remote' | 'invalid-response';
export type CloudUnavailable = { status: 'unavailable'; reason: CloudUnavailableReason };

// A successful list is complete; pagination is internal to the adapter.
export type CloudListResult = { status: 'success'; entries: CloudListEntry[] } | CloudUnavailable;
export type CloudReadResult =
  | { status: 'found'; document: CloudDocument }
  | { status: 'not-found' }
  | { status: 'invalid'; reason: 'invalid-path' }
  | CloudUnavailable;

export interface CloudWriteRequest {
  path: string;
  source: string;
  // Omitted/false creates or replaces; true refuses an existing path.
  createOnly?: boolean;
  expectedRevision?: RemoteRevision;
}

export type CloudWriteResult =
  | { status: 'written'; revision: RemoteRevision | null }
  | { status: 'conflict' }
  | { status: 'unsupported'; operation: 'create-only' | 'conditional-update' }
  | { status: 'invalid'; reason: 'invalid-create-only' | 'invalid-path' | 'invalid-source' | 'invalid-revision' }
  // A lost response may follow a committed write. Never infer absence/success.
  | (CloudUnavailable & { outcome: 'not-written' | 'unknown' });

export interface CloudStoragePort {
  getCapabilities(): CloudStorageCapabilities;
  list(): Promise<CloudListResult>;
  read(path: string, signal?: AbortSignal): Promise<CloudReadResult>;
  // Ordinary write by default; createOnly requests atomic creation without replacement.
  write(request: CloudWriteRequest): Promise<CloudWriteResult>;
}
