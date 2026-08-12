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
  kind: FileKind | 'unsupported';
  route?: string;
  parentId?: string;
  reason?: string;
}

export type FileKind = 'text' | 'resource';

export interface RemoteTreeNode {
  id: string;
  name: string;
  path: string;
  treeType?: string;
  businessType?: string;
  attribute?: string;
  parentId?: string;
  appId?: string;
  initialAppId?: string;
  route?: string;
  status?: string;
  state?: string;
  preStateOrder?: string;
  debugMode?: 'y' | 'n';
  hasChild?: boolean;
  children: RemoteTreeNode[];
}

export interface RemoteTreeSnapshot {
  schemaVersion: 1;
  serverFingerprint: string;
  syncRoot: string;
  capturedAt: string;
  roots: RemoteTreeNode[];
}

export interface EcodeAppMetadata {
  appId: string;
  nodeId: string;
  path: string;
  status: string;
  preStateOrder: string;
  preloadFiles: string[];
  resourceRoots: string[];
  resources: string[];
  configs: string[];
  debugMode: 'y' | 'n';
}

export interface AppMetadataSnapshot {
  schemaVersion: 1;
  serverFingerprint: string;
  syncRoot: string;
  capturedAt: string;
  apps: EcodeAppMetadata[];
}

interface RemoteFileContentBase {
  entry: RemoteFileEntry;
  hash: string;
  size: number;
  formMetadataState: FormMetadataState;
  formContexts: FormContext[];
  formMetadataWarnings: string[];
}

export interface RemoteTextFileContent extends RemoteFileContentBase {
  entry: RemoteFileEntry & { kind: 'text' };
  content: string;
}

export interface RemoteResourceFileContent extends RemoteFileContentBase {
  entry: RemoteFileEntry & { kind: 'resource' };
  sourcePath: string;
  stagingRoot: string;
}

export type RemoteFileContent =
  | RemoteTextFileContent
  | RemoteResourceFileContent;

export interface ManifestEntry {
  remoteId: string;
  path: string;
  kind: FileKind;
  size: number;
  baselineHash: string;
  snapshotKey: string;
  lastVerifiedAt: string;
}

export interface SyncManifest {
  schemaVersion: 1 | 2;
  serverFingerprint: string;
  syncRoot: string;
  updatedAt: string;
  files: Record<string, ManifestEntry>;
}

interface LocalFileStateBase {
  path: string;
  hash: string;
  size: number;
}

export interface LocalTextFileState extends LocalFileStateBase {
  kind: 'text';
  content: string;
}

export interface LocalResourceFileState extends LocalFileStateBase {
  kind: 'resource';
  sourcePath: string;
}

export type LocalFileState = LocalTextFileState | LocalResourceFileState;

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
  kind?: FileKind;
  remoteId?: string;
  baselineHash?: string;
  localHash?: string;
  remoteHash?: string;
  localSize?: number;
  remoteSize?: number;
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
  schemaVersion?: 1 | 2;
  path: string;
  remoteId: string;
  kind?: FileKind;
  remoteContent?: string;
  remoteSnapshotKey?: string;
  remoteSize?: number;
  remoteHash: string;
  detectedAt: string;
  reason: ConflictReason;
  remoteDeleted?: boolean;
}

export type PromotionOperation = 'add' | 'modify' | 'delete';

export interface PromotionCandidate {
  path: string;
  operation: PromotionOperation;
  kind?: FileKind;
  size?: number;
  baseHash?: string;
  baseContent?: string;
  baseResourcePath?: string;
  resultHash?: string;
  resultContent?: string;
  resultResourcePath?: string;
}

export interface ChangeSetFile {
  path: string;
  operation: PromotionOperation;
  kind?: FileKind;
  size?: number;
  baseHash?: string;
  baseSnapshotKey?: string;
  resultHash?: string;
  resultSnapshotKey?: string;
  verifiedAt: string;
}

export interface FilePreloadLifecycleChange {
  kind: 'filePreload';
  path: string;
  before: boolean;
  after: boolean;
  verifiedAt: string;
}

export interface FolderReleaseLifecycleChange {
  kind: 'folderRelease';
  path: string;
  before: boolean;
  after: boolean;
  verifiedAt: string;
}

export interface PreloadOrderLifecycleChange {
  kind: 'preloadOrder';
  path: string;
  before: string;
  after: string;
  verifiedAt: string;
}

export type LifecycleChange =
  | FilePreloadLifecycleChange
  | FolderReleaseLifecycleChange
  | PreloadOrderLifecycleChange;

export interface LifecycleChangeRecord {
  schemaVersion: 1;
  id: string;
  environmentId: string;
  createdAt: string;
  change: LifecycleChange;
}

export interface ChangeSet {
  schemaVersion: 1 | 2 | 3;
  id: string;
  name: string;
  sourceEnvironmentId: string;
  createdAt: string;
  updatedAt: string;
  files: Record<string, ChangeSetFile>;
  lifecycleChanges?: Record<string, LifecycleChange>;
}

export interface PushRecord {
  schemaVersion: 1 | 2;
  id: string;
  name: string;
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

export type DeploymentLifecycleStatus =
  | 'succeeded'
  | 'failed'
  | 'skipped';

export interface DeploymentLifecycleResult {
  kind: LifecycleChange['kind'];
  path: string;
  status: DeploymentLifecycleStatus;
  changed?: boolean;
  previous?: boolean | string;
  message?: string;
}

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
  schemaVersion: 1 | 2;
  id: string;
  changeSetId: string;
  targetEnvironmentId: string;
  startedAt: string;
  completedAt: string;
  status: 'succeeded' | 'partial' | 'conflict' | 'failed';
  files: DeploymentFileResult[];
  lifecycle?: DeploymentLifecycleResult[];
}

export interface ReleaseArtifact {
  path: string;
  operation: PromotionOperation;
  kind?: FileKind;
  size?: number;
  baseHash?: string;
  resultHash?: string;
  resultContent?: string;
  resultResourcePath?: string;
}

export interface ReleaseVerification {
  success: boolean;
  files: DeploymentFileResult[];
}
