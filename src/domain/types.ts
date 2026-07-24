export interface ConnectionProfile {
  version: 2;
  workspaceFolder: string;
  serverUrl: string;
  username: string;
  localDirectory: string;
}

export interface RemoteFileEntry {
  id: string;
  path: string;
  name: string;
  kind: 'text' | 'unsupported';
  reason?: string;
}

export interface RemoteFileContent {
  entry: RemoteFileEntry;
  content: string;
  hash: string;
}

export interface ManifestEntry {
  remoteId: string;
  path: string;
  kind: 'text';
  baselineHash: string;
  snapshotKey: string;
  lastVerifiedAt: string;
}

export interface SyncManifest {
  schemaVersion: 1;
  serverFingerprint: string;
  syncRoot: string;
  updatedAt: string;
  files: Record<string, ManifestEntry>;
}

export interface LocalFileState {
  path: string;
  content: string;
  hash: string;
}

export type SyncChangeStatus =
  | 'clean'
  | 'localAdded'
  | 'localModified'
  | 'localDeleted'
  | 'remoteAdded'
  | 'remoteModified'
  | 'remoteDeleted'
  | 'conflict'
  | 'unsupported';

export type ConflictReason =
  | 'initialCollision'
  | 'bothModified'
  | 'localDeletedRemoteModified'
  | 'remoteDeletedLocalModified'
  | 'remotePathCollision';

export interface SyncChange {
  path: string;
  status: SyncChangeStatus;
  remoteId?: string;
  baselineHash?: string;
  localHash?: string;
  remoteHash?: string;
  conflictReason?: ConflictReason;
  message?: string;
}

export interface SyncPlan {
  generatedAt: string;
  changes: SyncChange[];
  executable: SyncChange[];
  blocked: SyncChange[];
  warnings: string[];
}

export interface SyncOperationResult {
  success: boolean;
  pulled: number;
  pushed: number;
  conflicts: number;
  unsupported: number;
  failed: number;
  errors: string[];
}

export interface StoredConflict {
  path: string;
  remoteId: string;
  remoteContent: string;
  remoteHash: string;
  detectedAt: string;
  reason: ConflictReason;
}
