export interface ManualSyncOperation {
  id: string;
  targetKey: string;
  pathKey: string;
  path: string;
  sourceStorageId: string;
  targetStorageId: string;
  source: string;
  startedAt: number;
}

export interface PendingManualSync extends ManualSyncOperation {
  state: 'processing' | 'unknown';
}

export interface ManualSyncJournal {
  begin(operation: ManualSyncOperation): Promise<boolean>;
  settle(operation: ManualSyncOperation, outcome: 'known' | 'unknown'): Promise<void>;
  list(): Promise<PendingManualSync[]>;
  dismiss(operation: ManualSyncOperation): Promise<void>;
  history(): Promise<ManualSyncOperation[]>;
}
