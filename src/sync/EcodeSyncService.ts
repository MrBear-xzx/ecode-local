import * as fs from 'fs/promises';
import * as path from 'path';
import type * as vscode from 'vscode';
import {
  assertNoSymlinkSegments,
  assertNoCaseCollisions,
  normalizeRemotePath,
  resolveSafeLocalPath,
  resolveSafeSyncRoot,
} from '../domain/paths';
import { buildLocalChanges, buildSyncPlan } from '../domain/syncPlanner';
import { hashText, isSupportedText, serverFingerprint } from '../domain/text';
import type {
  ConnectionProfile,
  LocalFileState,
  ManifestEntry,
  RemoteFileContent,
  RemoteFileEntry,
  StoredConflict,
  SyncChange,
  SyncManifest,
  SyncOperationResult,
  SyncPlan,
} from '../domain/types';
import type { WorkspaceStore } from '../storage/WorkspaceStore';
import { EcodeCompiler } from './EcodeCompiler';
import { FileApi } from './api/FileApi';
import type { ApiResponse, TreeNode, TreePayload } from './api/types';
import type { AuthManager } from './auth/AuthManager';

interface CancellationLike {
  readonly isCancellationRequested: boolean;
}

interface RemoteScan {
  files: Map<string, RemoteFileContent>;
  presentPaths: Set<string>;
  presentDirectories: Set<string>;
  unsupported: SyncChange[];
  errors: string[];
}

interface RemoteDirectoryEntry {
  id: string;
  path: string;
  kind: 'type' | 'folder';
}

interface RemoteIndex {
  files: Map<string, RemoteFileEntry>;
  directories: Map<string, RemoteDirectoryEntry>;
  ambiguousDirectories: Set<string>;
}

interface RemoteTreeTask extends RemoteDirectoryEntry {}

interface RemoteFolderDeletion {
  directory: RemoteDirectoryEntry;
  filePaths: string[];
}

export class EcodeSyncService {
  private lastPlan: SyncPlan | undefined;
  private lastRemoteFiles = new Map<string, RemoteFileContent>();

  constructor(
    private readonly store: WorkspaceStore,
    private readonly auth: AuthManager,
    private readonly output: vscode.LogOutputChannel,
    private readonly compiler = new EcodeCompiler(),
  ) {}

  getLastPlan(): SyncPlan | undefined {
    return this.lastPlan;
  }

  async refreshLocalChanges(): Promise<SyncChange[]> {
    const context = await this.loadContext();
    const local = await this.scanLocalFiles(context.syncRoot);
    const changes = await this.mergeStoredConflicts(
      context.manifest,
      local.files,
      buildLocalChanges(context.manifest, local.files),
    );
    changes.push(...local.unsupported);
    this.lastPlan = {
      generatedAt: new Date().toISOString(),
      changes,
      executable: [],
      blocked: changes.filter(change =>
        change.status === 'localDeleted' || change.status === 'unsupported',
      ),
      warnings: [],
    };
    return changes;
  }

  async pull(
    onProgress: (message: string) => void,
    cancellation?: CancellationLike,
  ): Promise<SyncOperationResult> {
    const context = await this.loadContext();
    await fs.mkdir(context.syncRoot, { recursive: true });

    onProgress('正在验证连接...');
    const remote = await this.withAuthentication(context.profile, api =>
      this.scanRemote(api, onProgress, cancellation),
    );
    this.throwIfCancelled(cancellation);

    onProgress('正在扫描本地文件...');
    const local = await this.scanLocalFiles(context.syncRoot);
    onProgress('正在计算同步计划...');
    const plan = buildSyncPlan(
      context.manifest,
      local.files,
      remote.files,
      [...remote.unsupported, ...local.unsupported],
      remote.presentPaths,
    );
    const result = emptyResult();
    result.failed += remote.errors.length;
    result.errors.push(...remote.errors);
    const deletedLocalParents = new Set<string>();

    for (const item of plan.changes) {
      if (item.status === 'conflict') {
        result.conflicts++;
        const content = remote.files.get(item.path);
        if (content && item.conflictReason) {
          await this.store.saveConflict({
            path: item.path,
            remoteId: content.entry.id,
            remoteContent: content.content,
            remoteHash: content.hash,
            detectedAt: new Date().toISOString(),
            reason: item.conflictReason,
          });
        } else if (item.conflictReason === 'remoteDeletedLocalModified') {
          await this.saveRemoteDeletionConflict(context.manifest, item.path);
        }
      } else if (item.status === 'unsupported') {
        result.unsupported++;
      }
    }

    let applied = 0;
    for (const item of plan.executable) {
      this.throwIfCancelled(cancellation);
      applied++;
      onProgress(`正在应用远端变更 ${applied}/${plan.executable.length}: ${item.path}`);
      if (local.unsupported.some(change => change.path === item.path)) {
        continue;
      }
      try {
        const localPath = resolveSafeLocalPath(context.syncRoot, item.path);
        assertNoSymlinkSegments(context.syncRoot, localPath);
        if (item.status === 'remoteDeleted') {
          const baseline = context.manifest.files[item.path];
          if (!baseline) {
            continue;
          }
          const currentLocal = await this.readLocalFileIfExists(localPath, item.path);
          if (currentLocal && currentLocal.hash !== baseline.baselineHash) {
            await this.saveRemoteDeletionConflict(context.manifest, item.path);
            result.conflicts++;
            continue;
          }
          if (currentLocal) {
            const recovery = await this.store.saveRecovery(item.path, currentLocal.content);
            await fs.unlink(localPath);
            deletedLocalParents.add(path.posix.dirname(item.path));
            this.output.info(`Remote deletion applied: ${item.path}; recovery: ${recovery}`);
            result.deletedLocal++;
          }
          delete context.manifest.files[item.path];
          await this.store.deleteConflict(item.path);
          await this.store.saveManifest(context.manifest);
          continue;
        }

        const remoteFile = remote.files.get(item.path);
        if (!remoteFile) {
          continue;
        }
        const localFile = local.files.get(item.path);
        const currentLocal = await this.readLocalFileIfExists(localPath, item.path);
        if (currentLocal?.hash !== localFile?.hash) {
          const reason = localFile ? 'bothModified' : 'initialCollision';
          await this.store.saveConflict(toStoredConflict(remoteFile, reason));
          this.lastRemoteFiles.set(item.path, remoteFile);
          result.conflicts++;
          continue;
        }
        if (!currentLocal || currentLocal.hash !== remoteFile.hash) {
          await fs.mkdir(path.dirname(localPath), { recursive: true });
          await fs.writeFile(localPath, remoteFile.content, 'utf8');
        }
        await this.setBaseline(context.manifest, remoteFile);
        await this.store.saveManifest(context.manifest);
        result.pulled++;
      } catch (error: unknown) {
        result.failed++;
        result.errors.push(`${item.path}: ${errorMessage(error)}`);
      }
    }

    await this.pruneRemoteDeletedLocalDirectories(
      context.syncRoot,
      deletedLocalParents,
      remote.presentDirectories,
    );

    for (const [remotePath, remoteFile] of remote.files) {
      const change = plan.changes.find(item => item.path === remotePath);
      if (change?.status === 'clean') {
        const entry = context.manifest.files[remotePath];
        if (entry) {
          entry.remoteId = remoteFile.entry.id;
          entry.lastVerifiedAt = new Date().toISOString();
        }
      }
    }

    await this.store.saveManifest(context.manifest);
    this.lastRemoteFiles = remote.files;

    const refreshedLocal = await this.scanLocalFiles(context.syncRoot);
    this.lastPlan = buildSyncPlan(
      context.manifest,
      refreshedLocal.files,
      remote.files,
      [...remote.unsupported, ...refreshedLocal.unsupported],
      remote.presentPaths,
    );
    result.success = result.failed === 0;
    return result;
  }

