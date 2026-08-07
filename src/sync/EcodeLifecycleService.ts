import * as path from 'path';
import {
  normalizeRemotePath,
  resolveEnvironmentSourceRoot,
} from '../domain/paths';
import { normalizePreStateOrder } from '../domain/lifecycle';
import { serverFingerprint } from '../domain/text';
import type { ConnectionProfile } from '../domain/types';
import type { WorkspaceStore } from '../storage/WorkspaceStore';
import { FileApi } from './api/FileApi';
import {
  LifecycleApi,
  type EcodeSystemInfo,
  type ReleaseRecord,
} from './api/LifecycleApi';
import type { ApiResponse, TreeNode, TreePayload } from './api/types';
import type { AuthManager } from './auth/AuthManager';
import {
  EcodeOperationError,
  SessionExpiredError,
  isUnauthorized,
  requireSuccess,
} from './EcodeErrors';

export type PreloadState = 'preloaded' | 'postloaded' | 'normal' | 'unknown';

interface LifecycleCapabilities {
  systemInfo: boolean;
  releaseList: boolean;
}

interface LifecycleCategory {
  id: string;
  path: string;
  appId?: string;
  preStateOrder?: string;
}

export interface LifecycleFile {
  id: string;
  path: string;
  fileType: string;
  preloadState: PreloadState;
  canPreload: boolean;
}

export interface LifecycleFolder {
  id: string;
  path: string;
  appId?: string;
  rootFolder: boolean;
  released?: boolean;
  preStateOrder?: string;
}

export interface LifecycleSnapshot {
  systemInfo?: EcodeSystemInfo;
  capabilities: LifecycleCapabilities;
  categories: LifecycleCategory[];
  files: LifecycleFile[];
  folders: LifecycleFolder[];
}

interface VerifiedLifecycleResult {
  verified?: boolean;
}

interface PathLifecycleResult extends VerifiedLifecycleResult {
  path: string;
  enabled: boolean;
}

interface PreStateOrderResult extends VerifiedLifecycleResult {
  path: string;
  preStateOrder: string;
}

interface TreeTask {
  id: string;
  path: string;
  kind: 'type' | 'folder';
  node: TreeNode;
}

interface LifecycleLogger {
  info(message: string): void;
  warn(message: string): void;
}

interface StoredLifecycleSnapshot {
  schemaVersion: 2;
  serverFingerprint: string;
  syncRoot: string;
  updatedAt: string;
  snapshot: LifecycleSnapshot;
}

interface CachedLifecycleSnapshot {
  updatedAt: string;
  snapshot: LifecycleSnapshot;
}

interface LifecycleScanResult {
  tree: Pick<LifecycleSnapshot, 'categories' | 'files' | 'folders'>;
  directoryRequests: number;
}

interface LifecycleReadDiagnostics {
  systemInfoMs: number;
  releaseListMs: number;
  treeMs: number;
  directoryRequests: number;
}

const LIFECYCLE_TREE_CONCURRENCY = 4;

export class EcodeLifecycleService {
  constructor(
    private readonly store: WorkspaceStore,
    private readonly auth: AuthManager,
    private readonly logger?: LifecycleLogger,
  ) {}

  async getSnapshot(): Promise<LifecycleSnapshot> {
    const startedAt = Date.now();
    const profile = await this.requireProfile();
    const result = await this.withAuthentication(profile, async (files, lifecycle) => {
      const [systemInfo, releases, scanned] = await Promise.all([
        timed(optionalRead(lifecycle.getSystemInfo())),
        timed(optionalRead(lifecycle.listReleases())),
        timed(this.scanTree(files)),
      ]);
      applyReleaseState(
        scanned.value.tree.folders,
        releases.value.data ?? [],
        releases.value.supported,
      );
      return {
        snapshot: {
          systemInfo: systemInfo.value.data,
          capabilities: {
            systemInfo: systemInfo.value.supported,
            releaseList: releases.value.supported,
          },
          ...scanned.value.tree,
        },
        diagnostics: {
          systemInfoMs: systemInfo.durationMs,
          releaseListMs: releases.durationMs,
          treeMs: scanned.durationMs,
          directoryRequests: scanned.value.directoryRequests,
        } satisfies LifecycleReadDiagnostics,
      };
    });
    await this.saveCachedSnapshot(profile, result.snapshot);
    this.logSnapshotRefresh(result.snapshot, result.diagnostics, Date.now() - startedAt);
    return result.snapshot;
  }

