export interface CloudFile {
  path: string;
  name: string;
  revision?: string;
  modified?: string; // ISO date string; omitted means unknown, never epoch/now.
}

export interface CloudFileListResponse {
  _embedded: {
    items: CloudFile[];
  };
}

export interface SyncStatus {
  isSyncing: boolean;
  lastSync: number | null;
  error: string | null;
}
