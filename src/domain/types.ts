import type {
  FormContext,
  FormMetadataState,
} from './formMetadata';

export interface ConnectionProfile {
  version: 4;
  environmentId: string;
  environmentDirectory: string;
  workspaceFolder: string;
  serverUrl: string;
  username: string;
}

export interface EnvironmentProfile {
  version: 2;
  id: string;
  name: string;
  directory: string;
  workspaceFolder: string;
  serverUrl: string;
  username: string;
}

export interface StoredEnvironmentProfile {
  version: 2;
  id: string;
  name: string;
  directory: string;
  serverUrl: string;
  username: string;
}

export interface EnvironmentConfiguration {
  schemaVersion: 2;
  activeEnvironmentId: string;
  environments: StoredEnvironmentProfile[];
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
  formMetadataState: FormMetadataState;
  formContexts: FormContext[];
  formMetadataWarnings: string[];
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
  deletedLocal: number;
  deletedRemote: number;
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
  remoteDeleted?: boolean;
}

export type PromotionOperation = 'add' | 'modify' | 'delete';

export interface PromotionCandidate {
  path: string;
  operation: PromotionOperation;
  baseHash?: string;
  baseContent?: string;
  resultHash?: string;
  resultContent?: string;
}

export interface ChangeSetFile {
  path: string;
  operation: PromotionOperation;
  baseHash?: string;
  baseSnapshotKey?: string;
  resultHash?: string;
  resultSnapshotKey?: string;
  verifiedAt: string;
}

export interface ChangeSet {
  schemaVersion: 1;
  id: string;
  name: string;
  sourceEnvironmentId: string;
  createdAt: string;
  updatedAt: string;
  files: Record<string, ChangeSetFile>;
}

export interface PushRecord {
  schemaVersion: 1;
  id: string;
  environmentId: string;
  createdAt: string;
  status: 'succeeded' | 'partial';
  requestedPaths: string[];
  files: ChangeSetFile[];
}

export type DeploymentFileStatus =
  | 'pending'
  | 'succeeded'
  | 'conflict'
  | 'failed';

export interface DeploymentFileResult {
  path: string;
  operation: PromotionOperation;
  status: DeploymentFileStatus;
  expectedHash?: string;
  actualHash?: string;
  message?: string;
  recoveryPath?: string;
}

export interface DeploymentRecord {
  schemaVersion: 1;
  id: string;
  changeSetId: string;
  targetEnvironmentId: string;
  startedAt: string;
  completedAt: string;
  status: 'succeeded' | 'partial' | 'conflict' | 'failed';
  files: DeploymentFileResult[];
}

export interface ReleaseArtifact {
  path: string;
  operation: PromotionOperation;
  baseHash?: string;
  resultHash?: string;
  resultContent?: string;
}

export interface ReleaseVerification {
  success: boolean;
  files: DeploymentFileResult[];
}