  async getCachedSnapshot(): Promise<CachedLifecycleSnapshot | undefined> {
    const profile = await this.requireProfile();
    const syncRoot = resolveEnvironmentSourceRoot(
      profile.workspaceFolder,
      profile.environmentDirectory,
    );
    let value: unknown;
    try {
      value = await this.store.loadLifecycleSnapshotCache(syncRoot);
    } catch (error: unknown) {
      this.logger?.warn(errorMessage(error));
      return undefined;
    }
    const cached = parseStoredLifecycleSnapshot(
      value,
      serverFingerprint(profile.serverUrl, profile.username),
      syncRoot,
    );
    if (!cached) {
      if (value !== undefined) {
        this.logger?.warn('Lifecycle snapshot cache is invalid or belongs to another connection');
      }
      return undefined;
    }
    this.logger?.info(
      `Lifecycle snapshot cache loaded: updatedAt=${cached.updatedAt}, `
      + `categories=${cached.snapshot.categories.length}, `
      + `folders=${cached.snapshot.folders.length}, files=${cached.snapshot.files.length}`,
    );
    return {
      updatedAt: cached.updatedAt,
      snapshot: cached.snapshot,
    };
  }

  async setFilePreloaded(fileId: string, enabled: boolean): Promise<VerifiedLifecycleResult> {
    const profile = await this.requireProfile();
    await this.withAuthentication(profile, async (_files, lifecycle) => {
      ensureSuccess(
        await lifecycle.markFile(fileId, enabled ? 'pre-state' : ''),
        enabled ? '设置前置加载失败' : '取消前置加载失败',
      );
    });
    const refreshed = await this.getSnapshot();
    const file = refreshed.files.find(item => item.id === fileId);
    return {
      verified: file && file.preloadState !== 'unknown'
        ? file.preloadState === (enabled ? 'preloaded' : 'normal')
        : undefined,
    };
  }

  async setFilePreloadedByPath(
    remotePath: string,
    enabled: boolean,
  ): Promise<PathLifecycleResult> {
    const target = requireLifecyclePath(
      (await this.getSnapshot()).files,
      normalizeRemotePath(remotePath),
      '前置加载文件',
    );
    if (!target.canPreload) {
      throw new Error(`文件不支持前置加载: ${target.path}`);
    }
    const requestedState = enabled ? 'preloaded' : 'normal';
    if (target.preloadState === requestedState) {
      return {
        path: target.path,
        enabled,
        verified: true,
      };
    }
    const requiredState = enabled ? 'normal' : 'preloaded';
    if (target.preloadState !== requiredState) {
      throw new Error(
        `文件当前前置状态为 ${target.preloadState}，不能直接切换: ${target.path}`,
      );
    }
    return {
      path: target.path,
      enabled,
      ...await this.setFilePreloaded(target.id, enabled),
    };
  }

  async setPreStateOrder(
    folderId: string,
    order: string,
  ): Promise<VerifiedLifecycleResult> {
    const preStateOrder = normalizePreStateOrder(order);
    const profile = await this.requireProfile();
    await this.withAuthentication(profile, async (_files, lifecycle) => {
      ensureSuccess(
        await lifecycle.setPreStateOrder(folderId, preStateOrder),
        '设置前置加载顺序失败',
      );
    });
    const refreshed = await this.getSnapshot();
    const folder = refreshed.folders.find(item => item.id === folderId);
    return {
      verified: folder?.preStateOrder !== undefined
        ? samePreStateOrder(folder.preStateOrder, preStateOrder)
        : undefined,
    };
  }

