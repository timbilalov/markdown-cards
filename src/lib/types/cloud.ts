export interface CloudFile {
  path: string;
  name: string;
  modified: string; // ISO date string
  size: number;
  etag?: string;
  type?: string;
  mime_type?: string;
  file?: string; // Download URL
}

export interface CloudFileListResponse {
  _embedded?: {
    items: CloudFile[];
    limit: number;
    offset: number;
    total: number;
  };
  path: string;
  type: string;
  name: string;
  created: string;
  modified: string;
}

export interface CloudUploadUrlResponse {
  href: string;
  method: string;
}

export interface SyncStatus {
  isSyncing: boolean;
  lastSync: number | null;
  error: string | null;
}