  async pushSelected(
    selectedPaths: string[],
    onProgress: (message: string) => void,
    cancellation?: CancellationLike,
  ): Promise<SyncOperationResult> {
    const context = await this.loadContext();
    onProgress('正在扫描本地文件...');
    const local = await this.scanLocalFiles(context.syncRoot);
    const localChanges = new Map(
      buildLocalChanges(context.manifest, local.files).map(item => [item.path, item]),
    );
    const pushConflicts = new Map<string, SyncChange>();
    const result = emptyResult();
    let remoteIndex = await this.withAuthentication(context.profile, api =>
      this.listRemoteIndex(
        api,
        cancellation,
        message => onProgress(`准备推送：${message}`),
      ),
    );
    const folderDeletions = await this.findSelectedRemoteFolderDeletions(
      context.syncRoot,
      selectedPaths,
      localChanges,
      remoteIndex,
    );
    const folderDeletionByFile = new Map<string, RemoteFolderDeletion>();
    for (const deletion of folderDeletions) {
      for (const filePath of deletion.filePaths) {
        folderDeletionByFile.set(filePath, deletion);
      }
    }
    const handledFolderDeletions = new Set<string>();
    const handledDeletedFiles = new Set<string>();

    for (let selectedIndex = 0; selectedIndex < selectedPaths.length; selectedIndex++) {
      const remotePath = selectedPaths[selectedIndex];
      this.throwIfCancelled(cancellation);
      onProgress(`正在推送 ${selectedIndex + 1}/${selectedPaths.length}: ${remotePath}`);

      const change = localChanges.get(remotePath);
      const localFile = local.files.get(remotePath);
      if (
        !change
        || !['localAdded', 'localModified', 'localDeleted'].includes(change.status)
      ) {
        result.failed++;
        result.errors.push(`${remotePath}: 文件不再是可推送状态`);
        continue;
      }

      try {
        if (change.status === 'localDeleted') {
          if (handledDeletedFiles.has(remotePath)) {
            continue;
          }
          const folderDeletion = folderDeletionByFile.get(remotePath);
          if (
            folderDeletion
            && !handledFolderDeletions.has(folderDeletion.directory.path)
          ) {
            handledFolderDeletions.add(folderDeletion.directory.path);
            const folderDeleted = await this.withAuthentication(context.profile, api =>
              this.deleteRemoteFolderIfUnchanged(
                api,
                context.syncRoot,
                context.manifest,
                remoteIndex,
                folderDeletion,
              ),
            );
            if (folderDeleted) {
              for (const deletedPath of folderDeletion.filePaths) {
                handledDeletedFiles.add(deletedPath);
                delete context.manifest.files[deletedPath];
                await this.store.deleteConflict(deletedPath);
              }
              await this.store.saveManifest(context.manifest);
              result.deletedRemote += folderDeletion.filePaths.length;
              continue;
            }
          }
          await this.withAuthentication(context.profile, async api => {
            const baseline = context.manifest.files[remotePath];
            if (!baseline) {
              throw new Error('未找到本地删除对应的同步基线');
            }
            const localPath = resolveSafeLocalPath(context.syncRoot, remotePath);
            assertNoSymlinkSegments(context.syncRoot, localPath);
            if (await this.readLocalFileIfExists(localPath, remotePath)) {
              throw new Error('本地文件已重新出现，请刷新变更后重试');
            }

            const existing = remoteIndex.files.get(remotePath);
            if (existing) {
              if (existing.id !== baseline.remoteId) {
                await this.recordPushConflict(api, remotePath, existing, 'remotePathCollision');
                result.conflicts++;
                pushConflicts.set(remotePath, {
                  path: remotePath,
                  status: 'conflict',
                  remoteId: existing.id,
                  baselineHash: baseline.baselineHash,
                  conflictReason: 'remotePathCollision',
                  message: '远端同路径文件标识已变化',
                });
                return;
              }

              const latest = await this.readRemote(api, existing);
              if (latest.hash !== baseline.baselineHash) {
                await this.store.saveConflict(toStoredConflict(latest, 'localDeletedRemoteModified'));
                this.lastRemoteFiles.set(remotePath, latest);
                result.conflicts++;
                pushConflicts.set(remotePath, {
                  path: remotePath,
                  status: 'conflict',
                  remoteId: existing.id,
                  baselineHash: baseline.baselineHash,
                  remoteHash: latest.hash,
                  conflictReason: 'localDeletedRemoteModified',
                  message: '本地已删除，同时远端已修改',
                });
                return;
              }

              if (await this.readLocalFileIfExists(localPath, remotePath)) {
                throw new Error('本地文件在远端删除前重新出现，请刷新变更后重试');
              }
              const deletion = await api.deleteFile(existing.id);
              this.requireMutationSuccess(deletion, `删除远端文件失败: ${remotePath}`);
              const parentPath = path.posix.dirname(remotePath);
              const parent = remoteIndex.directories.get(parentPath);
              if (!parent) {
                throw new Error(`删除后无法验证远端父目录: ${parentPath}`);
              }
              const remaining = await this.findRemoteFileInDirectory(
                api,
                parent,
                path.posix.basename(remotePath),
                remotePath,
              );
              if (remaining) {
                throw new Error('删除后远端文件仍然存在');
              }
              remoteIndex.files.delete(remotePath);
            }

            delete context.manifest.files[remotePath];
            await this.store.deleteConflict(remotePath);
            await this.store.saveManifest(context.manifest);
            result.deletedRemote++;
          });
          continue;
        }

        if (!localFile) {
          throw new Error('本地文件不存在');
        }
        const compiledContent = this.compiler.compile(remotePath, localFile.content);
        await this.withAuthentication(context.profile, async api => {
          let existing = remoteIndex.files.get(remotePath);
          if (change.status === 'localAdded' && existing) {
            await this.recordPushConflict(api, remotePath, existing, 'initialCollision');
            result.conflicts++;
            pushConflicts.set(remotePath, {
              path: remotePath,
              status: 'conflict',
              remoteId: existing.id,
              localHash: localFile.hash,
              conflictReason: 'initialCollision',
              message: '远端已存在同路径文件',
            });
            return;
          }

          const baseline = context.manifest.files[remotePath];
          let uploadedEntry: RemoteFileEntry;
          if (change.status === 'localModified') {
            if (!existing || !baseline) {
              result.conflicts++;
              result.errors.push(`${remotePath}: 远端文件已删除`);
              pushConflicts.set(remotePath, {
                path: remotePath,
                status: 'conflict',
                remoteId: baseline?.remoteId,
                baselineHash: baseline?.baselineHash,
                localHash: localFile.hash,
                conflictReason: 'remoteDeletedLocalModified',
                message: '远端文件已删除，同时本地已修改',
              });
              return;
            }
            if (existing.id !== baseline.remoteId) {
              await this.recordPushConflict(api, remotePath, existing, 'remotePathCollision');
              result.conflicts++;
              pushConflicts.set(remotePath, {
                path: remotePath,
                status: 'conflict',
                remoteId: existing.id,
                baselineHash: baseline.baselineHash,
                localHash: localFile.hash,
                conflictReason: 'remotePathCollision',
                message: '远端同路径文件标识已变化',
              });
              return;
            }
            const latest = await this.readRemote(api, existing);
            if (latest.hash !== baseline.baselineHash) {
              await this.store.saveConflict(toStoredConflict(latest, 'bothModified'));
              this.lastRemoteFiles.set(remotePath, latest);
              result.conflicts++;
              pushConflicts.set(remotePath, {
                path: remotePath,
                status: 'conflict',
                remoteId: existing.id,
                baselineHash: baseline.baselineHash,
                localHash: localFile.hash,
                remoteHash: latest.hash,
                conflictReason: 'bothModified',
                message: '本地和远端均已修改',
              });
              return;
            }
            uploadedEntry = existing;
          } else {
            const parentPath = path.posix.dirname(remotePath);
            remoteIndex = await this.ensureRemoteDirectory(
              api,
              parentPath,
              remoteIndex,
              cancellation,
            );
            const parent = remoteIndex.directories.get(parentPath);
            if (!parent) {
              throw new Error(`远端父目录不存在: ${parentPath}`);
            }
            const extension = path.posix.extname(remotePath).slice(1);
            if (!extension) {
              throw new Error('Ecode 新增文件必须包含扩展名');
            }
            const name = path.posix.basename(remotePath, `.${extension}`);
            const fileName = path.posix.basename(remotePath);
            existing = await this.findRemoteFileInDirectory(
              api,
              parent,
              fileName,
              remotePath,
            );
            if (existing) {
              remoteIndex.files.set(remotePath, existing);
              await this.recordPushConflict(api, remotePath, existing, 'initialCollision');
              result.conflicts++;
              pushConflicts.set(remotePath, {
                path: remotePath,
                status: 'conflict',
                remoteId: existing.id,
                localHash: localFile.hash,
                conflictReason: 'initialCollision',
                message: '远端已存在同路径文件',
              });
              return;
            }

            const created = await api.addFile(parent.id, name, extension);
            this.requireMutationSuccess(created, `创建远端文件失败: ${remotePath}`);
            const createdEntry = await this.findRemoteFileInDirectory(
              api,
              parent,
              fileName,
              remotePath,
            );
            if (!createdEntry) {
              throw new Error('创建后无法在远端父目录中找到该文件');
            }
            remoteIndex.files.set(remotePath, createdEntry);
            uploadedEntry = createdEntry;
          }

          const localPath = resolveSafeLocalPath(context.syncRoot, remotePath);
          assertNoSymlinkSegments(context.syncRoot, localPath);
          const upload = await api.updateFile(
            uploadedEntry.id,
            localFile.content,
            compiledContent,
          );
          if (!upload.status) {
            if (isUnauthorized(upload.code)) {
              throw new SessionExpiredError(upload.msg || 'Session expired');
            }
            throw new Error(`上传失败: ${remotePath}${upload.msg ? `: ${upload.msg}` : ''}`);
          }

          const verified = await this.readRemote(api, uploadedEntry);
          if (verified.hash !== localFile.hash) {
            throw new Error('上传后远端内容校验不一致');
          }

          await this.setBaseline(context.manifest, verified);
          await this.store.saveManifest(context.manifest);
          this.lastRemoteFiles.set(remotePath, verified);
          remoteIndex.files.set(remotePath, uploadedEntry);
          result.pushed++;
        });
      } catch (error: unknown) {
        result.failed++;
        result.errors.push(`${remotePath}: ${errorMessage(error)}`);
      }
    }

    const refreshed = await this.scanLocalFiles(context.syncRoot);
    const changes = buildLocalChanges(context.manifest, refreshed.files)
      .filter(item => !pushConflicts.has(item.path));
    changes.push(...pushConflicts.values());
    this.lastPlan = {
      generatedAt: new Date().toISOString(),
      changes,
      executable: [],
      blocked: changes.filter(item =>
        item.status === 'localDeleted' || item.status === 'conflict',
      ),
      warnings: [],
    };
    result.success = result.failed === 0 && result.conflicts === 0;
    return result;
  }