  async setPreStateOrderByPath(
    remotePath: string,
    order: string,
  ): Promise<PreStateOrderResult> {
    const target = requireLifecyclePath(
      (await this.getSnapshot()).folders,
      normalizeRemotePath(remotePath),
      '前置加载顺序文件夹',
    );
    if (!target.rootFolder) {
      throw new Error(`仅分类下的根文件夹支持设置前置加载顺序: ${target.path}`);
    }
    const preStateOrder = normalizePreStateOrder(order);
    return {
      path: target.path,
      preStateOrder,
      ...await this.setPreStateOrder(target.id, preStateOrder),
    };
  }

  async publishFolder(
    folderId: string,
    appId?: string,
  ): Promise<VerifiedLifecycleResult> {
    return this.setFolderReleaseState(folderId, true, appId);
  }

  async unpublishFolder(
    folderId: string,
    appId?: string,
  ): Promise<VerifiedLifecycleResult> {
    return this.setFolderReleaseState(folderId, false, appId);
  }

  private async setFolderReleaseState(
    folderId: string,
    expected: boolean,
    appId?: string,
  ): Promise<VerifiedLifecycleResult> {
    const profile = await this.requireProfile();
    try {
      await this.withAuthentication(profile, async (_files, lifecycle) => {
        ensureSuccess(
          await (expected
            ? lifecycle.publishFolder(folderId)
            : lifecycle.unpublishFolder(folderId)),
          expected ? '发布文件夹失败' : '取消发布失败',
        );
      });
    } catch (error: unknown) {
      if (!(error instanceof EcodeOperationError)) {
        throw error;
      }
      const reconciled = await this.verifyReleaseState(folderId, expected, appId);
      if (reconciled.verified === true) {
        return reconciled;
      }
      throw error;
    }
    return this.verifyReleaseState(folderId, expected, appId);
  }

  async setFolderReleasedByPath(
    remotePath: string,
    enabled: boolean,
  ): Promise<PathLifecycleResult> {
    const target = requireLifecyclePath(
      (await this.getSnapshot()).folders,
      normalizeRemotePath(remotePath),
      '发布文件夹',
    );
    if (!target.rootFolder) {
      throw new Error(`仅支持发布分类下的根文件夹: ${target.path}`);
    }
    return {
      path: target.path,
      enabled,
      ...await (enabled
        ? this.publishFolder(target.id, target.appId)
        : this.unpublishFolder(target.id, target.appId)),
    };
  }

  private async verifyReleaseState(
    folderId: string,
    expected: boolean,
    appId?: string,
  ): Promise<VerifiedLifecycleResult> {
    const profile = await this.requireProfile();
    return this.withAuthentication(profile, async (_files, lifecycle) => {
      const releases = await optionalRead(lifecycle.listReleases());
      if (!releases.supported || releases.data === undefined) {
        return { verified: undefined };
      }
      return {
        verified: releases.data.some(item =>
          releaseMatchesFolder(item.folderId, folderId, appId)) === expected,
      };
    });
  }

