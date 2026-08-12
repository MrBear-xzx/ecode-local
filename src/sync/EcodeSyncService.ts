import * as fs from 'fs/promises';
import * as path from 'path';
import type * as vscode from 'vscode';
import {
  assertNoSymlinkSegments,
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
import { hashFileBytes, hashText, serverFingerprint, textByteSize } from '../domain/text';
import type {
  ConnectionProfile,
  DeploymentFileResult,
  LocalFileState,
  LocalResourceFileState,
  ManifestEntry,
  PromotionCandidate,
  ReleaseArtifact,
  ReleaseVerification,
  RemoteFileContent,
  RemoteFileEntry,
  RemoteResourceFileContent,
  RemoteTextFileContent,
  StoredConflict,
  SyncChange,
  SyncManifest,
  SyncOperationResult,
  SyncPlan,
} from '../domain/types';
import type { WorkspaceStore } from '../storage/WorkspaceStore';
import { copyFileAtomic } from '../storage/AtomicFileStore';
import { EcodeCompiler } from './EcodeCompiler';
import {
  SessionExpiredError,
  SyncCancelledError,
  isUnauthorized,
  requireSuccess,
} from './EcodeErrors';
import { FileApi } from './api/FileApi';
import type { ApiResponse, TreeNode } from './api/types';
import type { AuthManager } from './auth/AuthManager';
import {
  LocalWorkspaceScanner,
  type LocalScan,
} from './LocalWorkspaceScanner';
import { ManifestCheckpoint } from './ManifestCheckpoint';
import {
  RemoteWorkspaceScanner,
  isPathAtOrBelow,
  remotePathKey,
  type CancellationLike,
  type RemoteDirectoryEntry,
  type RemoteIndex,
  type RemoteScan,
} from './RemoteWorkspaceScanner';

export { SyncCancelledError } from './EcodeErrors';

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
    private readonly localScanner = new LocalWorkspaceScanner(),
    private readonly remoteScanner = new RemoteWorkspaceScanner(output),
  ) {}

  getLastPlan(): SyncPlan | undefined {
    return this.lastPlan;
  }

  getCompilerVersion(): string {
    return this.compiler.getVersion();
  }

  async cleanupExpiredStaging(): Promise<void> {
    await this.remoteScanner.cleanupExpiredStaging();
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
    const local = await this.localScanner.scan(context.syncRoot, context.resourceRoots);
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
      const kind = localFile?.kind ?? baseline?.kind ?? 'text';
      candidates.push({
        path: remotePath,
        operation: change.status === 'localAdded'
          ? 'add'
          : change.status === 'localDeleted' ? 'delete' : 'modify',
        baseHash: baseline?.baselineHash,
        kind,
        size: localFile?.size ?? baseline?.size,
        baseContent: baseline && kind === 'text'
          ? await this.store.readSnapshot(context.syncRoot, baseline.snapshotKey)
          : undefined,
        baseResourcePath: baseline && kind === 'resource'
          ? await this.store.getSnapshotPath(
              context.syncRoot,
              baseline.snapshotKey,
              'resource',
            )
          : undefined,
        resultHash: localFile?.hash,
        resultContent: localFile?.kind === 'text' ? localFile.content : undefined,
        resultResourcePath: localFile?.kind === 'resource'
          ? localFile.sourcePath
          : undefined,
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
    const local = await this.localScanner.scan(context.syncRoot, context.resourceRoots);
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
        && (
          !candidate.baseHash
          || (candidate.kind === 'resource'
            ? candidate.baseResourcePath === undefined
            : candidate.baseContent === undefined)
        )
      ) {
        conflicts.push(`${candidate.path}: 推送记录缺少修改前源码快照`);
      }
      if (
        candidate.kind !== 'resource'
        &&
        candidate.baseContent !== undefined
        && candidate.baseHash !== hashText(candidate.baseContent)
      ) {
        conflicts.push(`${candidate.path}: 推送前源码快照 Hash 不一致`);
      }
      if (
        candidate.kind === 'resource'
        && candidate.baseResourcePath
        && candidate.baseHash !== (await hashFileBytes(candidate.baseResourcePath)).hash
      ) {
        conflicts.push(`${candidate.path}: 推送前资源快照 Hash 不一致`);
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
          await this.saveLocalRecovery(context.syncRoot, candidate.path, current),
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
        if (candidate.kind === 'resource') {
          await copyFileAtomic(localPath, candidate.baseResourcePath!);
        } else {
          await fs.writeFile(localPath, candidate.baseContent!, 'utf8');
        }
      }
    }

    await this.refreshLocalChanges();
    return recoveryPaths;
  }

  async verifyRelease(
    profile: ConnectionProfile,
    artifacts: ReleaseArtifact[],
  ): Promise<ReleaseVerification> {
    await this.validateReleaseArtifacts(artifacts);
    const remoteIndex = await this.withAuthentication(profile, api =>
      this.remoteScanner.listIndex(api));
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
      const local = await this.localScanner.scan(context.syncRoot, context.resourceRoots);
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
    onVerifiedCandidate?: (candidate: PromotionCandidate) => void,
  ): Promise<DeploymentFileResult[]> {
    const preflight = await this.verifyRelease(profile, artifacts);
    if (!preflight.success) {
      return preflight.files;
    }
    const context = await this.loadContext(profile);
    let remoteIndex = await this.withAuthentication(profile, api =>
      this.remoteScanner.listIndex(api));
    const localState = await this.localScanner.scan(context.syncRoot, context.resourceRoots);
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
          const localCheck = this.verifyTargetLocalArtifact(
            localState,
            artifact,
            check,
          );
          if (
            localCheck.status !== 'pending'
            && localCheck.status !== 'succeeded'
          ) {
            return localCheck;
          }
          const localFile = [...localState.files.values()].find(file =>
            remotePathKey(file.path) === remotePathKey(artifact.path));
          let recoveryPath: string | undefined;
          let remoteRecoveryHash: string | undefined;
          let previousRemote: RemoteFileContent | undefined;
          if (check.status === 'pending' && existing) {
            const current = await this.remoteScanner.readFile(api, existing);
            previousRemote = current;
            remoteRecoveryHash = current.hash;
            recoveryPath = isRemoteResource(current)
              ? await this.store.saveResourceRecovery(
                  context.syncRoot,
                  artifact.path,
                  current.sourcePath,
                )
              : await this.store.saveRecovery(
                  context.syncRoot,
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
              this.updateLocalStateAfterRelease(localState, artifact, localFile?.path);
              delete context.manifest.files[artifact.path];
            } else {
              if (!existing) {
                return promotionConflict(
                  artifact,
                  undefined,
                  '目标环境远端文件在应用期间消失',
                );
              }
              const verified = await this.remoteScanner.readFile(api, existing);
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
              this.updateLocalStateAfterRelease(localState, artifact, localFile?.path);
              await this.setBaseline(context.syncRoot, context.manifest, verified);
              await this.cleanupRemoteStaging(verified);
            }
            await this.store.deleteConflict(context.syncRoot, artifact.path);
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
            const deletion = artifact.kind === 'resource'
              ? await api.deleteResource(existing.id)
              : await api.deleteFile(existing.id);
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
              artifact.kind === 'resource' ? 'resource' : 'text',
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
            this.updateLocalStateAfterRelease(localState, artifact, localFile?.path);
            delete context.manifest.files[artifact.path];
            await this.store.deleteConflict(context.syncRoot, artifact.path);
            await this.store.saveManifest(context.manifest);
            onVerifiedCandidate?.(releasePromotionCandidate(
              artifact,
              previousRemote,
              recoveryPath,
            ));
            await this.cleanupRemoteStaging(previousRemote);
            return promotionSucceeded(artifact, recoveryPath);
          }

          if (artifact.kind === 'resource') {
            if (!artifact.resultResourcePath || !artifact.resultHash) {
              throw new Error('冻结快照缺少目标资源');
            }
            const resourceResult = await this.pushResource(
              api,
              context.syncRoot,
              context.manifest,
              remoteIndex,
              artifact.path,
              {
                path: artifact.path,
                kind: 'resource',
                sourcePath: artifact.resultResourcePath,
                hash: artifact.resultHash,
                size: artifact.size ?? 0,
              },
              artifact.operation === 'add' ? 'localAdded' : 'localModified',
              cancellation,
            );
            if (resourceResult.conflict) {
              return promotionConflict(
                artifact,
                resourceResult.conflict.remoteHash,
                resourceResult.conflict.message ?? '目标资源冲突',
              );
            }
            await this.reconcileReleaseArtifactLocal(
              context.syncRoot,
              artifact,
              localFile?.hash,
            );
            this.updateLocalStateAfterRelease(localState, artifact, localFile?.path);
            remoteIndex.files.set(artifact.path, resourceResult.verified.entry);
            onVerifiedCandidate?.(releasePromotionCandidate(
              artifact,
              previousRemote,
              recoveryPath,
            ));
            await this.cleanupRemoteStaging(previousRemote);
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
          this.updateLocalStateAfterRelease(localState, artifact, localFile?.path);
          await this.setBaseline(context.syncRoot, context.manifest, verified);
          await this.store.deleteConflict(context.syncRoot, artifact.path);
          await this.store.saveManifest(context.manifest);
          remoteIndex.files.set(artifact.path, uploadedEntry);
          onVerifiedCandidate?.(releasePromotionCandidate(
            artifact,
            previousRemote,
            recoveryPath,
          ));
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
    const local = await this.localScanner.scan(context.syncRoot, context.resourceRoots);
    const changes = await this.mergeStoredConflicts(
      context.syncRoot,
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

  async refreshChanges(
    onProgress: (message: string) => void,
    cancellation?: CancellationLike,
  ): Promise<SyncChange[]> {
    const context = await this.loadContext();
    if (!isManifestInitialized(context.manifest)) {
      return this.refreshLocalChanges();
    }

    onProgress('正在读取远端状态...');
    const remote = await this.withAuthentication(context.profile, api =>
      this.remoteScanner.scan(api, onProgress, cancellation));
    await this.saveRemoteCatalog(context.syncRoot, context.fingerprint, remote);
    try {
    this.throwIfCancelled(cancellation);
    for (const manifestPath of Object.keys(context.manifest.files)) {
      if ([...remote.ambiguousDirectories].some(directory =>
        isPathAtOrBelow(manifestPath, directory))) {
        remote.presentPaths.add(manifestPath);
      }
    }

    onProgress('正在扫描本地文件...');
    const local = await this.localScanner.scan(context.syncRoot, remote.resourceRoots);
    onProgress('正在计算本地与远端变更...');
    const plan = buildSyncPlan(
      context.manifest,
      local.files,
      remote.files,
      [...remote.unsupported, ...local.unsupported],
      remote.presentPaths,
    );
    for (const change of plan.changes) {
      if (change.status !== 'conflict' || !change.conflictReason) {
        continue;
      }
      const remoteFile = remote.files.get(change.path);
      if (remoteFile) {
        await this.saveRemoteConflict(
          context.syncRoot,
          remoteFile,
          change.conflictReason,
        );
      } else if (change.conflictReason === 'remoteDeletedLocalModified') {
        await this.saveRemoteDeletionConflict(
          context.syncRoot,
          context.manifest,
          change.path,
        );
      }
    }
    const changes = await this.mergeStoredConflicts(
      context.syncRoot,
      context.manifest,
      local.files,
      plan.changes,
    );
    this.lastRemoteFiles = remote.files;
    this.lastPlan = {
      ...plan,
      changes,
      warnings: [...plan.warnings, ...remote.errors],
    };
    return changes;
    } finally {
      await this.remoteScanner.cleanupStaging(remote.stagingRoot);
    }
  }

  async pull(
    onProgress: (message: string) => void,
    cancellation?: CancellationLike,
  ): Promise<SyncOperationResult> {
    const context = await this.loadContext();
    await fs.mkdir(context.syncRoot, { recursive: true });

    onProgress('正在验证连接...');
    const remote = await this.withAuthentication(context.profile, api =>
      this.remoteScanner.scan(api, onProgress, cancellation),
    );
    await this.saveRemoteCatalog(context.syncRoot, context.fingerprint, remote);
    try {
    this.throwIfCancelled(cancellation);
    for (const manifestPath of Object.keys(context.manifest.files)) {
      if ([...remote.ambiguousDirectories].some(directory =>
        isPathAtOrBelow(manifestPath, directory))) {
        remote.presentPaths.add(manifestPath);
      }
    }

    onProgress('正在扫描本地文件...');
    const local = await this.localScanner.scan(context.syncRoot, remote.resourceRoots);
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
    const manifestCheckpoint = new ManifestCheckpoint(() =>
      this.store.saveManifest(context.manifest));
    // 即使远端为空，首次拉取也需要持久化初始化时间以建立同步基线。
    await manifestCheckpoint.markDirty();

    try {
      for (const item of plan.changes) {
        if (item.status === 'conflict') {
          const content = remote.files.get(item.path);
          const scannedLocal = local.files.get(item.path);
          if (content && scannedLocal?.hash === content.hash) {
            const localPath = resolveSafeLocalPath(context.syncRoot, item.path);
            assertNoSymlinkSegments(context.syncRoot, localPath);
            const currentLocal = await this.localScanner.readFileIfExists(
              localPath,
              item.path,
              content.entry.kind,
            );
            if (currentLocal?.hash === content.hash) {
              await this.setBaseline(context.syncRoot, context.manifest, content);
              await this.store.deleteConflict(context.syncRoot, item.path);
              await manifestCheckpoint.markDirty();
              result.pulled++;
              continue;
            }
          }
          result.conflicts++;
          if (content && item.conflictReason) {
            await this.saveRemoteConflict(
              context.syncRoot,
              content,
              item.conflictReason,
            );
          } else if (item.conflictReason === 'remoteDeletedLocalModified') {
            await this.saveRemoteDeletionConflict(
              context.syncRoot,
              context.manifest,
              item.path,
            );
          }
        } else if (item.status === 'unsupported') {
          result.unsupported++;
        }
      }

      let applied = 0;
      for (const item of plan.executable) {
        if (cancellation?.isCancellationRequested) {
          await manifestCheckpoint.flush();
        }
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
            const currentLocal = await this.localScanner.readFileIfExists(
              localPath,
              item.path,
              baseline.kind,
            );
            if (currentLocal && currentLocal.hash !== baseline.baselineHash) {
              await this.saveRemoteDeletionConflict(
                context.syncRoot,
                context.manifest,
                item.path,
              );
              result.conflicts++;
              continue;
            }
            if (currentLocal) {
              const recovery = await this.saveLocalRecovery(
                context.syncRoot,
                item.path,
                currentLocal,
              );
              await fs.unlink(localPath);
              deletedLocalParents.add(path.posix.dirname(item.path));
              this.output.info(`Remote deletion applied: ${item.path}; recovery: ${recovery}`);
              result.deletedLocal++;
            }
            delete context.manifest.files[item.path];
            await this.store.deleteConflict(context.syncRoot, item.path);
            await manifestCheckpoint.markDirty();
            continue;
          }

          const remoteFile = remote.files.get(item.path);
          if (!remoteFile) {
            continue;
          }
          const localFile = local.files.get(item.path);
          const currentLocal = await this.localScanner.readFileIfExists(
            localPath,
            item.path,
            remoteFile.entry.kind,
          );
          if (currentLocal?.hash !== localFile?.hash) {
            const reason = localFile ? 'bothModified' : 'initialCollision';
            await this.saveRemoteConflict(context.syncRoot, remoteFile, reason);
            this.lastRemoteFiles.set(item.path, remoteFile);
            result.conflicts++;
            continue;
          }
          if (!currentLocal || currentLocal.hash !== remoteFile.hash) {
            await this.writeRemoteToLocal(context.syncRoot, localPath, remoteFile);
          }
          await this.setBaseline(context.syncRoot, context.manifest, remoteFile);
          await manifestCheckpoint.markDirty();
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

      const changeByPath = new Map(plan.changes.map(change => [change.path, change]));
      for (const [remotePath, remoteFile] of remote.files) {
        const change = changeByPath.get(remotePath);
        if (change?.status === 'clean') {
          const entry = context.manifest.files[remotePath];
          if (entry) {
            entry.remoteId = remoteFile.entry.id;
            entry.kind = remoteFile.entry.kind;
            entry.size = remoteFile.size;
            entry.lastVerifiedAt = new Date().toISOString();
            await manifestCheckpoint.markDirty();
          }
        }
      }

    } finally {
      // 本地文件可能已经应用；任何后处理异常都不能让清单停留在旧状态。
      await manifestCheckpoint.flush();
    }
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

    const refreshedLocal = await this.localScanner.scan(context.syncRoot, remote.resourceRoots);
    this.lastPlan = buildSyncPlan(
      context.manifest,
      refreshedLocal.files,
      remote.files,
      [...remote.unsupported, ...refreshedLocal.unsupported],
      remote.presentPaths,
    );
    result.success = result.failed === 0;
    return result;
    } finally {
      await this.remoteScanner.cleanupStaging(remote.stagingRoot);
    }
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
    const local = await this.localScanner.scan(context.syncRoot, context.resourceRoots);
    const localChanges = new Map(
      buildLocalChanges(context.manifest, local.files).map(item => [item.path, item]),
    );
    this.assertGbkCompatibleSources(selectedPaths.flatMap(remotePath => {
      const localFile = local.files.get(remotePath);
      return localFile?.kind === 'text'
        ? [{ path: remotePath, content: localFile.content }]
        : [];
    }));
    const pushConflicts = new Map<string, SyncChange>();
    const result = emptyResult();
    let remoteIndex = await this.withAuthentication(context.profile, api =>
      this.remoteScanner.listIndex(
        api,
        cancellation,
        message => onProgress(`准备推送：${message}`),
      ),
    );
    await this.saveRemoteCatalog(context.syncRoot, context.fingerprint, remoteIndex);
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
        const pathCollision = findRemotePathCollision(remoteIndex, remotePath);
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
            && context.manifest.files[remotePath]?.kind !== 'resource'
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
                await this.store.deleteConflict(context.syncRoot, deletedPath);
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
            if (await this.localScanner.readFileIfExists(
              localPath,
              remotePath,
              baseline.kind,
            )) {
              throw new Error('本地文件已重新出现，请刷新变更后重试');
            }

            const existing = remoteIndex.files.get(remotePath);
            if (existing) {
              if (existing.id !== baseline.remoteId) {
                await this.recordPushConflict(
                  context.syncRoot,
                  api,
                  remotePath,
                  existing,
                  'remotePathCollision',
                );
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

              const latest = await this.remoteScanner.readFile(api, existing);
              if (latest.hash !== baseline.baselineHash) {
                await this.saveRemoteConflict(
                  context.syncRoot,
                  latest,
                  'localDeletedRemoteModified',
                );
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
                await this.cleanupRemoteStaging(latest);
                return;
              }

              await this.cleanupRemoteStaging(latest);

              if (await this.localScanner.readFileIfExists(
                localPath,
                remotePath,
                baseline.kind,
              )) {
                throw new Error('本地文件在远端删除前重新出现，请刷新变更后重试');
              }
              const deletion = baseline.kind === 'resource'
                ? await api.deleteResource(existing.id)
                : await api.deleteFile(existing.id);
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
                baseline.kind,
              );
              if (remaining) {
                throw new Error('删除后远端文件仍然存在');
              }
              remoteIndex.files.delete(remotePath);
            }

            delete context.manifest.files[remotePath];
            await this.store.deleteConflict(context.syncRoot, remotePath);
            await this.store.saveManifest(context.manifest);
            result.deletedRemote++;
          });
          continue;
        }

        if (!localFile) {
          throw new Error('本地文件不存在');
        }
        await this.withAuthentication(context.profile, async api => {
          if (localFile.kind === 'resource') {
            const resourceResult = await this.pushResource(
              api,
              context.syncRoot,
              context.manifest,
              remoteIndex,
              remotePath,
              localFile,
              change.status,
              cancellation,
            );
            if (resourceResult.conflict) {
              result.conflicts++;
              pushConflicts.set(remotePath, resourceResult.conflict);
              return;
            }
            this.lastRemoteFiles.set(remotePath, resourceResult.verified);
            remoteIndex.files.set(remotePath, resourceResult.verified.entry);
            result.pushed++;
            return;
          }
          const compiledContent = this.compiler.compile(remotePath, localFile.content);
          let existing = remoteIndex.files.get(remotePath);
          if (change.status === 'localAdded' && existing) {
            const latest = await this.remoteScanner.readFile(api, existing);
            if (latest.hash === localFile.hash) {
              await this.setBaseline(context.syncRoot, context.manifest, latest);
              await this.store.deleteConflict(context.syncRoot, remotePath);
              await this.store.saveManifest(context.manifest);
              this.lastRemoteFiles.set(remotePath, latest);
              result.pushed++;
              return;
            }
            await this.saveRemoteConflict(context.syncRoot, latest, 'initialCollision');
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
              await this.recordPushConflict(
                context.syncRoot,
                api,
                remotePath,
                existing,
                'remotePathCollision',
              );
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
            const latest = await this.remoteScanner.readFile(api, existing);
            if (latest.hash !== baseline.baselineHash) {
              if (latest.hash === localFile.hash) {
                await this.setBaseline(context.syncRoot, context.manifest, latest);
                await this.store.deleteConflict(context.syncRoot, remotePath);
                await this.store.saveManifest(context.manifest);
                this.lastRemoteFiles.set(remotePath, latest);
                result.pushed++;
                return;
              }
              await this.saveRemoteConflict(context.syncRoot, latest, 'bothModified');
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
              await this.recordPushConflict(
                context.syncRoot,
                api,
                remotePath,
                existing,
                'initialCollision',
              );
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

          await this.setBaseline(context.syncRoot, context.manifest, verified);
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

    const refreshed = await this.localScanner.scan(context.syncRoot, remoteIndex.resourceRoots);
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
    if (!entry) {
      return '';
    }
    if (entry.kind === 'resource') {
      await this.store.getSnapshotPath(context.syncRoot, entry.snapshotKey, 'resource');
      return formatFileSummary(
        '基线',
        remotePath,
        'resource',
        entry.size,
        entry.baselineHash,
        true,
      );
    }
    return this.store.readSnapshot(context.syncRoot, entry.snapshotKey);
  }

  async getLatestRemoteContent(remotePath: string): Promise<string> {
    const remembered = this.lastRemoteFiles.get(remotePath);
    if (remembered) {
      return isRemoteResource(remembered)
        ? formatFileSummary(
            '远端',
            remotePath,
            'resource',
            remembered.size,
            remembered.hash,
            true,
          )
        : remembered.content;
    }
    const context = await this.loadContext();
    const conflict = await this.store.loadConflict(context.syncRoot, remotePath);
    if (conflict?.kind === 'resource') {
      return formatFileSummary(
        '远端',
        remotePath,
        'resource',
        conflict.remoteSize,
        conflict.remoteHash,
        !conflict.remoteDeleted,
      );
    }
    return conflict?.remoteContent ?? '';
  }

  async getLocalContent(remotePath: string): Promise<string> {
    const context = await this.loadContext();
    const localPath = resolveSafeLocalPath(context.syncRoot, remotePath);
    const kind = context.manifest.files[remotePath]?.kind
      ?? ([...context.resourceRoots].some(root => isPathAtOrBelow(remotePath, root))
        ? 'resource'
        : 'text');
    const local = await this.localScanner.readFileIfExists(localPath, remotePath, kind);
    if (!local) {
      return formatFileSummary('本地', remotePath, kind, undefined, undefined, false);
    }
    return local.kind === 'resource'
      ? formatFileSummary('本地', remotePath, 'resource', local.size, local.hash, true)
      : local.content;
  }

  async acceptRemote(remotePath: string): Promise<string | undefined> {
    const context = await this.loadContext();
    const { latest } = await this.requireCurrentConflict(
      context.profile,
      context.syncRoot,
      remotePath,
    );
    const localPath = resolveSafeLocalPath(context.syncRoot, remotePath);
    assertNoSymlinkSegments(context.syncRoot, localPath);
    try {
      const current = await this.localScanner.readFileIfExists(
        localPath,
        remotePath,
        latest.entry.kind,
      );
      const recovery = current
        ? await this.saveLocalRecovery(context.syncRoot, remotePath, current)
        : undefined;
      await this.writeRemoteToLocal(context.syncRoot, localPath, latest);
      await this.setBaseline(context.syncRoot, context.manifest, latest);
      await this.store.deleteConflict(context.syncRoot, remotePath);
      await this.store.saveManifest(context.manifest);
      await this.refreshLocalChanges();
      return recovery;
    } finally {
      await this.cleanupRemoteStaging(latest);
    }
  }

  async markMerged(remotePath: string): Promise<void> {
    const context = await this.loadContext();
    const { latest } = await this.requireCurrentConflict(
      context.profile,
      context.syncRoot,
      remotePath,
    );
    const localPath = resolveSafeLocalPath(context.syncRoot, remotePath);
    await fs.access(localPath);
    try {
      await this.setBaseline(context.syncRoot, context.manifest, latest);
      await this.store.deleteConflict(context.syncRoot, remotePath);
      await this.store.saveManifest(context.manifest);
      await this.refreshLocalChanges();
    } finally {
      await this.cleanupRemoteStaging(latest);
    }
  }

  async revertLocalChange(remotePath: string): Promise<string | undefined> {
    const context = await this.loadContext();
    const local = await this.localScanner.scan(context.syncRoot, context.resourceRoots);
    const change = buildLocalChanges(context.manifest, local.files)
      .find(item => item.path === remotePath);
    if (!change || !['localAdded', 'localModified', 'localDeleted'].includes(change.status)) {
      throw new Error('该文件已不再是可回退的本地变更');
    }

    const localPath = resolveSafeLocalPath(context.syncRoot, remotePath);
    assertNoSymlinkSegments(context.syncRoot, localPath);
    const scannedLocal = local.files.get(remotePath);
    const baseline = context.manifest.files[remotePath];
    const currentLocal = await this.localScanner.readFileIfExists(
      localPath,
      remotePath,
      scannedLocal?.kind ?? baseline?.kind ?? 'text',
    );
    if (currentLocal?.hash !== scannedLocal?.hash) {
      throw new Error('本地文件在回退前再次变化，请刷新后重试');
    }

    let recovery: string | undefined;
    if (change.status === 'localAdded') {
      if (!currentLocal) {
        throw new Error('本地新增文件已不存在');
      }
      recovery = await this.saveLocalRecovery(context.syncRoot, remotePath, currentLocal);
      await fs.unlink(localPath);
    } else {
      if (!baseline) {
        throw new Error('未找到可用于回退的同步基线');
      }
      if (currentLocal) {
        recovery = await this.saveLocalRecovery(context.syncRoot, remotePath, currentLocal);
      }
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      if (baseline.kind === 'resource') {
        const snapshotPath = await this.store.getSnapshotPath(
          context.syncRoot,
          baseline.snapshotKey,
          'resource',
        );
        await copyFileAtomic(localPath, snapshotPath);
      } else {
        const baselineContent = await this.store.readSnapshot(
          context.syncRoot,
          baseline.snapshotKey,
        );
        if (hashText(baselineContent) !== baseline.baselineHash) {
          throw new Error('同步基线快照校验失败，已停止回退');
        }
        await fs.writeFile(localPath, baselineContent, 'utf8');
      }
    }

    await this.refreshLocalChanges();
    return recovery;
  }

  async acceptRemoteDeletion(remotePath: string): Promise<string | undefined> {
    const context = await this.loadContext();
    const conflict = await this.requireRemoteDeletionConflict(
      context.profile,
      context.syncRoot,
      remotePath,
    );
    const localPath = resolveSafeLocalPath(context.syncRoot, remotePath);
    assertNoSymlinkSegments(context.syncRoot, localPath);
    const kind = conflict.kind ?? context.manifest.files[remotePath]?.kind ?? 'text';
    const currentLocal = await this.localScanner.readFileIfExists(
      localPath,
      remotePath,
      kind,
    );
    const recovery = currentLocal
      ? await this.saveLocalRecovery(context.syncRoot, remotePath, currentLocal)
      : undefined;
    if (currentLocal) {
      await fs.unlink(localPath);
    }
    delete context.manifest.files[remotePath];
    await this.store.deleteConflict(context.syncRoot, remotePath);
    await this.store.saveManifest(context.manifest);
    await this.refreshLocalChanges();
    return recovery;
  }

  async keepLocalAfterRemoteDeletion(remotePath: string): Promise<void> {
    const context = await this.loadContext();
    await this.requireRemoteDeletionConflict(
      context.profile,
      context.syncRoot,
      remotePath,
    );
    const localPath = resolveSafeLocalPath(context.syncRoot, remotePath);
    assertNoSymlinkSegments(context.syncRoot, localPath);
    if (!await this.localScanner.readFileIfExists(localPath, remotePath)) {
      throw new Error('本地文件已不存在，无法保留并重新创建远端文件');
    }
    delete context.manifest.files[remotePath];
    await this.store.deleteConflict(context.syncRoot, remotePath);
    await this.store.saveManifest(context.manifest);
    await this.refreshLocalChanges();
  }

  private async loadContext(profileOverride?: ConnectionProfile): Promise<{
    profile: ConnectionProfile;
    syncRoot: string;
    manifest: SyncManifest;
    formMetadataCache: FormMetadataCache;
    resourceRoots: Set<string>;
    fingerprint: string;
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
    const appMetadata = await this.store.loadAppMetadata(syncRoot);
    const resourceRoots = new Set(
      appMetadata?.serverFingerprint === fingerprint
        && path.resolve(appMetadata.syncRoot) === path.resolve(syncRoot)
        ? appMetadata.apps.flatMap(app => app.resourceRoots)
        : [],
    );
    return {
      profile,
      syncRoot,
      manifest,
      formMetadataCache,
      resourceRoots,
      fingerprint,
    };
  }

  private async verifyReleaseArtifact(
    api: FileApi,
    remoteIndex: RemoteIndex,
    artifact: ReleaseArtifact,
  ): Promise<DeploymentFileResult> {
    const pathCollision = findRemotePathCollision(remoteIndex, artifact.path);
    if (pathCollision) {
      return promotionConflict(
        artifact,
        undefined,
        pathCollision.message ?? '远端文件与目录路径冲突',
      );
    }
    const existing = remoteIndex.files.get(artifact.path);
    const remote = existing
      ? await this.remoteScanner.readFile(api, existing)
      : undefined;
    try {
      if (
        artifact.operation !== 'delete'
        && remote?.hash === artifact.resultHash
      ) {
        return promotionSucceeded(artifact);
      }
      if (artifact.kind !== 'resource') {
        return artifact.operation === 'delete' && !remote
          ? promotionSucceeded(artifact)
          : promotionPending(artifact);
      }
      if (artifact.operation === 'add') {
        return remote
          ? promotionConflict(artifact, remote.hash, '目标环境已存在同路径文件')
          : promotionPending(artifact);
      }
      if (!remote) {
        return artifact.operation === 'delete'
          ? promotionSucceeded(artifact)
          : promotionConflict(artifact, undefined, '目标环境文件不存在');
      }
      return remote.hash === artifact.baseHash
        ? promotionPending(artifact)
        : promotionConflict(artifact, remote.hash, '目标环境内容与变更集基线不一致');
    } finally {
      await this.cleanupRemoteStaging(remote);
    }
  }

  private verifyTargetLocalArtifact(
    local: LocalScan,
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
    const current = await this.localScanner.readFileIfExists(
      localPath,
      artifact.path,
      artifact.kind === 'resource' ? 'resource' : 'text',
    );
    if (current?.hash !== localFile.hash) {
      throw new Error(`${artifact.path}: 目标环境本地源码在应用准备期间发生变化`);
    }
    await this.saveLocalRecovery(syncRoot, artifact.path, current);
  }

  private async reconcileReleaseArtifactLocal(
    syncRoot: string,
    artifact: ReleaseArtifact,
    expectedLocalHash: string | undefined,
  ): Promise<void> {
    const localPath = resolveSafeLocalPath(syncRoot, artifact.path);
    assertNoSymlinkSegments(syncRoot, localPath);
    const current = await this.localScanner.readFileIfExists(
      localPath,
      artifact.path,
      artifact.kind === 'resource' ? 'resource' : 'text',
    );
    if (current?.hash !== expectedLocalHash) {
      throw new Error(`${artifact.path}: 目标环境本地源码在应用期间发生变化，已停止覆盖`);
    }
    if (artifact.operation === 'delete') {
      if (current) {
        await fs.unlink(localPath);
      }
      return;
    }
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    if (artifact.kind === 'resource') {
      if (!artifact.resultResourcePath) {
        throw new Error(`${artifact.path}: 冻结快照缺少目标资源对象`);
      }
      await copyFileAtomic(localPath, artifact.resultResourcePath);
    } else {
      if (artifact.resultContent === undefined) {
        throw new Error(`${artifact.path}: 冻结快照缺少目标源码`);
      }
      await fs.writeFile(localPath, artifact.resultContent, 'utf8');
    }
  }

  private updateLocalStateAfterRelease(
    local: LocalScan,
    artifact: ReleaseArtifact,
    previousLocalPath?: string,
  ): void {
    if (previousLocalPath) {
      local.files.delete(previousLocalPath);
    }
    if (artifact.operation === 'delete') {
      local.files.delete(artifact.path);
      return;
    }
    if (artifact.resultHash === undefined) {
      return;
    }
    if (artifact.kind === 'resource' && artifact.resultResourcePath) {
      local.files.set(artifact.path, {
        path: artifact.path,
        kind: 'resource',
        sourcePath: artifact.resultResourcePath,
        hash: artifact.resultHash,
        size: artifact.size ?? 0,
      });
    } else if (artifact.resultContent !== undefined) {
      local.files.set(artifact.path, {
        path: artifact.path,
        kind: 'text',
        content: artifact.resultContent,
        hash: artifact.resultHash,
        size: textByteSize(artifact.resultContent),
      });
    }
    let parent = path.posix.dirname(artifact.path);
    while (parent !== '.') {
      local.directories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }

  private async validateReleaseArtifacts(artifacts: ReleaseArtifact[]): Promise<void> {
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
      if (artifact.kind === 'resource') {
        if (artifact.operation === 'delete') {
          if (!artifact.baseHash || artifact.resultHash || artifact.resultResourcePath) {
            throw new Error(`${artifact.path}: Release 资源删除快照无效`);
          }
          continue;
        }
        if (!artifact.resultHash || !artifact.resultResourcePath) {
          throw new Error(`${artifact.path}: Release 资源快照缺失`);
        }
        const result = await hashFileBytes(artifact.resultResourcePath);
        if (result.hash !== artifact.resultHash || result.size !== artifact.size) {
          throw new Error(`${artifact.path}: Release 资源对象校验失败`);
        }
        if (
          (artifact.operation === 'add' && artifact.baseHash !== undefined)
          || (artifact.operation === 'modify' && !artifact.baseHash)
        ) {
          throw new Error(`${artifact.path}: Release 资源基线无效`);
        }
        continue;
      }
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
      const latest = await this.remoteScanner.readFile(api, existing);
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

  private async findRemoteFoldersInDirectory(
    api: FileApi,
    parent: RemoteDirectoryEntry,
    folderName: string,
  ): Promise<TreeNode[]> {
    const payload = requireSuccess(
      await this.remoteScanner.listDirectory(api, parent),
      `读取远端父目录失败: ${parent.path}`,
    );
    return payload.childFolder.filter(folder => folder.name === folderName);
  }

  private async pushResource(
    api: FileApi,
    syncRoot: string,
    manifest: SyncManifest,
    remoteIndex: RemoteIndex,
    remotePath: string,
    localFile: LocalResourceFileState,
    status: SyncChange['status'],
    cancellation?: CancellationLike,
  ): Promise<{
    verified: RemoteFileContent;
    conflict?: undefined;
  } | {
    verified?: undefined;
    conflict: SyncChange;
  }> {
    const parentPath = path.posix.dirname(remotePath);
    const isKnownResourceDirectory = [...remoteIndex.resourceRoots].some(root =>
      isPathAtOrBelow(parentPath, root));
    if (!isKnownResourceDirectory) {
      throw new Error(`新增资源只能位于远端确认的资源目录中: ${remotePath}`);
    }
    const parent = remoteIndex.directories.get(parentPath);
    if (!parent) {
      throw new Error(`目标资源目录不存在: ${parentPath}`);
    }
    const currentLocal = await hashFileBytes(localFile.sourcePath);
    if (currentLocal.hash !== localFile.hash || currentLocal.size !== localFile.size) {
      throw new Error('本地资源在推送前发生变化，请刷新后重试');
    }

    let existing = remoteIndex.files.get(remotePath);
    if (status === 'localAdded' && existing) {
      const latest = await this.remoteScanner.readFile(api, existing);
      try {
        if (latest.hash === localFile.hash && latest.size === localFile.size) {
          await this.setBaseline(syncRoot, manifest, latest);
          await this.store.deleteConflict(syncRoot, remotePath);
          await this.store.saveManifest(manifest);
          return { verified: latest };
        }
        await this.saveRemoteConflict(syncRoot, latest, 'initialCollision');
        return {
          conflict: {
            path: remotePath,
            status: 'conflict',
            kind: 'resource',
            remoteId: existing.id,
            localHash: localFile.hash,
            remoteHash: latest.hash,
            localSize: localFile.size,
            remoteSize: latest.size,
            conflictReason: 'initialCollision',
            message: '远端已存在同路径资源',
          },
        };
      } finally {
        await this.cleanupRemoteStaging(latest);
      }
    }

    const baseline = manifest.files[remotePath];
    let restoreSnapshot: string | undefined;
    let recoveryPath: string | undefined;
    if (status === 'localModified') {
      if (!existing || !baseline || baseline.kind !== 'resource') {
        return {
          conflict: {
            path: remotePath,
            status: 'conflict',
            kind: 'resource',
            remoteId: baseline?.remoteId,
            baselineHash: baseline?.baselineHash,
            localHash: localFile.hash,
            localSize: localFile.size,
            conflictReason: 'remoteDeletedLocalModified',
            message: '远端资源已删除，同时本地已修改',
          },
        };
      }
      if (existing.id !== baseline.remoteId) {
        await this.recordPushConflict(
          syncRoot,
          api,
          remotePath,
          existing,
          'remotePathCollision',
        );
        return {
          conflict: {
            path: remotePath,
            status: 'conflict',
            kind: 'resource',
            remoteId: existing.id,
            baselineHash: baseline.baselineHash,
            localHash: localFile.hash,
            localSize: localFile.size,
            conflictReason: 'remotePathCollision',
            message: '远端同路径资源标识已变化',
          },
        };
      }
      const latest = await this.remoteScanner.readFile(api, existing);
      try {
        if (!isRemoteResource(latest)) {
          throw new Error(`远端路径不再是资源: ${remotePath}`);
        }
        if (latest.hash !== baseline.baselineHash) {
          if (latest.hash === localFile.hash && latest.size === localFile.size) {
            await this.setBaseline(syncRoot, manifest, latest);
            await this.store.deleteConflict(syncRoot, remotePath);
            await this.store.saveManifest(manifest);
            return { verified: latest };
          }
          await this.saveRemoteConflict(syncRoot, latest, 'bothModified');
          return {
            conflict: {
              path: remotePath,
              status: 'conflict',
              kind: 'resource',
              remoteId: existing.id,
              baselineHash: baseline.baselineHash,
              localHash: localFile.hash,
              remoteHash: latest.hash,
              localSize: localFile.size,
              remoteSize: latest.size,
              conflictReason: 'bothModified',
              message: '本地和远端资源均已修改',
            },
          };
        }
        const snapshotKey = await this.store.saveResourceSnapshot(
          syncRoot,
          latest.sourcePath,
          latest.hash,
        );
        restoreSnapshot = await this.store.getSnapshotPath(
          syncRoot,
          snapshotKey,
          'resource',
        );
        recoveryPath = await this.store.saveResourceRecovery(
          syncRoot,
          remotePath,
          latest.sourcePath,
        );
      } finally {
        await this.cleanupRemoteStaging(latest);
      }
    }

    this.throwIfCancelled(cancellation);
    let destructive = false;
    try {
      if (status === 'localModified') {
        const deletion = await api.deleteResource(existing!.id);
        if (!deletion.status && !isUnauthorized(deletion.code)) {
          const afterDelete = await this.findRemoteFileInDirectory(
            api,
            parent,
            path.posix.basename(remotePath),
            remotePath,
            'resource',
          );
          destructive = !afterDelete;
        }
        this.requireMutationSuccess(deletion, `删除旧资源失败: ${remotePath}`);
        destructive = true;
        existing = undefined;
      }
      this.requireMutationSuccess(
        await api.uploadResource(
          localFile.sourcePath,
          parent.id,
          path.posix.basename(remotePath),
        ),
        `上传资源失败: ${remotePath}`,
      );
      const uploadedEntry = await this.findRemoteFileInDirectory(
        api,
        parent,
        path.posix.basename(remotePath),
        remotePath,
        'resource',
      );
      if (!uploadedEntry) {
        throw new Error('上传后无法在资源目录中找到该文件');
      }
      const verified = await this.remoteScanner.readFile(api, uploadedEntry);
      try {
        if (verified.hash !== localFile.hash || verified.size !== localFile.size) {
          throw new Error('上传后资源大小或 SHA-256 校验不一致');
        }
        await this.setBaseline(syncRoot, manifest, verified);
        await this.store.deleteConflict(syncRoot, remotePath);
        await this.store.saveManifest(manifest);
        return { verified };
      } finally {
        await this.cleanupRemoteStaging(verified);
      }
    } catch (error: unknown) {
      if (!destructive || !restoreSnapshot) {
        throw error;
      }
      try {
        const failedEntry = await this.findRemoteFileInDirectory(
          api,
          parent,
          path.posix.basename(remotePath),
          remotePath,
          'resource',
        );
        if (failedEntry) {
          this.requireMutationSuccess(
            await api.deleteResource(failedEntry.id),
            `清理失败资源产物失败: ${remotePath}`,
          );
        }
        this.requireMutationSuccess(
          await api.uploadResource(
            restoreSnapshot,
            parent.id,
            path.posix.basename(remotePath),
          ),
          `恢复旧资源失败: ${remotePath}`,
        );
        const restoredEntry = await this.findRemoteFileInDirectory(
          api,
          parent,
          path.posix.basename(remotePath),
          remotePath,
          'resource',
        );
        if (!restoredEntry) {
          throw new Error('恢复上传后未找到旧资源');
        }
        const restored = await this.remoteScanner.readFile(api, restoredEntry);
        try {
          if (restored.hash !== baseline?.baselineHash) {
            throw new Error('恢复后的资源 SHA-256 与同步基线不一致');
          }
        } finally {
          await this.cleanupRemoteStaging(restored);
        }
        throw new Error(`资源替换失败，远端旧版本已恢复: ${errorMessage(error)}`);
      } catch (rollbackError: unknown) {
        if (errorMessage(rollbackError).startsWith('资源替换失败，远端旧版本已恢复')) {
          throw rollbackError;
        }
        throw new Error(
          `资源替换失败且自动恢复失败: ${errorMessage(error)}；`
          + `恢复错误: ${errorMessage(rollbackError)}；恢复快照: ${recoveryPath ?? restoreSnapshot}；`
          + '请人工检查远端资源目录',
        );
      }
    }
  }

  private async findRemoteFileInDirectory(
    api: FileApi,
    parent: RemoteDirectoryEntry,
    fileName: string,
    remotePath: string,
    kind: 'text' | 'resource' = 'text',
  ): Promise<RemoteFileEntry | undefined> {
    const payload = requireSuccess(
      await this.remoteScanner.listDirectory(api, parent),
      `读取远端父目录失败: ${parent.path}`,
    );
    const matches = (kind === 'resource' ? payload.resources : payload.childFile)
      .filter(file => file.name === fileName);
    if (matches.length > 1) {
      throw new Error(`远端父目录包含多个同名文件: ${remotePath}`);
    }
    return matches[0]
      ? {
          id: matches[0].id,
          path: remotePath,
          name: matches[0].name,
          kind,
          route: matches[0].route,
          parentId: parent.id,
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
        latest = await this.remoteScanner.readFile(api, entry);
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
      [...remote.files.values()]
        .filter((file): file is Extract<RemoteFileContent, { entry: { kind: 'text' } }> =>
          file.entry.kind === 'text')
        .map(file => ({
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

  private async setBaseline(
    syncRoot: string,
    manifest: SyncManifest,
    remote: RemoteFileContent,
  ): Promise<void> {
    const snapshotKey = isRemoteResource(remote)
      ? await this.store.saveResourceSnapshot(syncRoot, remote.sourcePath, remote.hash)
      : await this.store.saveSnapshot(syncRoot, remote.content);
    const entry: ManifestEntry = {
      remoteId: remote.entry.id,
      path: remote.entry.path,
      kind: remote.entry.kind,
      size: remote.size,
      baselineHash: remote.hash,
      snapshotKey,
      lastVerifiedAt: new Date().toISOString(),
    };
    manifest.files[remote.entry.path] = entry;
  }

  private async cleanupRemoteStaging(
    remote: RemoteFileContent | undefined,
  ): Promise<void> {
    if (remote && isRemoteResource(remote)) {
      await this.remoteScanner.cleanupStaging(remote.stagingRoot);
    }
  }

  private async saveRemoteCatalog(
    syncRoot: string,
    fingerprint: string,
    remote: Pick<RemoteIndex, 'tree' | 'apps'>,
  ): Promise<void> {
    const capturedAt = new Date().toISOString();
    await this.store.saveRemoteCatalog(
      {
        schemaVersion: 1,
        serverFingerprint: fingerprint,
        syncRoot,
        capturedAt,
        roots: remote.tree,
      },
      {
        schemaVersion: 1,
        serverFingerprint: fingerprint,
        syncRoot,
        capturedAt,
        apps: remote.apps,
      },
    );
  }

  private async saveLocalRecovery(
    syncRoot: string,
    remotePath: string,
    local: LocalFileState,
  ): Promise<string> {
    return local.kind === 'resource'
      ? this.store.saveResourceRecovery(syncRoot, remotePath, local.sourcePath)
      : this.store.saveRecovery(syncRoot, remotePath, local.content);
  }

  private async writeRemoteToLocal(
    syncRoot: string,
    localPath: string,
    remote: RemoteFileContent,
  ): Promise<void> {
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    if (isRemoteResource(remote)) {
      await copyFileAtomic(localPath, remote.sourcePath);
      const verified = await hashFileBytes(localPath);
      if (verified.hash !== remote.hash || verified.size !== remote.size) {
        throw new Error(`资源落盘校验失败: ${remote.entry.path}`);
      }
      return;
    }
    await fs.writeFile(localPath, remote.content, 'utf8');
  }

  private async saveRemoteConflict(
    syncRoot: string,
    remote: RemoteFileContent,
    reason: StoredConflict['reason'],
  ): Promise<void> {
    const remoteSnapshotKey = isRemoteResource(remote)
      ? await this.store.saveResourceSnapshot(syncRoot, remote.sourcePath, remote.hash)
      : undefined;
    await this.store.saveConflict(syncRoot, {
      schemaVersion: 2,
      path: remote.entry.path,
      remoteId: remote.entry.id,
      kind: remote.entry.kind,
      remoteContent: isRemoteText(remote) ? remote.content : undefined,
      remoteSnapshotKey,
      remoteSize: remote.size,
      remoteHash: remote.hash,
      detectedAt: new Date().toISOString(),
      reason,
    });
  }

  private async recordPushConflict(
    syncRoot: string,
    api: FileApi,
    remotePath: string,
    entry: RemoteFileEntry,
    reason: StoredConflict['reason'],
  ): Promise<void> {
    const latest = await this.remoteScanner.readFile(api, entry);
    await this.saveRemoteConflict(syncRoot, latest, reason);
    await this.cleanupRemoteStaging(latest);
    this.lastRemoteFiles.set(remotePath, latest);
    this.output.warn(`Push blocked by conflict: ${remotePath}`);
  }

  private async saveRemoteDeletionConflict(
    syncRoot: string,
    manifest: SyncManifest,
    remotePath: string,
  ): Promise<void> {
    const baseline = manifest.files[remotePath];
    if (!baseline) {
      return;
    }
    await this.store.saveConflict(syncRoot, {
      schemaVersion: 2,
      path: remotePath,
      remoteId: baseline.remoteId,
      kind: baseline.kind,
      remoteContent: '',
      remoteSize: 0,
      remoteHash: '',
      detectedAt: new Date().toISOString(),
      reason: 'remoteDeletedLocalModified',
      remoteDeleted: true,
    });
  }

  private async mergeStoredConflicts(
    syncRoot: string,
    manifest: SyncManifest,
    localFiles: Map<string, LocalFileState>,
    changes: SyncChange[],
  ): Promise<SyncChange[]> {
    const merged = new Map(changes.map(change => [change.path, change]));
    for (const conflict of await this.store.listConflicts(syncRoot)) {
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
            kind: baseline.kind,
            localSize: local.size,
            conflictReason: 'remoteDeletedLocalModified',
            message: conflictMessage('remoteDeletedLocalModified'),
          });
        } else {
          await this.store.deleteConflict(syncRoot, conflict.path);
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
          kind: conflict.kind ?? baseline?.kind ?? local?.kind ?? 'text',
          localSize: local?.size,
          remoteSize: conflict.remoteSize,
          conflictReason: conflict.reason,
          message: conflictMessage(conflict.reason),
        });
        if (conflict.kind !== 'resource') {
          this.lastRemoteFiles.set(conflict.path, {
          entry: {
            id: conflict.remoteId,
            path: conflict.path,
            name: path.posix.basename(conflict.path),
            kind: 'text',
          },
          content: conflict.remoteContent ?? '',
          hash: conflict.remoteHash,
          size: conflict.remoteSize ?? textByteSize(conflict.remoteContent ?? ''),
          formMetadataState: 'absent',
          formContexts: [],
          formMetadataWarnings: [],
          });
        }
      }
    }
    return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  private async requireCurrentConflict(
    profile: ConnectionProfile,
    syncRoot: string,
    remotePath: string,
  ): Promise<{ conflict: StoredConflict; latest: RemoteFileContent }> {
    const stored = await this.store.loadConflict(syncRoot, remotePath);
    if (!stored) {
      throw new Error('未找到可处理的冲突记录，请先重新拉取');
    }
    if (stored.remoteDeleted) {
      throw new Error('该冲突表示远端文件已删除，请选择删除冲突处理方式');
    }
    const latest = await this.withAuthentication(profile, async api => {
      const entry = (await this.remoteScanner.listIndex(api)).files.get(remotePath);
      if (!entry || entry.id !== stored.remoteId) {
        throw new Error('远端冲突文件标识已变化，请重新拉取');
      }
      return this.remoteScanner.readFile(api, entry);
    });
    if (latest.hash !== stored.remoteHash) {
      await this.saveRemoteConflict(syncRoot, latest, stored.reason);
      await this.cleanupRemoteStaging(latest);
      throw new Error('远端在冲突处理期间再次变化，请重新查看差异');
    }
    return { conflict: stored, latest };
  }

  private async requireRemoteDeletionConflict(
    profile: ConnectionProfile,
    syncRoot: string,
    remotePath: string,
  ): Promise<StoredConflict> {
    const stored = await this.store.loadConflict(syncRoot, remotePath);
    if (
      !stored
      || !stored.remoteDeleted
      || stored.reason !== 'remoteDeletedLocalModified'
    ) {
      throw new Error('未找到远端删除冲突记录，请先重新拉取');
    }
    const existing = await this.withAuthentication(profile, async api =>
      (await this.remoteScanner.listIndex(api)).files.get(remotePath),
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

function isAmbiguousMutationFailure(response: ApiResponse<unknown>): boolean {
  const numericCode = typeof response.code === 'number'
    ? response.code
    : typeof response.code === 'string' && /^-?\d+$/.test(response.code)
      ? Number(response.code)
      : undefined;
  return numericCode === -1 || (numericCode !== undefined && numericCode >= 500);
}

function findRemotePathCollision(
  index: RemoteIndex,
  remotePath: string,
): SyncChange | undefined {
  const exact = index.pathCollisions.find(change =>
    remotePathKey(change.path) === remotePathKey(remotePath));
  if (exact) {
    return exact;
  }
  const ambiguousDirectory = [...index.ambiguousDirectories].find(directory =>
    isDescendantPath(remotePathKey(remotePath), remotePathKey(directory)));
  if (!ambiguousDirectory) {
    return undefined;
  }
  return index.pathCollisions.find(change =>
    remotePathKey(change.path) === remotePathKey(ambiguousDirectory))
    ?? {
      path: ambiguousDirectory,
      status: 'unsupported',
      conflictReason: 'remotePathCollision',
      message: `远端目录路径存在歧义，无法安全写入子树: ${ambiguousDirectory}`,
    };
}

function isDescendantPath(remotePath: string, directoryPath: string): boolean {
  return remotePath.startsWith(`${directoryPath}/`);
}

function formatFileSummary(
  label: string,
  remotePath: string,
  kind: 'text' | 'resource',
  size: number | undefined,
  hash: string | undefined,
  exists: boolean,
): string {
  return [
    `${label}二进制资源摘要`,
    '',
    `路径: ${remotePath}`,
    `扩展名: ${path.posix.extname(remotePath) || '(无)'}`,
    `类型: ${kind}`,
    `存在: ${exists ? '是' : '否'}`,
    `大小: ${size === undefined ? '(未知)' : `${size} bytes`}`,
    `SHA-256: ${hash ?? '(无)'}`,
    '',
    '二进制资源不执行文本 Diff。',
  ].join('\n');
}

function isRemoteResource(
  remote: RemoteFileContent,
): remote is RemoteResourceFileContent {
  return remote.entry.kind === 'resource';
}

function isRemoteText(remote: RemoteFileContent): remote is RemoteTextFileContent {
  return remote.entry.kind === 'text';
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

function releasePromotionCandidate(
  artifact: ReleaseArtifact,
  previousRemote: RemoteFileContent | undefined,
  previousResourcePath?: string,
): PromotionCandidate {
  const hasResult = artifact.operation !== 'delete';
  return {
    path: artifact.path,
    operation: previousRemote
      ? hasResult ? 'modify' : 'delete'
      : 'add',
    baseHash: previousRemote?.hash,
    kind: artifact.kind ?? (previousRemote?.entry.kind === 'resource' ? 'resource' : 'text'),
    size: artifact.size ?? previousRemote?.size,
    baseContent: previousRemote && isRemoteText(previousRemote)
      ? previousRemote.content
      : undefined,
    baseResourcePath: previousRemote && isRemoteResource(previousRemote)
      ? previousResourcePath ?? previousRemote.sourcePath
      : undefined,
    resultHash: hasResult ? artifact.resultHash : undefined,
    resultContent: hasResult ? artifact.resultContent : undefined,
    resultResourcePath: hasResult ? artifact.resultResourcePath : undefined,
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
