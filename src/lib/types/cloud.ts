export interface CloudFile {
  path: string;
  type: 'file' | 'dir';
  name: string;
  created: string;
  modified: string;
  size?: number;
  mime_type?: string;
  md5?: string;
  sha256?: string;
  media_type?: string;
  resource_id: string;
  revision: number;
  file?: string; // Download link
}

export interface CloudFileListResponse {
  path: string;
  type: 'dir';
  name: string;
  created: string;
  modified: string;
  _embedded: {
    path: string;
    limit: number;
    offset: number;
    sort: string;
    total: number;
    items: CloudFile[];
  };
  resource_id: string;
  revision: number;
}

export interface CloudUploadUrlResponse {
  method: string;
  href: string;
  templated: boolean;
  operation_id: string;
}

export interface CloudConfig {
  accessToken: string | null;
  basePath: string;
}

export interface SyncStatus {
  isSyncing: boolean;
  lastSync: number | null;
  error: string | null;
}