  private async scanTree(
    api: FileApi,
  ): Promise<LifecycleScanResult> {
    const root = requireSuccess(await api.listTree(), '读取远端文件树失败');
    const categories: LifecycleCategory[] = [];
    const files: LifecycleFile[] = [];
    const folders: LifecycleFolder[] = [];
    let directoryRequests = 1;
    let pending: TreeTask[] = [];
    if (root.system) {
      const remotePath = normalizeLifecycleNodePath(
        root.system.name,
        '分类',
        this.logger,
      );
      if (remotePath) {
        pending.push(treeTask(root.system, remotePath, 'type'));
      }
    }
    for (const type of root.typeList) {
      const remotePath = normalizeLifecycleNodePath(type.name, '分类', this.logger);
      if (remotePath) {
        pending.push(treeTask(type, remotePath, 'type'));
      }
    }

    const visited = new Set<string>();
    while (pending.length > 0) {
      const level: TreeTask[] = [];
      for (const task of pending) {
        const key = `${task.kind}:${task.id}`;
        if (visited.has(key)) {
          continue;
        }
        visited.add(key);
        level.push(task);
        if (task.kind === 'type') {
          categories.push({
            id: task.id,
            path: task.path,
            appId: task.node.appId,
            preStateOrder: task.node.preStateOrder,
          });
        }
      }
      pending = [];
      if (level.length === 0) {
        continue;
      }
      directoryRequests += level.length;
      const payloads = await mapConcurrent(
        level,
        LIFECYCLE_TREE_CONCURRENCY,
        async task => ({
          task,
          payload: requireSuccess(
            await listTask(api, task),
            `读取远端目录失败: ${task.path}`,
          ),
        }),
      );
      for (const { task, payload } of payloads) {
        collectFiles(payload, task.path, files, this.logger);
        for (const folder of payload.childFolder) {
          const folderPath = normalizeLifecycleNodePath(
            joinRemote(task.path, folder.name),
            '文件夹',
            this.logger,
          );
          if (!folderPath) {
            continue;
          }
          folders.push({
            id: folder.id,
            path: folderPath,
            appId: folder.appId,
            rootFolder: folder.isRootFolder ?? task.kind === 'type',
            released: folder.released,
            preStateOrder: folder.preStateOrder,
          });
          pending.push(treeTask(folder, folderPath, 'folder'));
        }
        for (const type of payload.typeList) {
          const typePath = normalizeLifecycleNodePath(
            joinRemote(task.path, type.name),
            '分类',
            this.logger,
          );
          if (typePath) {
            pending.push(treeTask(type, typePath, 'type'));
          }
        }
      }
    }

    return {
      tree: {
        categories: uniqueById(categories).sort(comparePath),
        files: uniqueById(files).sort(comparePath),
        folders: uniqueById(folders).sort(comparePath),
      },
      directoryRequests,
    };
  }

  private async saveCachedSnapshot(
    profile: ConnectionProfile,
    snapshot: LifecycleSnapshot,
  ): Promise<void> {
    try {
      const syncRoot = resolveEnvironmentSourceRoot(
        profile.workspaceFolder,
        profile.environmentDirectory,
      );
      const cache: StoredLifecycleSnapshot = {
        schemaVersion: 2,
        serverFingerprint: serverFingerprint(profile.serverUrl, profile.username),
        syncRoot,
        updatedAt: new Date().toISOString(),
        snapshot,
      };
      await this.store.saveLifecycleSnapshotCache(syncRoot, cache);
    } catch (error: unknown) {
      this.logger?.warn(`Unable to save lifecycle snapshot cache: ${errorMessage(error)}`);
    }
  }

  private logSnapshotRefresh(
    snapshot: LifecycleSnapshot,
    diagnostics: LifecycleReadDiagnostics,
    totalMs: number,
  ): void {
    const phases = `tree=${diagnostics.treeMs}ms/${diagnostics.directoryRequests} requests, `
      + `releaseList=${diagnostics.releaseListMs}ms, systemInfo=${diagnostics.systemInfoMs}ms`;
    this.logger?.info(
      `Lifecycle snapshot refreshed in ${totalMs}ms: ${phases}; `
      + `categories=${snapshot.categories.length}, folders=${snapshot.folders.length}, `
      + `files=${snapshot.files.length}`,
    );
  }

  private async requireProfile(): Promise<ConnectionProfile> {
    const profile = await this.store.getProfile();
    if (!profile) {
      throw new Error('请先配置 Ecode 连接');
    }
    return profile;
  }

  private async withAuthentication<T>(
    profile: ConnectionProfile,
    operation: (files: FileApi, lifecycle: LifecycleApi) => Promise<T>,
  ): Promise<T> {
    let client = await this.auth.getAuthenticatedClient(profile);
    if (!client) {
      throw new Error('登录已失效，请重新配置连接');
    }
    try {
      return await operation(new FileApi(client), new LifecycleApi(client));
    } catch (error: unknown) {
      if (!(error instanceof SessionExpiredError)) {
        throw error;
      }
      client = await this.auth.reconnect(profile);
      if (!client) {
        throw new Error('会话已过期且重新登录失败');
      }
      return operation(new FileApi(client), new LifecycleApi(client));
    }
  }
}

