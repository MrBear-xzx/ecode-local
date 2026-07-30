import * as fs from 'fs/promises';
import * as path from 'path';
import type * as vscode from 'vscode';
import {
  assertNoSymlinkSegments,
  assertNoCaseCollisions,
  normalizeRemotePath,
  resolveSafeLocalPath,
  resolveEnvironmentSourceRoot,
} from '../domain/paths';
import { analyzeFormContexts } from '../domain/formContextAnalyzer';
import type { FormContext, FormMetadataCache } from '../domain/formMetadata';
import {
  findGbkIncompatibleCharacters,
  formatUnicodeCodePoint,
} from '../domain/gbk';
import { buildLocalChanges, buildSyncPlan } from '../domain/syncPlanner';
import { hashText, isSupportedText, serverFingerprint } from '../domain/text';
import type {
  ConnectionProfile,
  DeploymentFileResult,
  LocalFileState,
  ManifestEntry,
  PromotionCandidate,
  ReleaseArtifact,
  ReleaseVerification,
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
  pathCollisions: SyncChange[];
}

interface RemoteTreeTask extends RemoteDirectoryEntry {}

interface RemoteFolderDeletion {
  directory: RemoteDirectoryEntry;
  filePaths: string[];
}

const REMOTE_VERIFICATION_RETRY_DELAYS_MS = [250, 750, 1500];

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

  getCompilerVersion(): string {
    return this.compiler.getVersion();
  }

  async hasSyncBaseline(profile?: ConnectionProfile): Promise<boolean> {
    return isManifestInitialized((await this.loadContext(profile)).manifest);
  }

  async preparePromotionCandidates(
    selectedPaths: string[],
  ): Promise<PromotionCandidate[]> {
    const context = await this.loadContext();
    if (!isManifestInitialized(context.manifest)) {
      throw new Error('当前环境尚未建立同步基线，请先执行全量拉取');
    }
    const local = await this.scanLocalFiles(context.syncRoot);
    const changes = new Map(
      buildLocalChanges(context.manifest, local.files).map(change => [change.path, change]),
    );
    const candidates: PromotionCandidate[] = [];
    for (const remotePath of selectedPaths) {
      const change = changes.get(remotePath);
      if (!change || !['localAdded', 'localModified', 'localDeleted'].includes(change.status)) {
        throw new Error(`${remotePath}: 文件不再是可记录的本地变更`);
      }
      const baseline = context.manifest.files[remotePath];
      const localFile = local.files.get(remotePath);
      candidates.push({
        path: remotePath,
        operation: change.status === 'localAdded'
          ? 'add'
          : change.status === 'localDeleted' ? 'delete' : 'modify',
        baseHash: baseline?.baselineHash,
        baseContent: baseline
          ? await this.store.readSnapshot(baseline.snapshotKey)
          : undefined,
        resultHash: localFile?.hash,
        resultContent: localFile?.content,
      });
    }
    this.assertGbkCompatibleSources(candidates.flatMap(candidate =>
      candidate.resultContent === undefined
        ? []
        : [{ path: candidate.path, content: candidate.resultContent }]));
    return candidates;
  }

  async filterVerifiedPromotionCandidates(
    candidates: PromotionCandidate[],
  ): Promise<PromotionCandidate[]> {
    const context = await this.loadContext();
    return candidates.filter(candidate => {
      const baseline = context.manifest.files[candidate.path];
      return candidate.operation === 'delete'
        ? baseline === undefined
        : baseline?.baselineHash === candidate.resultHash;
    });
  }

  async rollbackPushLocally(
    candidates: PromotionCandidate[],
  ): Promise<string[]> {
    const context = await this.loadContext();
    if (!isManifestInitialized(context.manifest)) {
      throw new Error('当前环境尚未建立同步基线');
    }
    const local = await this.scanLocalFiles(context.syncRoot);
    const conflicts: string[] = [];
    for (const candidate of candidates) {
      const current = local.files.get(candidate.path);
      const localPath = resolveSafeLocalPath(context.syncRoot, candidate.path);
      assertNoSymlinkSegments(context.syncRoot, localPath);
      if (candidate.operation === 'delete') {
        if (current) {
          conflicts.push(`${candidate.path}: 推送后本地文件应不存在，但当前已存在`);
        } else {
          try {
            await fs.lstat(localPath);
            conflicts.push(`${candidate.path}: 推送后路径应不存在，但当前已被占用`);
          } catch (error: unknown) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT') {
              conflicts.push(`${candidate.path}: 无法确认当前本地路径状态`);
            }
          }
        }
      } else if (!current || current.hash !== candidate.resultHash) {
        conflicts.push(`${candidate.path}: 本地内容已不是该次推送后的版本`);
      }
      if (
        candidate.operation !== 'add'
        && (!candidate.baseHash || candidate.baseContent === undefined)
      ) {
        conflicts.push(`${candidate.path}: 推送记录缺少修改前源码快照`);
      }
      if (
        candidate.baseContent !== undefined
        && candidate.baseHash !== hashText(candidate.baseContent)
      ) {
        conflicts.push(`${candidate.path}: 推送前源码快照 Hash 不一致`);
      }
    }
    if (conflicts.length > 0) {
      throw new Error(
        `本地回退预检未通过，未修改任何文件：\n${conflicts.join('\n')}`,
      );
    }

    const recoveryPaths: string[] = [];
    for (const candidate of candidates) {
      const current = local.files.get(candidate.path);
      if (current) {
        recoveryPaths.push(
          await this.store.saveRecovery(candidate.path, current.content),
        );
      }
    }
    for (const candidate of candidates) {
      const localPath = resolveSafeLocalPath(context.syncRoot, candidate.path);
      if (candidate.operation === 'add') {
        await fs.unlink(localPath);
        await removeEmptyParents(path.dirname(localPath), context.syncRoot);
      } else {
        await fs.mkdir(path.dirname(localPath), { recursive: true });
        await fs.writeFile(localPath, candidate.baseContent!, 'utf8');
      }
    }

    await this.refreshLocalChanges();
    return recoveryPaths;
  }

  async verifyRelease(
    profile: ConnectionProfile,
    artifacts: ReleaseArtifact[],
  ): Promise<ReleaseVerification> {
    this.validateReleaseArtifacts(artifacts);
    const remoteIndex = await this.withAuthentication(profile, api =>
      this.listRemoteIndex(api));
    let files = await this.withAuthentication(profile, async api =>
      mapConcurrent(artifacts, 4, async artifact =>
        this.verifyReleaseArtifact(api, remoteIndex, artifact)));
    const context = await this.loadContext(profile);
    if (!isManifestInitialized(context.manifest)) {
      files = artifacts.map(artifact => promotionConflict(
        artifact,
        undefined,
        '目标环境尚未建立同步基线，请先切换到该环境并执行全量拉取',
      ));
    } else {
      const local = await this.scanLocalFiles(context.syncRoot);
      files = artifacts.map((artifact, index) =>
        this.verifyTargetLocalArtifact(
          local,
          artifact,
          files[index],
        ));
    }
    return {
      success: files.every(file =>
        file.status === 'pending' || file.status === 'succeeded'),
      files,
    };
  }

  async deployRelease(
    profile: ConnectionProfile,
    artifacts: ReleaseArtifact[],
    onProgress: (message: string) => void,
    cancellation?: CancellationLike,
  ): Promise<DeploymentFileResult[]> {
    const preflight = await this.verifyRelease(profile, artifacts);
    if (!preflight.success) {
      return preflight.files;
    }
    const context = await this.loadContext(profile);
    let remoteIndex = await this.withAuthentication(profile, api =>
      this.listRemoteIndex(api));
    const preflightByPath = new Map(preflight.files.map(file => [file.path, file]));
    const results: DeploymentFileResult[] = [];

    for (let index = 0; index < artifacts.length; index++) {
      const artifact = artifacts[index];
      const preflightResult = preflightByPath.get(artifact.path);
      if (
        preflightResult?.status !== 'succeeded'
        && cancellation?.isCancellationRequested
      ) {
        results.push(promotionFailed(artifact, '操作已取消'));
        continue;
      }
      onProgress(`正在应用 ${index + 1}/${artifacts.length}: ${artifact.path}`);
      try {
        const result = await this.withAuthentication(profile, async api => {
          const check = await this.verifyReleaseArtifact(
            api,
            remoteIndex,
            artifact,
          );
          if (check.status !== 'pending' && check.status !== 'succeeded') {
            return check;
          }
          const existing = remoteIndex.files.get(artifact.path);
          const latestLocal = await this.scanLocalFiles(context.syncRoot);
          const localCheck = this.verifyTargetLocalArtifact(
            latestLocal,
            artifact,
            check,
          );
          if (
            localCheck.status !== 'pending'
            && localCheck.status !== 'succeeded'
          ) {
            return localCheck;
          }
          const localFile = [...latestLocal.files.values()].find(file =>
            remotePathKey(file.path) === remotePathKey(artifact.path));
          let recoveryPath: string | undefined;
          let remoteRecoveryHash: string | undefined;
          if (check.status === 'pending' && existing) {
            const current = await this.readRemote(api, existing);
            remoteRecoveryHash = current.hash;
            recoveryPath = await this.store.saveRecovery(
              artifact.path,
              current.content,
            );
          }
          await this.preserveReleaseArtifactLocal(
            context.syncRoot,
            artifact,
            localFile,
            remoteRecoveryHash,
          );
          if (check.status === 'succeeded') {
            if (artifact.operation === 'delete') {
              await this.reconcileReleaseArtifactLocal(
                context.syncRoot,
                artifact,
                localFile?.hash,
              );
              delete context.manifest.files[artifact.path];
            } else {
              if (!existing) {
                return promotionConflict(
                  artifact,
                  undefined,
                  '目标环境远端文件在应用期间消失',
                );
              }
              const verified = await this.readRemote(api, existing);
              if (verified.hash !== artifact.resultHash) {
                return promotionConflict(
                  artifact,
                  verified.hash,
                  '目标环境远端文件在应用期间发生变化',
                );
              }
              await this.reconcileReleaseArtifactLocal(
                context.syncRoot,
                artifact,
                localFile?.hash,
              );
              await this.setBaseline(context.manifest, verified);
            }
            await this.store.deleteConflict(artifact.path);
            await this.store.saveManifest(context.manifest);
            return promotionSucceeded(artifact);
          }

          if (artifact.operation === 'delete') {
            if (!existing) {
              return promotionConflict(
                artifact,
                undefined,
                '目标环境文件已经不存在',
              );
            }
            const deletion = await api.deleteFile(existing.id);
            this.requireMutationSuccess(deletion, `删除远端文件失败: ${artifact.path}`);
            const parent = remoteIndex.directories.get(path.posix.dirname(artifact.path));
            if (!parent) {
              throw new Error(`删除后无法验证远端父目录: ${artifact.path}`);
            }
            const remaining = await this.findRemoteFileInDirectory(
              api,
              parent,
              path.posix.basename(artifact.path),
              artifact.path,
            );
            if (remaining) {
              throw new Error('删除后远端文件仍然存在');
            }
            remoteIndex.files.delete(artifact.path);
            await this.reconcileReleaseArtifactLocal(
              context.syncRoot,
              artifact,
              localFile?.hash,
            );
            delete context.manifest.files[artifact.path];
            await this.store.deleteConflict(artifact.path);
            await this.store.saveManifest(context.manifest);
            return promotionSucceeded(artifact, recoveryPath);
          }

          if (
            artifact.resultContent === undefined
            || artifact.resultHash === undefined
          ) {
            throw new Error('冻结快照缺少目标源码');
          }
          let uploadedEntry = existing;
          if (!uploadedEntry) {
            const parentPath = path.posix.dirname(artifact.path);
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
            const extension = path.posix.extname(artifact.path).slice(1);
            if (!extension) {
              throw new Error('Ecode 新增文件必须包含扩展名');
            }
            const created = await api.addFile(
              parent.id,
              path.posix.basename(artifact.path, `.${extension}`),
              extension,
            );
            this.requireMutationSuccess(created, `创建远端文件失败: ${artifact.path}`);
            uploadedEntry = await this.findRemoteFileInDirectory(
              api,
              parent,
              path.posix.basename(artifact.path),
              artifact.path,
            );
            if (!uploadedEntry) {
              throw new Error('创建后无法在远端父目录中找到该文件');
            }
            remoteIndex.files.set(artifact.path, uploadedEntry);
          }
          if (!uploadedEntry) {
            return promotionConflict(
              artifact,
              undefined,
              '目标环境文件已经不存在',
            );
          }
          const compiledContent = this.compiler.compile(
            artifact.path,
            artifact.resultContent,
          );
          const upload = await api.updateFile(
            uploadedEntry.id,
            artifact.resultContent,
            compiledContent,
          );
          const verified = await this.verifyUploadResult(
            api,
            uploadedEntry,
            artifact.resultHash,
            upload,
            artifact.path,
            cancellation,
          );
          await this.reconcileReleaseArtifactLocal(
            context.syncRoot,
            artifact,
            localFile?.hash,
          );
          await this.setBaseline(context.manifest, verified);
          await this.store.deleteConflict(artifact.path);
          await this.store.saveManifest(context.manifest);
          remoteIndex.files.set(artifact.path, uploadedEntry);
          return promotionSucceeded(artifact, recoveryPath);
        });
        results.push(result);
      } catch (error: unknown) {
        results.push(promotionFailed(artifact, errorMessage(error)));
      }
    }
    return results;
  }

  async refreshLocalChanges(): Promise<SyncChange[]> {
    const context = await this.loadContext();
    if (!isManifestInitialized(context.manifest)) {
      this.lastPlan = {
        generatedAt: new Date().toISOString(),
        changes: [],
        executable: [],
        blocked: [],
        warnings: ['当前环境尚未建立同步基线，请先执行全量拉取'],
      };
      return [];
    }
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
        const content = remote.files.get(item.path);
        const scannedLocal = local.files.get(item.path);
        if (content && scannedLocal?.hash === content.hash) {
          const localPath = resolveSafeLocalPath(context.syncRoot, item.path);
          assertNoSymlinkSegments(context.syncRoot, localPath);
          const currentLocal = await this.readLocalFileIfExists(localPath, item.path);
          if (currentLocal?.hash === content.hash) {
            await this.setBaseline(context.manifest, content);
            await this.store.deleteConflict(item.path);
            await this.store.saveManifest(context.manifest);
            result.pulled++;
            continue;
          }
        }
        result.conflicts++;
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
    this.throwIfCancelled(cancellation);
    try {
      await this.withAuthentication(context.profile, api =>
        this.refreshFormMetadataCache(
          context.formMetadataCache,
          remote,
          api,
        ),
      );
    } catch (error: unknown) {
      this.output.warn(`表单元数据缓存更新失败，不影响源码拉取: ${errorMessage(error)}`);
    }
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
    if (!isManifestInitialized(context.manifest)) {
      throw new Error('当前环境尚未建立同步基线，请先执行全量拉取');
    }
    onProgress('正在扫描本地文件...');
    const local = await this.scanLocalFiles(context.syncRoot);
    const localChanges = new Map(
      buildLocalChanges(context.manifest, local.files).map(item => [item.path, item]),
    );
    this.assertGbkCompatibleSources(selectedPaths.flatMap(remotePath => {
      const localFile = local.files.get(remotePath);
      return localFile
        ? [{ path: remotePath, content: localFile.content }]
        : [];
    }));
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
        const pathCollision = remoteIndex.pathCollisions.find(item =>
          remotePathKey(item.path) === remotePathKey(remotePath));
        if (pathCollision) {
          throw new Error(pathCollision.message ?? '远端文件与目录路径冲突');
        }
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
            const latest = await this.readRemote(api, existing);
            if (latest.hash === localFile.hash) {
              await this.setBaseline(context.manifest, latest);
              await this.store.deleteConflict(remotePath);
              await this.store.saveManifest(context.manifest);
              this.lastRemoteFiles.set(remotePath, latest);
              result.pushed++;
              return;
            }
            await this.store.saveConflict(toStoredConflict(latest, 'initialCollision'));
            this.lastRemoteFiles.set(remotePath, latest);
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
              if (latest.hash === localFile.hash) {
                await this.setBaseline(context.manifest, latest);
                await this.store.deleteConflict(remotePath);
                await this.store.saveManifest(context.manifest);
                this.lastRemoteFiles.set(remotePath, latest);
                result.pushed++;
                return;
              }
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
          const verified = await this.verifyUploadResult(
            api,
            uploadedEntry,
            localFile.hash,
            upload,
            remotePath,
            cancellation,
          );

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
      formMetadataState: 'absent',
      formContexts: [],
      formMetadataWarnings: [],
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
      formMetadataState: 'absent',
      formContexts: [],
      formMetadataWarnings: [],
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

  private async loadContext(profileOverride?: ConnectionProfile): Promise<{
    profile: ConnectionProfile;
    syncRoot: string;
    manifest: SyncManifest;
    formMetadataCache: FormMetadataCache;
  }> {
    const profile = profileOverride ?? await this.store.getProfile();
    if (!profile) {
      throw new Error('请先配置 Ecode 连接');
    }
    const syncRoot = resolveEnvironmentSourceRoot(
      profile.workspaceFolder,
      profile.environmentDirectory,
    );
    const fingerprint = serverFingerprint(profile.serverUrl, profile.username);
    const manifest = await this.store.loadManifest(fingerprint, syncRoot);
    const formMetadataCache = await this.store.loadFormMetadataCache(
      fingerprint,
      syncRoot,
    );
    return { profile, syncRoot, manifest, formMetadataCache };
  }

  private async verifyReleaseArtifact(
    api: FileApi,
    remoteIndex: RemoteIndex,
    artifact: ReleaseArtifact,
  ): Promise<DeploymentFileResult> {
    const pathCollision = remoteIndex.pathCollisions.find(change =>
      remotePathKey(change.path) === remotePathKey(artifact.path));
    if (pathCollision) {
      return promotionConflict(
        artifact,
        undefined,
        pathCollision.message ?? '远端文件与目录路径冲突',
      );
    }
    const existing = remoteIndex.files.get(artifact.path);
    const remote = existing ? await this.readRemote(api, existing) : undefined;
    if (
      artifact.operation !== 'delete'
      && remote?.hash === artifact.resultHash
    ) {
      return promotionSucceeded(artifact);
    }
    return artifact.operation === 'delete' && !remote
      ? promotionSucceeded(artifact)
      : promotionPending(artifact);
  }

  private verifyTargetLocalArtifact(
    local: {
      files: Map<string, LocalFileState>;
      directories: Set<string>;
      unsupported: SyncChange[];
    },
    artifact: ReleaseArtifact,
    remoteResult: DeploymentFileResult,
  ): DeploymentFileResult {
    if (
      remoteResult.status !== 'pending'
      && remoteResult.status !== 'succeeded'
    ) {
      return remoteResult;
    }
    const artifactKey = remotePathKey(artifact.path);
    const unsupported = local.unsupported.find(change => {
      const unsupportedKey = remotePathKey(change.path);
      return artifactKey === unsupportedKey
        || artifactKey.startsWith(`${unsupportedKey}/`);
    });
    if (unsupported) {
      return promotionConflict(
        artifact,
        undefined,
        `目标环境本地路径不可安全写入: ${unsupported.message ?? unsupported.path}`,
      );
    }
    const localDirectory = [...local.directories].find(directory =>
      remotePathKey(directory) === artifactKey);
    if (localDirectory) {
      return promotionConflict(
        artifact,
        undefined,
        '目标环境本地存在同名目录，无法应用文件变更',
      );
    }
    const parentFile = [...local.files.keys()].find(localPath =>
      artifactKey.startsWith(`${remotePathKey(localPath)}/`));
    if (parentFile) {
      return promotionConflict(
        artifact,
        local.files.get(parentFile)?.hash,
        `目标环境本地父路径是文件: ${parentFile}`,
      );
    }
    return remoteResult;
  }

  private async preserveReleaseArtifactLocal(
    syncRoot: string,
    artifact: ReleaseArtifact,
    localFile: LocalFileState | undefined,
    remoteRecoveryHash: string | undefined,
  ): Promise<void> {
    const desiredHash = artifact.operation === 'delete'
      ? undefined
      : artifact.resultHash;
    if (
      !localFile
      || localFile.hash === desiredHash
      || localFile.hash === remoteRecoveryHash
    ) {
      return;
    }
    const localPath = resolveSafeLocalPath(syncRoot, artifact.path);
    assertNoSymlinkSegments(syncRoot, localPath);
    const current = await this.readLocalFileIfExists(localPath, artifact.path);
    if (current?.hash !== localFile.hash) {
      throw new Error(`${artifact.path}: 目标环境本地源码在应用准备期间发生变化`);
    }
    await this.store.saveRecovery(artifact.path, current.content);
  }

  private async reconcileReleaseArtifactLocal(
    syncRoot: string,
    artifact: ReleaseArtifact,
    expectedLocalHash: string | undefined,
  ): Promise<void> {
    const localPath = resolveSafeLocalPath(syncRoot, artifact.path);
    assertNoSymlinkSegments(syncRoot, localPath);
    const current = await this.readLocalFileIfExists(localPath, artifact.path);
    if (current?.hash !== expectedLocalHash) {
      throw new Error(`${artifact.path}: 目标环境本地源码在应用期间发生变化，已停止覆盖`);
    }
    if (artifact.operation === 'delete') {
      if (current) {
        await fs.unlink(localPath);
      }
      return;
    }
    if (artifact.resultContent === undefined) {
      throw new Error(`${artifact.path}: 冻结快照缺少目标源码`);
    }
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, artifact.resultContent, 'utf8');
  }

  private validateReleaseArtifacts(artifacts: ReleaseArtifact[]): void {
    if (artifacts.length === 0) {
      throw new Error('Release 中没有可发布文件');
    }
    const paths = new Set<string>();
    for (const artifact of artifacts) {
      const normalized = normalizeRemotePath(artifact.path);
      if (normalized !== artifact.path || paths.has(normalized)) {
        throw new Error(`${artifact.path}: Release 路径无效或重复`);
      }
      paths.add(normalized);
      if (artifact.operation === 'add') {
        if (
          artifact.baseHash !== undefined
          || artifact.resultContent === undefined
          || artifact.resultHash !== hashText(artifact.resultContent)
        ) {
          throw new Error(`${artifact.path}: Release 新增快照无效`);
        }
      } else if (artifact.operation === 'modify') {
        if (
          !artifact.baseHash
          || artifact.resultContent === undefined
          || artifact.resultHash !== hashText(artifact.resultContent)
        ) {
          throw new Error(`${artifact.path}: Release 修改快照无效`);
        }
      } else if (
        artifact.operation !== 'delete'
        || !artifact.baseHash
        || artifact.resultHash !== undefined
        || artifact.resultContent !== undefined
      ) {
        throw new Error(`${artifact.path}: Release 删除快照无效`);
      }
    }
    this.assertGbkCompatibleSources(artifacts.flatMap(artifact =>
      artifact.resultContent === undefined
        ? []
        : [{ path: artifact.path, content: artifact.resultContent }]));
  }

  private assertGbkCompatibleSources(
    sources: Array<{ path: string; content: string }>,
  ): void {
    const details: string[] = [];
    for (const source of sources) {
      const remaining = 10 - details.length;
      if (remaining <= 0) {
        break;
      }
      for (const issue of findGbkIncompatibleCharacters(source.content, remaining)) {
        details.push(
          `${source.path}:${issue.line}:${issue.column}: `
          + `${JSON.stringify(issue.character)} `
          + `(${formatUnicodeCodePoint(issue.codePoint)})`,
        );
      }
    }
    if (details.length === 0) {
      return;
    }
    throw new Error(
      '检测到 E-cology GBK 环境无法保存的源码字符，已在远端写入前终止操作：\n'
      + `${details.join('\n')}\n`
      + '请改用 Unicode 转义或其他纯 ASCII 表达，例如用 "\\u203A" 表示 ›。',
    );
  }

  private async scanRemote(
    api: FileApi,
    onProgress: (message: string) => void,
    cancellation?: CancellationLike,
  ): Promise<RemoteScan> {
    const index = await this.listRemoteIndex(api, cancellation, onProgress);
    const entries = index.files;
    const unsupported: SyncChange[] = [...index.pathCollisions];
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
      presentPaths: new Set([
        ...entries.keys(),
        ...index.pathCollisions.map(change => change.path),
      ]),
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
    assertNoCaseCollisions(allDirectoryPaths);
    const directoryPathByKey = new Map<string, string>();
    for (const directoryPath of allDirectoryPaths) {
      directoryPathByKey.set(remotePathKey(directoryPath), directoryPath);
    }
    const collisionKeys = new Set<string>();
    const pathCollisions: SyncChange[] = [];
    for (const entry of entries) {
      const directoryPath = directoryPathByKey.get(remotePathKey(entry.path));
      if (!directoryPath) {
        continue;
      }
      collisionKeys.add(remotePathKey(entry.path));
      pathCollisions.push({
        path: entry.path,
        status: 'unsupported',
        remoteId: entry.id,
        conflictReason: 'remotePathCollision',
        message: entry.path === directoryPath
          ? `远端同一路径同时存在文件和目录，无法映射到本地: ${entry.path}`
          : `远端文件与目录路径仅大小写不同，无法映射到本地: ${entry.path} / ${directoryPath}`,
      });
    }
    const safeEntries = entries.filter(entry =>
      !collisionKeys.has(remotePathKey(entry.path)));
    return {
      files: new Map(safeEntries.map(item => [item.path, item])),
      directories: directoryMap,
      ambiguousDirectories,
      pathCollisions,
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
    const response = await api.viewFileDetail(entry.id);
    const detail = requireSuccess(response, `读取远端文件失败: ${entry.path}`);
    if (!isSupportedText(detail.content)) {
      throw new Error('当前版本不支持二进制或非 UTF-8 文件');
    }
    return {
      entry,
      content: detail.content,
      hash: hashText(detail.content),
      formMetadataState: detail.formMetadataState,
      formContexts: detail.formContexts,
      formMetadataWarnings: detail.formMetadataWarnings,
    };
  }

  private async readRemoteAfterMutation(
    api: FileApi,
    entry: RemoteFileEntry,
    expectedHash: string | undefined,
    cancellation?: CancellationLike,
  ): Promise<RemoteFileContent> {
    let latest: RemoteFileContent | undefined;
    let lastError: unknown;
    for (const delayMs of [0, ...REMOTE_VERIFICATION_RETRY_DELAYS_MS]) {
      this.throwIfCancelled(cancellation);
      if (delayMs > 0) {
        await delay(delayMs);
      }
      this.throwIfCancelled(cancellation);
      try {
        latest = await this.readRemote(api, entry);
        if (!expectedHash || latest.hash === expectedHash) {
          return latest;
        }
      } catch (error: unknown) {
        if (error instanceof SessionExpiredError) {
          throw error;
        }
        lastError = error;
      }
    }
    if (latest) {
      return latest;
    }
    throw lastError ?? new Error(`无法回读远端文件: ${entry.path}`);
  }

  private async verifyUploadResult(
    api: FileApi,
    entry: RemoteFileEntry,
    expectedHash: string | undefined,
    upload: ApiResponse<unknown>,
    remotePath: string,
    cancellation?: CancellationLike,
  ): Promise<RemoteFileContent> {
    if (!upload.status) {
      if (isUnauthorized(upload.code)) {
        throw new SessionExpiredError(upload.msg || 'Session expired');
      }
      if (!isAmbiguousMutationFailure(upload)) {
        throw new Error(
          `上传失败: ${remotePath}${upload.msg ? `: ${upload.msg}` : ''}`,
        );
      }
    }

    let verified: RemoteFileContent;
    try {
      verified = await this.readRemoteAfterMutation(
        api,
        entry,
        expectedHash,
        cancellation,
      );
    } catch (error: unknown) {
      if (!upload.status) {
        throw new Error(
          `上传请求结果未知: ${remotePath}`
          + `${upload.msg ? `: ${upload.msg}` : ''}`
          + `；远端回读失败: ${errorMessage(error)}`,
        );
      }
      throw error;
    }
    if (verified.hash !== expectedHash) {
      throw new Error(
        upload.status
          ? '上传后远端内容校验不一致'
          : `上传请求结果未知且远端内容未达到目标: ${remotePath}`
            + `${upload.msg ? `: ${upload.msg}` : ''}`,
      );
    }
    return verified;
  }

  private async refreshFormMetadataCache(
    cache: FormMetadataCache,
    remote: RemoteScan,
    api: FileApi,
  ): Promise<void> {
    const nextFiles = { ...cache.files };
    for (const cachedPath of Object.keys(nextFiles)) {
      if (!remote.presentPaths.has(cachedPath)) {
        delete nextFiles[cachedPath];
      }
    }

    const analysis = analyzeFormContexts(
      [...remote.files.values()].map(file => ({
        path: file.entry.path,
        content: file.content,
      })),
    );
    for (const warning of analysis.warnings) {
      this.output.warn(`表单上下文: ${warning}`);
    }

    const workflowIds = new Set(
      [...analysis.bindingsByPath.entries()]
        .filter(([remotePath]) => !analysis.unresolvedPaths.has(remotePath))
        .flatMap(([, bindings]) => bindings)
        .filter(binding => binding.kind === 'workflow')
        .map(binding => binding.id),
    );
    const modeIds = new Set(
      [...analysis.bindingsByPath.entries()]
        .filter(([remotePath]) => !analysis.unresolvedPaths.has(remotePath))
        .flatMap(([, bindings]) => bindings)
        .filter(binding => binding.kind === 'mode')
        .map(binding => binding.id),
    );
    for (const modeId of modeIds) {
      this.output.warn(
        `已识别 ModeForm modeId=${modeId}，但未确认仅按 modeId 获取字段结构的服务器接口`,
      );
    }
    const workflowContexts = new Map<string, FormContext>();
    const failedWorkflowIds = new Set<string>();
    await mapConcurrent([...workflowIds], 4, async formId => {
      const response = await api.loadWorkflowFormContext(formId);
      if (isUnauthorized(response.code)) {
        throw new SessionExpiredError(response.msg || 'Session expired');
      }
      if (!response.status || !response.data) {
        failedWorkflowIds.add(formId);
        this.output.warn(
          `表单 ${formId} 字段元数据读取失败，保留旧缓存: ${response.msg ?? '未知错误'}`,
        );
        return;
      }
      workflowContexts.set(formId, response.data);
    });

    const updatedAt = new Date().toISOString();
    for (const [remotePath, remoteFile] of remote.files) {
      for (const warning of remoteFile.formMetadataWarnings) {
        this.output.warn(`表单元数据 ${remotePath}: ${warning}`);
      }
      const bindings = analysis.bindingsByPath.get(remotePath) ?? [];
      const contexts = [...remoteFile.formContexts];
      if (!analysis.unresolvedPaths.has(remotePath)) {
        for (const binding of bindings) {
          if (binding.kind === 'workflow') {
            const context = workflowContexts.get(binding.id);
            if (context) {
              contexts.push(context);
            }
          }
        }
      }
      const uniqueContexts = dedupeFormContexts(contexts);
      if (uniqueContexts.length > 0) {
        nextFiles[remotePath] = {
          remoteId: remoteFile.entry.id,
          path: remotePath,
          updatedAt,
          contexts: uniqueContexts,
        };
        continue;
      }
      const unresolvedBinding = bindings.some(binding =>
        binding.kind === 'mode'
        || failedWorkflowIds.has(binding.id));
      if (
        remoteFile.formMetadataState === 'invalid'
        || unresolvedBinding
        || analysis.unresolvedPaths.has(remotePath)
      ) {
        continue;
      }
      if (remoteFile.formMetadataState === 'absent') {
        delete nextFiles[remotePath];
      }
    }

    cache.files = nextFiles;
    await this.store.saveFormMetadataCache(cache);
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
    directories: Set<string>;
    unsupported: SyncChange[];
  }> {
    const files = new Map<string, LocalFileState>();
    const directories = new Set<string>();
    const unsupported: SyncChange[] = [];
    try {
      await fs.access(syncRoot);
    } catch {
      return { files, directories, unsupported };
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
          directories.add(relative);
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
    assertNoCaseCollisions(directories);
    return { files, directories, unsupported };
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
          formMetadataState: 'absent',
          formContexts: [],
          formMetadataWarnings: [],
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

function isAmbiguousMutationFailure(response: ApiResponse<unknown>): boolean {
  const numericCode = typeof response.code === 'number'
    ? response.code
    : typeof response.code === 'string' && /^-?\d+$/.test(response.code)
      ? Number(response.code)
      : undefined;
  return numericCode === -1 || (numericCode !== undefined && numericCode >= 500);
}

function joinRemote(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function remotePathKey(value: string): string {
  return value.toLocaleLowerCase('en-US');
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

function isManifestInitialized(manifest: SyncManifest): boolean {
  return Number.isFinite(Date.parse(manifest.updatedAt))
    && Date.parse(manifest.updatedAt) > 0;
}

function promotionPending(artifact: ReleaseArtifact): DeploymentFileResult {
  return {
    path: artifact.path,
    operation: artifact.operation,
    status: 'pending',
    expectedHash: artifact.baseHash,
  };
}

function promotionSucceeded(
  artifact: ReleaseArtifact,
  recoveryPath?: string,
): DeploymentFileResult {
  return {
    path: artifact.path,
    operation: artifact.operation,
    status: 'succeeded',
    expectedHash: artifact.resultHash,
    actualHash: artifact.resultHash,
    recoveryPath,
  };
}

function promotionConflict(
  artifact: ReleaseArtifact,
  actualHash: string | undefined,
  message: string,
): DeploymentFileResult {
  return {
    path: artifact.path,
    operation: artifact.operation,
    status: 'conflict',
    expectedHash: artifact.baseHash,
    actualHash,
    message,
  };
}

function promotionFailed(
  artifact: ReleaseArtifact,
  message: string,
): DeploymentFileResult {
  return {
    path: artifact.path,
    operation: artifact.operation,
    status: 'failed',
    expectedHash: artifact.resultHash,
    message,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dedupeFormContexts(contexts: FormContext[]): FormContext[] {
  const unique = new Map<string, FormContext>();
  for (const context of contexts) {
    const key = [
      context.kind,
      context.formId ?? '',
      context.modeId ?? '',
      context.workflowId ?? '',
      context.requestId ?? '',
    ].join(':');
    unique.set(key, context);
  }
  return [...unique.values()];
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

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function removeEmptyParents(directory: string, root: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  let current = path.resolve(directory);
  while (current !== resolvedRoot) {
    const relative = path.relative(resolvedRoot, current);
    if (
      relative === '..'
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
    ) {
      throw new Error(`目录超出源码范围: ${current}`);
    }
    try {
      await fs.rmdir(current);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST') {
        return;
      }
      throw error;
    }
    current = path.dirname(current);
  }
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