  async getBaselineContent(remotePath: string): Promise<string> {
    const context = await this.loadContext();
    const entry = context.manifest.files[remotePath];
    return entry ? this.store.readSnapshot(entry.snapshotKey) : '';
  }

  async getLatestRemoteContent(remotePath: string): Promise<string> {
    const remembered = this.lastRemoteFiles.get(remotePath);
    if (remembered) {
      return remembered.content;
    }
    const conflict = await this.store.loadConflict(remotePath);
    return conflict?.remoteContent ?? '';
  }

  async acceptRemote(remotePath: string): Promise<string | undefined> {
    const context = await this.loadContext();
    const conflict = await this.requireCurrentConflict(context.profile, remotePath);
    const localPath = resolveSafeLocalPath(context.syncRoot, remotePath);
    assertNoSymlinkSegments(context.syncRoot, localPath);
    let recovery: string | undefined;
    try {
      const localContent = await fs.readFile(localPath, 'utf8');
      recovery = await this.store.saveRecovery(remotePath, localContent);
    } catch {
      // 本地文件不存在时无需备份
    }

    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, conflict.remoteContent, 'utf8');
    await this.setBaseline(context.manifest, {
      entry: {
        id: conflict.remoteId,
        path: remotePath,
        name: path.posix.basename(remotePath),
        kind: 'text',
      },
      content: conflict.remoteContent,
      hash: conflict.remoteHash,
    });
    await this.store.deleteConflict(remotePath);
    await this.store.saveManifest(context.manifest);
    await this.refreshLocalChanges();
    return recovery;
  }

  async markMerged(remotePath: string): Promise<void> {
    const context = await this.loadContext();
    const conflict = await this.requireCurrentConflict(context.profile, remotePath);
    const localPath = resolveSafeLocalPath(context.syncRoot, remotePath);
    await fs.access(localPath);
    await this.setBaseline(context.manifest, {
      entry: {
        id: conflict.remoteId,
        path: remotePath,
        name: path.posix.basename(remotePath),
        kind: 'text',
      },
      content: conflict.remoteContent,
      hash: conflict.remoteHash,
    });
    await this.store.deleteConflict(remotePath);
    await this.store.saveManifest(context.manifest);
    await this.refreshLocalChanges();
  }

  async revertLocalChange(remotePath: string): Promise<string | undefined> {
    const context = await this.loadContext();
    const local = await this.scanLocalFiles(context.syncRoot);
    const change = buildLocalChanges(context.manifest, local.files)
      .find(item => item.path === remotePath);
    if (!change || !['localAdded', 'localModified', 'localDeleted'].includes(change.status)) {
      throw new Error('该文件已不再是可回退的本地变更');
    }

    const localPath = resolveSafeLocalPath(context.syncRoot, remotePath);
    assertNoSymlinkSegments(context.syncRoot, localPath);
    const scannedLocal = local.files.get(remotePath);
    const currentLocal = await this.readLocalFileIfExists(localPath, remotePath);
    if (currentLocal?.hash !== scannedLocal?.hash) {
      throw new Error('本地文件在回退前再次变化，请刷新后重试');
    }

    let recovery: string | undefined;
    if (change.status === 'localAdded') {
      if (!currentLocal) {
        throw new Error('本地新增文件已不存在');
      }
      recovery = await this.store.saveRecovery(remotePath, currentLocal.content);
      await fs.unlink(localPath);
    } else {
      const baseline = context.manifest.files[remotePath];
      if (!baseline) {
        throw new Error('未找到可用于回退的同步基线');
      }
      const baselineContent = await this.store.readSnapshot(baseline.snapshotKey);
      if (hashText(baselineContent) !== baseline.baselineHash) {
        throw new Error('同步基线快照校验失败，已停止回退');
      }
      if (currentLocal) {
        recovery = await this.store.saveRecovery(remotePath, currentLocal.content);
      }
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, baselineContent, 'utf8');
    }

    await this.refreshLocalChanges();
    return recovery;
  }

  async acceptRemoteDeletion(remotePath: string): Promise<string | undefined> {
    const context = await this.loadContext();
    await this.requireRemoteDeletionConflict(context.profile, remotePath);
    const localPath = resolveSafeLocalPath(context.syncRoot, remotePath);
    assertNoSymlinkSegments(context.syncRoot, localPath);
    const currentLocal = await this.readLocalFileIfExists(localPath, remotePath);
    const recovery = currentLocal
      ? await this.store.saveRecovery(remotePath, currentLocal.content)
      : undefined;
    if (currentLocal) {
      await fs.unlink(localPath);
    }
    delete context.manifest.files[remotePath];
    await this.store.deleteConflict(remotePath);
    await this.store.saveManifest(context.manifest);
    await this.refreshLocalChanges();
    return recovery;
  }

  async keepLocalAfterRemoteDeletion(remotePath: string): Promise<void> {
    const context = await this.loadContext();
    await this.requireRemoteDeletionConflict(context.profile, remotePath);
    const localPath = resolveSafeLocalPath(context.syncRoot, remotePath);
    assertNoSymlinkSegments(context.syncRoot, localPath);
    if (!await this.readLocalFileIfExists(localPath, remotePath)) {
      throw new Error('本地文件已不存在，无法保留并重新创建远端文件');
    }
    delete context.manifest.files[remotePath];
    await this.store.deleteConflict(remotePath);
    await this.store.saveManifest(context.manifest);
    await this.refreshLocalChanges();
  }

  private async loadContext(): Promise<{
    profile: ConnectionProfile;
    syncRoot: string;
    manifest: SyncManifest;
  }> {
    const profile = await this.store.getProfile();
    if (!profile) {
      throw new Error('请先配置 Ecode 连接');
    }
    const syncRoot = resolveSafeSyncRoot(profile.workspaceFolder, profile.localDirectory);
    const fingerprint = serverFingerprint(profile.serverUrl, profile.username);
    const manifest = await this.store.loadManifest(fingerprint, syncRoot);
    return { profile, syncRoot, manifest };
  }

  private async scanRemote(
    api: FileApi,
    onProgress: (message: string) => void,
    cancellation?: CancellationLike,
  ): Promise<RemoteScan> {
    const index = await this.listRemoteIndex(api, cancellation, onProgress);
    const entries = index.files;
    const unsupported: SyncChange[] = [];
    const errors: string[] = [];
    const total = entries.size;
    let completed = 0;
    onProgress(`正在读取远端文件 0/${total}`);
    const contents = await mapConcurrent([...entries.values()], 4, async entry => {
      this.throwIfCancelled(cancellation);
      try {
        return await this.readRemote(api, entry);
      } catch (error: unknown) {
        if (error instanceof SessionExpiredError) {
          throw error;
        }
        if (error instanceof EcodeOperationError && error.code !== undefined) {
          errors.push(`${entry.path}: ${error.message}`);
          return undefined;
        }
        unsupported.push({
          path: entry.path,
          status: 'unsupported',
          remoteId: entry.id,
          message: errorMessage(error),
        });
        return undefined;
      } finally {
        completed++;
        onProgress(`正在读取远端文件 ${completed}/${total}: ${entry.path}`);
      }
    });

    return {
      files: new Map(
        contents
          .filter((item): item is RemoteFileContent => Boolean(item))
          .map(item => [item.entry.path, item]),
      ),
      presentPaths: new Set(entries.keys()),
      presentDirectories: new Set(index.directories.keys()),
      unsupported,
      errors,
    };
  }

  private async listRemoteIndex(
    api: FileApi,
    cancellation?: CancellationLike,
    onProgress?: (message: string) => void,
  ): Promise<RemoteIndex> {
    onProgress?.('正在读取远端文件树...');
    const rootResponse = await api.listTree();
    if (
      !rootResponse.status
      && rootResponse.code === undefined
      && !rootResponse.msg
    ) {
      throw new EcodeOperationError(
        '获取远端文件树失败：服务端返回 status=false，且未提供错误码或错误消息；'
        + '请重新配置连接并确认登录账号具有 Ecode 源码读取权限',
      );
    }
    const root = requireSuccess(rootResponse, '获取远端文件树失败');
    const entries: RemoteFileEntry[] = [];
    const directories: RemoteDirectoryEntry[] = [];
    let pending: RemoteTreeTask[] = [];
    const system = root.system;
    if (system?.id) {
      pending.push({
        id: system.id,
        path: normalizeRemotePath(system.name),
        kind: 'type',
      });
    }
    for (const type of root.typeList) {
      pending.push({
        id: type.id,
        path: normalizeRemotePath(type.name),
        kind: 'type',
      });
    }

    let completedDirectories = 0;
    while (pending.length > 0) {
      this.throwIfCancelled(cancellation);
      const level = pending;
      pending = [];
      const children = await mapConcurrent(level, 4, async task => {
        this.throwIfCancelled(cancellation);
        const payload = requireSuccess(
          await this.listDirectory(api, task),
          task.kind === 'type'
            ? `读取分类失败: ${task.path}`
            : `读取目录失败: ${task.path}`,
        );
        directories.push(task);
        this.collectFiles(payload.childFile, task.path, entries);
        completedDirectories++;
        onProgress?.(`正在扫描远端目录：已完成 ${completedDirectories} 个`);
        return [
          ...payload.childFolder.map(folder => ({
            id: folder.id,
            path: normalizeRemotePath(joinRemote(task.path, folder.name)),
            kind: 'folder' as const,
          })),
          ...payload.typeList.map(type => ({
            id: type.id,
            path: normalizeRemotePath(joinRemote(task.path, type.name)),
            kind: 'type' as const,
          })),
        ];
      });
      pending.push(...children.flat());
    }

    const filePaths = entries.map(item => item.path);
    assertNoCaseCollisions(filePaths);
    if (new Set(filePaths).size !== filePaths.length) {
      throw new Error('远端文件树包含重复文件路径');
    }
    const directoryMap = new Map<string, RemoteDirectoryEntry>();
    const ambiguousDirectories = new Set<string>();
    for (const directory of directories) {
      if (ambiguousDirectories.has(directory.path)) {
        continue;
      }
      const existing = directoryMap.get(directory.path);
      if (existing && (existing.id !== directory.id || existing.kind !== directory.kind)) {
        directoryMap.delete(directory.path);
        ambiguousDirectories.add(directory.path);
        continue;
      }
      directoryMap.set(directory.path, directory);
    }
    const allDirectoryPaths = new Set(directories.map(item => item.path));
    const uniquePaths = [...filePaths, ...allDirectoryPaths];
    assertNoCaseCollisions(uniquePaths);
    if (new Set(uniquePaths).size !== uniquePaths.length) {
      throw new Error('远端文件与目录路径冲突');
    }
    return {
      files: new Map(entries.map(item => [item.path, item])),
      directories: directoryMap,
      ambiguousDirectories,
    };
  }

  private collectFiles(nodes: TreeNode[], parentPath: string, entries: RemoteFileEntry[]): void {
    for (const node of nodes) {
      const remotePath = normalizeRemotePath(joinRemote(parentPath, node.name));
      entries.push({
        id: node.id,
        path: remotePath,
        name: node.name,
        kind: 'text',
      });
    }
  }

  private async ensureRemoteDirectory(
    api: FileApi,
    remotePath: string,
    initialIndex: RemoteIndex,
    cancellation?: CancellationLike,
  ): Promise<RemoteIndex> {
    const normalized = normalizeRemotePath(remotePath);
    const segments = normalized.split('/');
    const index = initialIndex;
    if (index.ambiguousDirectories.has(segments[0])) {
      throw new Error(`远端分类路径存在多个节点，无法安全新增: ${segments[0]}`);
    }
    if (!index.directories.has(segments[0])) {
      throw new Error(`远端分类不存在: ${segments[0]}`);
    }

    for (let length = 2; length <= segments.length; length++) {
      this.throwIfCancelled(cancellation);
      const targetPath = segments.slice(0, length).join('/');
      if (index.ambiguousDirectories.has(targetPath)) {
        throw new Error(`远端目录路径存在多个节点，无法安全新增: ${targetPath}`);
      }
      if (index.directories.has(targetPath)) {
        continue;
      }
      const parentPath = segments.slice(0, length - 1).join('/');
      if (index.ambiguousDirectories.has(parentPath)) {
        throw new Error(`远端父目录路径存在多个节点，无法安全新增: ${parentPath}`);
      }
      const parent = index.directories.get(parentPath);
      if (!parent) {
        throw new Error(`远端父目录不存在: ${parentPath}`);
      }
      const folderName = segments[length - 1];
      let matches = await this.findRemoteFoldersInDirectory(api, parent, folderName);
      if (matches.length > 1) {
        index.ambiguousDirectories.add(targetPath);
        throw new Error(`远端目录路径存在多个节点，无法安全新增: ${targetPath}`);
      }
      if (matches.length === 1) {
        index.directories.set(targetPath, {
          id: matches[0].id,
          path: targetPath,
          kind: 'folder',
        });
        continue;
      }
      const created = await api.addFolder(
        folderName,
        parent.kind === 'type' ? { typeId: parent.id } : { parentId: parent.id },
      );
      this.requireMutationSuccess(created, `创建远端目录失败: ${targetPath}`);
      matches = await this.findRemoteFoldersInDirectory(api, parent, folderName);
      if (matches.length !== 1) {
        if (matches.length > 1) {
          index.ambiguousDirectories.add(targetPath);
        }
        throw new Error(
          matches.length > 1
            ? `创建后远端目录出现重名节点: ${targetPath}`
            : `创建后无法在远端父目录中找到目录: ${targetPath}`,
        );
      }
      index.directories.set(targetPath, {
        id: matches[0].id,
        path: targetPath,
        kind: 'folder',
      });
    }
    return index;
  }

  private async findSelectedRemoteFolderDeletions(
    syncRoot: string,
    selectedPaths: string[],
    localChanges: Map<string, SyncChange>,
    remoteIndex: RemoteIndex,
  ): Promise<RemoteFolderDeletion[]> {
    const selectedDeleted = new Set(
      selectedPaths.filter(remotePath =>
        localChanges.get(remotePath)?.status === 'localDeleted',
      ),
    );
    const candidates = [...remoteIndex.directories.values()]
      .filter(directory => directory.kind === 'folder')
      .sort((left, right) =>
        left.path.split('/').length - right.path.split('/').length,
      );
    const deletions: RemoteFolderDeletion[] = [];

    for (const directory of candidates) {
      if (deletions.some(item => isDescendantPath(directory.path, item.directory.path))) {
        continue;
      }
      const filePaths = [...remoteIndex.files.keys()].filter(remotePath =>
        isDescendantPath(remotePath, directory.path),
      );
      if (
        filePaths.length === 0
        || filePaths.some(remotePath => !selectedDeleted.has(remotePath))
      ) {
        continue;
      }
      const localPath = resolveSafeLocalPath(syncRoot, directory.path);
      assertNoSymlinkSegments(syncRoot, localPath);
      if (!await this.isLocalPathMissing(localPath)) {
        continue;
      }
      deletions.push({ directory, filePaths });
    }
    return deletions;
  }

  private async deleteRemoteFolderIfUnchanged(
    api: FileApi,
    syncRoot: string,
    manifest: SyncManifest,
    remoteIndex: RemoteIndex,
    deletion: RemoteFolderDeletion,
  ): Promise<boolean> {
    for (const remotePath of deletion.filePaths) {
      const baseline = manifest.files[remotePath];
      const existing = remoteIndex.files.get(remotePath);
      if (!baseline || !existing || existing.id !== baseline.remoteId) {
        return false;
      }
      const latest = await this.readRemote(api, existing);
      if (latest.hash !== baseline.baselineHash) {
        return false;
      }
    }

    const localPath = resolveSafeLocalPath(syncRoot, deletion.directory.path);
    assertNoSymlinkSegments(syncRoot, localPath);
    if (!await this.isLocalPathMissing(localPath)) {
      return false;
    }

    const response = await api.deleteFolder(deletion.directory.id);
    this.requireMutationSuccess(
      response,
      `删除远端目录失败: ${deletion.directory.path}`,
    );
    const parentPath = path.posix.dirname(deletion.directory.path);
    const parent = remoteIndex.directories.get(parentPath);
    if (!parent) {
      throw new Error(`删除后无法验证远端父目录: ${parentPath}`);
    }
    const remaining = await this.findRemoteFoldersInDirectory(
      api,
      parent,
      path.posix.basename(deletion.directory.path),
    );
    if (remaining.length > 0) {
      throw new Error(`删除后远端目录仍然存在: ${deletion.directory.path}`);
    }

    for (const remotePath of deletion.filePaths) {
      remoteIndex.files.delete(remotePath);
    }
    for (const remotePath of [...remoteIndex.directories.keys()]) {
      if (
        remotePath === deletion.directory.path
        || isDescendantPath(remotePath, deletion.directory.path)
      ) {
        remoteIndex.directories.delete(remotePath);
      }
    }
    return true;
  }

  private async isLocalPathMissing(localPath: string): Promise<boolean> {
    try {
      await fs.lstat(localPath);
      return false;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return true;
      }
      throw error;
    }
  }

  private listDirectory(
    api: FileApi,
    directory: RemoteDirectoryEntry,
  ): Promise<ApiResponse<TreePayload>> {
    return directory.kind === 'type'
      ? api.listTree('', directory.id)
      : api.listTree(directory.id);
  }

  private async findRemoteFoldersInDirectory(
    api: FileApi,
    parent: RemoteDirectoryEntry,
    folderName: string,
  ): Promise<TreeNode[]> {
    const payload = requireSuccess(
      await this.listDirectory(api, parent),
      `读取远端父目录失败: ${parent.path}`,
    );
    return payload.childFolder.filter(folder => folder.name === folderName);
  }

  private async findRemoteFileInDirectory(
    api: FileApi,
    parent: RemoteDirectoryEntry,
    fileName: string,
    remotePath: string,
  ): Promise<RemoteFileEntry | undefined> {
    const payload = requireSuccess(
      await this.listDirectory(api, parent),
      `读取远端父目录失败: ${parent.path}`,
    );
    const matches = payload.childFile.filter(file => file.name === fileName);
    if (matches.length > 1) {
      throw new Error(`远端父目录包含多个同名文件: ${remotePath}`);
    }
    return matches[0]
      ? {
          id: matches[0].id,
          path: remotePath,
          name: matches[0].name,
          kind: 'text',
        }
      : undefined;
  }

  private requireMutationSuccess(response: ApiResponse<unknown>, prefix: string): void {
    if (response.status) {
      return;
    }
    if (isUnauthorized(response.code)) {
      throw new SessionExpiredError(response.msg || 'Session expired');
    }
    throw new Error(`${prefix}${response.msg ? `: ${response.msg}` : ''}`);
  }

  private async readRemote(api: FileApi, entry: RemoteFileEntry): Promise<RemoteFileContent> {
    const response = await api.viewFile(entry.id);
    const content = requireSuccess(response, `读取远端文件失败: ${entry.path}`);
    if (!isSupportedText(content)) {
      throw new Error('当前版本不支持二进制或非 UTF-8 文件');
    }
    return { entry, content, hash: hashText(content) };
  }

  private async pruneRemoteDeletedLocalDirectories(
    syncRoot: string,
    parentPaths: Set<string>,
    presentDirectories: Set<string>,
  ): Promise<void> {
    const candidates = [...parentPaths].sort((left, right) =>
      right.split('/').length - left.split('/').length,
    );
    for (const initialPath of candidates) {
      let remotePath = initialPath;
      while (remotePath !== '.' && !presentDirectories.has(remotePath)) {
        const localPath = resolveSafeLocalPath(syncRoot, remotePath);
        assertNoSymlinkSegments(syncRoot, localPath);
        try {
          await fs.rmdir(localPath);
        } catch (error: unknown) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') {
            throw error;
          }
          if (code !== 'ENOENT') {
            break;
          }
        }
        remotePath = path.posix.dirname(remotePath);
      }
    }
  }

  private async scanLocalFiles(syncRoot: string): Promise<{
    files: Map<string, LocalFileState>;
    unsupported: SyncChange[];
  }> {
    const files = new Map<string, LocalFileState>();
    const unsupported: SyncChange[] = [];
    try {
      await fs.access(syncRoot);
    } catch {
      return { files, unsupported };
    }

    const walk = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(syncRoot, absolute).split(path.sep).join('/');
        if (entry.isSymbolicLink()) {
          unsupported.push({
            path: relative,
            status: 'unsupported',
            message: '不跟随符号链接',
          });
        } else if (entry.isDirectory()) {
          await walk(absolute);
        } else if (entry.isFile()) {
          const buffer = await fs.readFile(absolute);
          let content: string;
          try {
            content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
          } catch {
            unsupported.push({
              path: relative,
              status: 'unsupported',
              message: '当前版本仅支持 UTF-8 文本',
            });
            continue;
          }
          if (!isSupportedText(content)) {
            unsupported.push({
              path: relative,
              status: 'unsupported',
              message: '当前版本不支持二进制文件',
            });
            continue;
          }
          files.set(relative, { path: relative, content, hash: hashText(content) });
        }
      }
    };
    await walk(syncRoot);
    assertNoCaseCollisions(files.keys());
    return { files, unsupported };
  }

  private async readLocalFileIfExists(
    localPath: string,
    remotePath: string,
  ): Promise<LocalFileState | undefined> {
    try {
      const stat = await fs.lstat(localPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`同步路径包含符号链接: ${localPath}`);
      }
      const buffer = await fs.readFile(localPath);
      const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      if (!isSupportedText(content)) {
        throw new Error(`当前版本不支持非文本本地文件: ${remotePath}`);
      }
      return { path: remotePath, content, hash: hashText(content) };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  private async setBaseline(manifest: SyncManifest, remote: RemoteFileContent): Promise<void> {
    const snapshotKey = await this.store.saveSnapshot(remote.content);
    const entry: ManifestEntry = {
      remoteId: remote.entry.id,
      path: remote.entry.path,
      kind: 'text',
      baselineHash: remote.hash,
      snapshotKey,
      lastVerifiedAt: new Date().toISOString(),
    };
    manifest.files[remote.entry.path] = entry;
  }

  private async recordPushConflict(
    api: FileApi,
    remotePath: string,
    entry: RemoteFileEntry,
    reason: StoredConflict['reason'],
  ): Promise<void> {
    const latest = await this.readRemote(api, entry);
    await this.store.saveConflict(toStoredConflict(latest, reason));
    this.lastRemoteFiles.set(remotePath, latest);
    this.output.warn(`Push blocked by conflict: ${remotePath}`);
  }

  private async saveRemoteDeletionConflict(
    manifest: SyncManifest,
    remotePath: string,
  ): Promise<void> {
    const baseline = manifest.files[remotePath];
    if (!baseline) {
      return;
    }
    await this.store.saveConflict({
      path: remotePath,
      remoteId: baseline.remoteId,
      remoteContent: '',
      remoteHash: '',
      detectedAt: new Date().toISOString(),
      reason: 'remoteDeletedLocalModified',
      remoteDeleted: true,
    });
  }

  private async mergeStoredConflicts(
    manifest: SyncManifest,
    localFiles: Map<string, LocalFileState>,
    changes: SyncChange[],
  ): Promise<SyncChange[]> {
    const merged = new Map(changes.map(change => [change.path, change]));
    for (const conflict of await this.store.listConflicts()) {
      const baseline = manifest.files[conflict.path];
      const local = localFiles.get(conflict.path);
      if (conflict.remoteDeleted) {
        if (baseline && local && local.hash !== baseline.baselineHash) {
          merged.set(conflict.path, {
            path: conflict.path,
            status: 'conflict',
            remoteId: conflict.remoteId,
            baselineHash: baseline.baselineHash,
            localHash: local.hash,
            conflictReason: 'remoteDeletedLocalModified',
            message: conflictMessage('remoteDeletedLocalModified'),
          });
        } else {
          await this.store.deleteConflict(conflict.path);
        }
        continue;
      }
      if (baseline?.baselineHash === conflict.remoteHash) {
        continue;
      }
      if (!local || !baseline || local.hash !== baseline.baselineHash) {
        merged.set(conflict.path, {
          path: conflict.path,
          status: 'conflict',
          remoteId: conflict.remoteId,
          baselineHash: baseline?.baselineHash,
          localHash: local?.hash,
          remoteHash: conflict.remoteHash,
          conflictReason: conflict.reason,
          message: conflictMessage(conflict.reason),
        });
        this.lastRemoteFiles.set(conflict.path, {
          entry: {
            id: conflict.remoteId,
            path: conflict.path,
            name: path.posix.basename(conflict.path),
            kind: 'text',
          },
          content: conflict.remoteContent,
          hash: conflict.remoteHash,
        });
      }
    }
    return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  private async requireCurrentConflict(
    profile: ConnectionProfile,
    remotePath: string,
  ): Promise<StoredConflict> {
    const stored = await this.store.loadConflict(remotePath);
    if (!stored) {
      throw new Error('未找到可处理的冲突记录，请先重新拉取');
    }
    if (stored.remoteDeleted) {
      throw new Error('该冲突表示远端文件已删除，请选择删除冲突处理方式');
    }
    const latest = await this.withAuthentication(profile, async api => {
      const entry: RemoteFileEntry = {
        id: stored.remoteId,
        path: remotePath,
        name: path.posix.basename(remotePath),
        kind: 'text',
      };
      return this.readRemote(api, entry);
    });
    if (latest.hash !== stored.remoteHash) {
      const refreshed = toStoredConflict(latest, stored.reason);
      await this.store.saveConflict(refreshed);
      throw new Error('远端在冲突处理期间再次变化，请重新查看差异');
    }
    return stored;
  }

  private async requireRemoteDeletionConflict(
    profile: ConnectionProfile,
    remotePath: string,
  ): Promise<StoredConflict> {
    const stored = await this.store.loadConflict(remotePath);
    if (
      !stored
      || !stored.remoteDeleted
      || stored.reason !== 'remoteDeletedLocalModified'
    ) {
      throw new Error('未找到远端删除冲突记录，请先重新拉取');
    }
    const existing = await this.withAuthentication(profile, async api =>
      (await this.listRemoteIndex(api)).files.get(remotePath),
    );
    if (existing) {
      throw new Error('远端文件已重新出现，请重新拉取并检查差异');
    }
    return stored;
  }

  private async withAuthentication<T>(
    profile: ConnectionProfile,
    operation: (api: FileApi) => Promise<T>,
  ): Promise<T> {
    let client = await this.auth.getAuthenticatedClient(profile);
    if (!client) {
      throw new Error('登录已失效，请重新配置连接');
    }
    try {
      return await operation(new FileApi(client));
    } catch (error: unknown) {
      if (!(error instanceof SessionExpiredError)) {
        throw error;
      }
      client = await this.auth.reconnect(profile);
      if (!client) {
        throw new Error('会话已过期且重新登录失败');
      }
      return operation(new FileApi(client));
    }
  }

  private throwIfCancelled(cancellation?: CancellationLike): void {
    if (cancellation?.isCancellationRequested) {
      throw new SyncCancelledError();
    }
  }
}

export class SyncCancelledError extends Error {
  constructor() {
    super('同步操作已取消');
    this.name = 'SyncCancelledError';
  }
}

class SessionExpiredError extends Error {}

class EcodeOperationError extends Error {
  constructor(message: string, readonly code?: number | string) {
    super(message);
  }
}

function requireSuccess<T>(response: ApiResponse<T>, prefix: string): T {
  if (!response.status || response.data === undefined) {
    if (isUnauthorized(response.code)) {
      throw new SessionExpiredError(response.msg || 'Session expired');
    }
    const detail = response.msg
      ?? (response.code !== undefined ? `错误码 ${response.code}` : undefined);
    throw new EcodeOperationError(
      `${prefix}${detail ? `: ${detail}` : ''}`,
      response.code,
    );
  }
  return response.data;
}

function isUnauthorized(code: number | string | undefined): boolean {
  return code === 401
    || code === '401'
    || code === '002'
    || code === '005'
    || code === '1001'
    || code === '1002';
}

function joinRemote(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function isDescendantPath(remotePath: string, directoryPath: string): boolean {
  return remotePath.startsWith(`${directoryPath}/`);
}

function toStoredConflict(
  remote: RemoteFileContent,
  reason: StoredConflict['reason'],
): StoredConflict {
  return {
    path: remote.entry.path,
    remoteId: remote.entry.id,
    remoteContent: remote.content,
    remoteHash: remote.hash,
    detectedAt: new Date().toISOString(),
    reason,
  };
}

function emptyResult(): SyncOperationResult {
  return {
    success: true,
    pulled: 0,
    pushed: 0,
    deletedLocal: 0,
    deletedRemote: 0,
    conflicts: 0,
    unsupported: 0,
    failed: 0,
    errors: [],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function conflictMessage(reason: StoredConflict['reason']): string {
  const messages: Record<StoredConflict['reason'], string> = {
    initialCollision: '首次同步时本地与远端内容不同',
    bothModified: '本地和远端均已修改',
    localDeletedRemoteModified: '本地已删除，同时远端已修改',
    remoteDeletedLocalModified: '远端已删除，同时本地已修改',
    remotePathCollision: '远端路径存在冲突',
  };
  return messages[reason];
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) {
        return;
      }
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