async function optionalRead<T>(
  operation: Promise<ApiResponse<T>>,
): Promise<{ supported: boolean; data?: T }> {
  const response = await operation;
  if (response.status) {
    return { supported: true, data: response.data };
  }
  if (isUnauthorized(response.code)) {
    throw new SessionExpiredError(response.msg ?? 'Session expired');
  }
  return { supported: false };
}

function ensureSuccess(response: ApiResponse<unknown>, prefix: string): void {
  if (response.status) {
    return;
  }
  if (isUnauthorized(response.code)) {
    throw new SessionExpiredError(response.msg ?? 'Session expired');
  }
  const detail = response.msg
    ?? (response.code !== undefined ? `错误码 ${response.code}` : undefined);
  throw new EcodeOperationError(`${prefix}${detail ? `: ${detail}` : ''}`, response.code);
}

function listTask(api: FileApi, task: TreeTask): Promise<ApiResponse<TreePayload>> {
  return task.kind === 'type'
    ? api.listTree('', task.id)
    : api.listTree(task.id);
}

function treeTask(node: TreeNode, remotePath: string, kind: TreeTask['kind']): TreeTask {
  return { id: node.id, path: remotePath, kind, node };
}

function collectFiles(
  payload: TreePayload,
  parentPath: string,
  target: LifecycleFile[],
  logger?: LifecycleLogger,
): void {
  for (const node of payload.childFile) {
    const remotePath = normalizeLifecycleNodePath(
      joinRemote(parentPath, node.name),
      '文件',
      logger,
    );
    if (!remotePath) {
      continue;
    }
    const extension = normalizeFileType(node.fileType)
      ?? path.posix.extname(node.name).slice(1).toLowerCase();
    const canPreload = extension === 'js' || extension === 'css';
    target.push({
      id: node.id,
      path: remotePath,
      fileType: extension,
      preloadState: canPreload && !node.preloadState?.trim()
        ? 'normal'
        : normalizePreloadState(node.preloadState),
      canPreload,
    });
  }
}

function normalizeFileType(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^\./, '').toLowerCase();
  return normalized && /^[a-z][a-z0-9_-]{0,31}$/.test(normalized)
    ? normalized
    : undefined;
}

function normalizePreloadState(value: string | undefined): PreloadState {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return 'unknown';
  }
  if (normalized === 'pre-state' || normalized === 'prestate') {
    return 'preloaded';
  }
  if (normalized === 'post-state' || normalized === 'poststate') {
    return 'postloaded';
  }
  if (normalized === 'none' || normalized === 'normal' || normalized === '0') {
    return 'normal';
  }
  return 'unknown';
}

function joinRemote(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function normalizeLifecycleNodePath(
  candidate: string,
  kind: '分类' | '文件夹' | '文件',
  logger?: LifecycleLogger,
): string | undefined {
  try {
    return normalizeRemotePath(candidate);
  } catch (error: unknown) {
    logger?.warn(
      `远端${kind}名称无法安全映射到本地，已忽略: ${candidate || '(空名称)'}; `
      + errorMessage(error),
    );
    return undefined;
  }
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map(item => [item.id, item])).values()];
}

function comparePath(left: { path: string }, right: { path: string }): number {
  return left.path.localeCompare(right.path);
}

function samePreStateOrder(left: string, right: string): boolean {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return Number.isFinite(leftNumber)
    && Number.isFinite(rightNumber)
    && leftNumber === rightNumber;
}

function releaseMatchesFolder(
  releaseId: string,
  folderId: string,
  appId?: string,
): boolean {
  return releaseId === folderId || (appId !== undefined && releaseId === appId);
}

function releaseMatchesFolderSet(
  releaseIds: Set<string>,
  folder: { id: string; appId?: string },
): boolean {
  return releaseIds.has(folder.id)
    || (folder.appId !== undefined && releaseIds.has(folder.appId));
}

function applyReleaseState(
  folders: LifecycleFolder[],
  releases: ReleaseRecord[],
  releaseListSupported: boolean,
): void {
  if (!releaseListSupported) {
    return;
  }
  const releaseIds = new Set(releases.map(item => item.folderId));
  for (const folder of folders) {
    folder.released = releaseMatchesFolderSet(releaseIds, folder)
      || folder.released === true;
  }
}

async function timed<T>(
  operation: Promise<T>,
): Promise<{ value: T; durationMs: number }> {
  const startedAt = Date.now();
  const value = await operation;
  return { value, durationMs: Date.now() - startedAt };
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= values.length) {
          return;
        }
        results[index] = await mapper(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function parseStoredLifecycleSnapshot(
  value: unknown,
  expectedServerFingerprint: string,
  expectedSyncRoot: string,
): StoredLifecycleSnapshot | undefined {
  const record = asRecord(value);
  if (
    record.schemaVersion !== 2
    || record.serverFingerprint !== expectedServerFingerprint
    || typeof record.syncRoot !== 'string'
    || path.resolve(record.syncRoot) !== path.resolve(expectedSyncRoot)
    || typeof record.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(record.updatedAt))
    || !isLifecycleSnapshot(record.snapshot)
  ) {
    return undefined;
  }
  return record as unknown as StoredLifecycleSnapshot;
}

function isLifecycleSnapshot(value: unknown): value is LifecycleSnapshot {
  const record = asRecord(value);
  const capabilities = asRecord(record.capabilities);
  return (
    typeof capabilities.systemInfo === 'boolean'
    && typeof capabilities.releaseList === 'boolean'
    && isOptionalSystemInfo(record.systemInfo)
    && Array.isArray(record.categories)
    && record.categories.every(isLifecycleCategory)
    && Array.isArray(record.files)
    && record.files.every(isLifecycleFile)
    && Array.isArray(record.folders)
    && record.folders.every(isLifecycleFolder)
  );
}

function isOptionalSystemInfo(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  const record = asRecord(value);
  return optionalString(record.version) && optionalString(record.build);
}

function isLifecycleCategory(value: unknown): boolean {
  const record = asRecord(value);
  return requiredString(record.id)
    && isSafeRemotePath(record.path)
    && optionalString(record.appId)
    && optionalString(record.preStateOrder);
}

function isLifecycleFile(value: unknown): boolean {
  const record = asRecord(value);
  return requiredString(record.id)
    && isSafeRemotePath(record.path)
    && typeof record.fileType === 'string'
    && ['preloaded', 'postloaded', 'normal', 'unknown'].includes(
      String(record.preloadState),
    )
    && typeof record.canPreload === 'boolean';
}

function isLifecycleFolder(value: unknown): boolean {
  const record = asRecord(value);
  return requiredString(record.id)
    && isSafeRemotePath(record.path)
    && optionalString(record.appId)
    && typeof record.rootFolder === 'boolean'
    && optionalBoolean(record.released)
    && optionalString(record.preStateOrder);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

function isSafeRemotePath(value: unknown): boolean {
  if (!requiredString(value)) {
    return false;
  }
  try {
    return normalizeRemotePath(value as string) === value;
  } catch {
    return false;
  }
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function requireLifecyclePath<T extends { path: string }>(
  items: T[],
  requestedPath: string,
  targetLabel: string,
): T {
  const key = lifecyclePathKey(requestedPath);
  const matches = items.filter(item => lifecyclePathKey(item.path) === key);
  if (matches.length === 0) {
    throw new Error(`找不到${targetLabel}: ${requestedPath}`);
  }
  if (matches.length > 1) {
    throw new Error(`${targetLabel}路径不唯一，无法安全操作: ${requestedPath}`);
  }
  return matches[0];
}

function lifecyclePathKey(value: string): string {
  return value.toLocaleLowerCase('en-US');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
