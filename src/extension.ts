import * as fs from 'fs';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  type AiInvocation,
  type AiInvocationResult,
} from './ai/AiRequest';
import {
  AiRequestController,
  type AiInvocationContext,
} from './ai/AiRequestController';
import { AiSupportService } from './ai/AiSupportService';
import {
  normalizeRemotePath,
  resolveEnvironmentSourceRoot,
  resolveSafeLocalPath,
  validateEnvironmentDirectory,
} from './domain/paths';
import { serverFingerprint } from './domain/text';
import {
  lifecycleChangeLabel,
  lifecycleChangeTransition,
  lifecycleConnectionIdentity,
  normalizePreStateOrder,
} from './domain/lifecycle';
import type {
  ChangeSet,
  DeploymentFileResult,
  DeploymentLifecycleResult,
  DeploymentRecord,
  ConnectionProfile,
  EnvironmentProfile,
  EcodeAppMetadata,
  LifecycleChange,
  LifecycleChangeRecord,
  PromotionCandidate,
  PushRecord,
  SyncChange,
  SyncOperationResult,
} from './domain/types';
import { registerEcodeLanguageFeatures } from './language/EcodeLanguageProvider';
import { WorkspaceComponentRegistry } from './language/WorkspaceComponentRegistry';
import { WorkspaceFormMetadataRegistry } from './language/WorkspaceFormMetadataRegistry';
import { WorkspaceStore } from './storage/WorkspaceStore';
import { PromotionStore } from './storage/PromotionStore';
import { detectLegacyProjects } from './storage/LegacyProjectGuard';
import { EcodeSyncService, SyncCancelledError } from './sync/EcodeSyncService';
import { deployLifecycleChanges } from './sync/LifecycleChangeDeployer';
import {
  EcodeLifecycleService,
  type LifecycleFile,
  type LifecycleFolder,
  type LifecycleSnapshot,
} from './sync/EcodeLifecycleService';
import { AuthManager } from './sync/auth/AuthManager';
import {
  EcodeTreeProvider,
  type EnvironmentTreeState,
} from './ui/EcodeTreeProvider';
import { LifecycleTreeDecorationProvider } from './ui/LifecycleTreeDecorationProvider';
import { WorkspaceChangeDecorationProvider } from './ui/WorkspaceChangeDecorationProvider';
import {
  PROMOTION_DIFF_SCHEME,
  PromotionDiffProvider,
} from './ui/PromotionDiffProvider';
import {
  BASELINE_SCHEME,
  EMPTY_SCHEME,
  LOCAL_SCHEME,
  REMOTE_SCHEME,
  VirtualDocumentProvider,
  virtualUri,
} from './ui/VirtualDocumentProvider';

let output: vscode.LogOutputChannel;

interface PushExecution {
  result: SyncOperationResult;
  record?: PushRecord;
}

type ConfirmationSource = 'vscode' | 'agent';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('Ecode', { log: true });
  const workspaceFolders = vscode.workspace.workspaceFolders
    ?.map(folder => folder.uri.fsPath) ?? [];
  const legacyProjects = await detectLegacyProjects(context, workspaceFolders);
  if (legacyProjects.length > 0) {
    await activateLegacyProjectBlock(context, legacyProjects);
    return;
  }
  const initialWorkspace = workspaceFolders.find(workspaceFolder =>
    fs.existsSync(path.join(
      workspaceFolder,
      '.ecode-local',
      'environments.json',
    ))) ?? workspaceFolders[0];
  const store = new WorkspaceStore(initialWorkspace);
  const auth = new AuthManager(context);
  const service = new EcodeSyncService(store, auth, output);
  await service.cleanupExpiredStaging();
  const lifecycle = new EcodeLifecycleService(store, auth, output);
  const tree = new EcodeTreeProvider();
  const lifecycleTreeDecorations = new LifecycleTreeDecorationProvider();
  const workspaceChangeDecorations = new WorkspaceChangeDecorationProvider();
  const promotionDiff = new PromotionDiffProvider();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const componentRegistry = new WorkspaceComponentRegistry();
  const formMetadataRegistry = new WorkspaceFormMetadataRegistry();
  const extensionVersion = String(context.extension.packageJSON.version ?? 'unknown');
  const aiSupport = new AiSupportService(
    componentRegistry,
    formMetadataRegistry,
    extensionVersion,
    output,
    context.extensionUri.fsPath,
  );
  const controller = new ExtensionController(
    store,
    auth,
    service,
    lifecycle,
    workspaceChangeDecorations,
    tree,
    status,
    componentRegistry,
    formMetadataRegistry,
    aiSupport,
    promotionDiff,
  );
  tree.setLifecycleRefreshHandler(() =>
    controller.scheduleLifecycleDecorationRefresh());

  context.subscriptions.push(
    output,
    status,
    componentRegistry,
    formMetadataRegistry,
    workspaceChangeDecorations,
    controller,
    vscode.window.registerTreeDataProvider('ecode.workspace', tree),
    vscode.window.registerFileDecorationProvider(lifecycleTreeDecorations),
    vscode.window.registerFileDecorationProvider(workspaceChangeDecorations),
    vscode.workspace.registerTextDocumentContentProvider(
      BASELINE_SCHEME,
      new VirtualDocumentProvider(BASELINE_SCHEME, service),
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      REMOTE_SCHEME,
      new VirtualDocumentProvider(REMOTE_SCHEME, service),
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      LOCAL_SCHEME,
      new VirtualDocumentProvider(LOCAL_SCHEME, service),
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      EMPTY_SCHEME,
      new VirtualDocumentProvider(EMPTY_SCHEME, service),
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      PROMOTION_DIFF_SCHEME,
      promotionDiff,
    ),
    ...registerEcodeLanguageFeatures(componentRegistry, formMetadataRegistry),
    ...controller.registerCommands(),
  );

  await controller.initialize();
  output.info(`Ecode Local ${extensionVersion} activated without network access`);
}

export function deactivate(): void {
  // 没有后台任务或自动同步需要清理。
}

async function activateLegacyProjectBlock(
  context: vscode.ExtensionContext,
  projects: Awaited<ReturnType<typeof detectLegacyProjects>>,
): Promise<void> {
  const details = projects.map(project =>
    `${project.workspaceFolder}: ${project.reasons.join('、')}`).join('\n');
  const message = 'Ecode Local 0.6 不允许直接用于 0.5 及以下版本项目。'
    + '请先使用旧版扩展处理并备份项目，再清理旧版项目痕迹，重新打开目录后配置环境并全量拉取。';
  output.error(`${message}\n${details}`);
  const commands = (
    context.extension.packageJSON.contributes?.commands as
      | Array<{ command?: unknown }>
      | undefined
  ) ?? [];
  context.subscriptions.push(
    output,
    ...commands
      .map(item => typeof item.command === 'string' ? item.command : undefined)
      .filter((command): command is string => Boolean(command))
      .map(command => vscode.commands.registerCommand(command, async () => {
        await vscode.window.showErrorMessage(message, { modal: true });
      })),
  );
  const action = await vscode.window.showErrorMessage(
    message,
    { modal: true, detail: details },
    '打开升级说明',
  );
  if (action === '打开升级说明') {
    await vscode.commands.executeCommand(
      'markdown.showPreview',
      vscode.Uri.joinPath(context.extensionUri, 'README.md'),
    );
  }
}

class ExtensionController {
  private busy = false;
  private changes: SyncChange[] = [];
  private localWatcher: vscode.Disposable | undefined;
  private readonly aiRequests: AiRequestController;
  private localRefreshTimer: NodeJS.Timeout | undefined;
  private aiRefreshTimer: NodeJS.Timeout | undefined;
  private lastAiSupportError: string | undefined;
  private activeAiInvocations = 0;
  private lifecycleDecorationRefresh: Promise<void> | undefined;
  private lifecycleSnapshot: LifecycleSnapshot | undefined;
  private lifecycleSnapshotSourceRoot: string | undefined;
  private lifecycleSnapshotIdentity: string | undefined;
  private lifecycleSnapshotFresh = false;

  constructor(
    private readonly store: WorkspaceStore,
    private readonly auth: AuthManager,
    private readonly service: EcodeSyncService,
    private readonly lifecycle: EcodeLifecycleService,
    private readonly workspaceChangeDecorations: WorkspaceChangeDecorationProvider,
    private readonly tree: EcodeTreeProvider,
    private readonly status: vscode.StatusBarItem,
    private readonly componentRegistry: WorkspaceComponentRegistry,
    private readonly formMetadataRegistry: WorkspaceFormMetadataRegistry,
    private readonly aiSupport: AiSupportService,
    private readonly promotionDiff: PromotionDiffProvider,
  ) {
    this.aiRequests = new AiRequestController(
      output,
      (invocation, invocationContext) =>
        this.executeAiInvocation(invocation, invocationContext),
    );
  }

  registerCommands(): vscode.Disposable[] {
    return [
      vscode.commands.registerCommand('ecode.configure', () => this.configure()),
      vscode.commands.registerCommand('ecode.setup', () => this.configure()),
      vscode.commands.registerCommand('ecode.addEnvironment', () => this.configure(true)),
      vscode.commands.registerCommand('ecode.switchEnvironment', () =>
        this.runCommandSafely(() => this.switchEnvironment())),
      vscode.commands.registerCommand('ecode.deleteEnvironment', (argument?: unknown) =>
        this.runCommandSafely(() => this.deleteEnvironment(argument))),
      vscode.commands.registerCommand('ecode.pull', () => this.pull()),
      vscode.commands.registerCommand('ecode.refreshChanges', () => this.refreshChanges()),
      vscode.commands.registerCommand('ecode.pushSelected', () =>
        this.runCommandSafely(() => this.pushSelected())),
      vscode.commands.registerCommand('ecode.publishResourceFolder', (argument?: unknown) =>
        this.setResourceFolderRelease(argument, true)),
      vscode.commands.registerCommand('ecode.unpublishResourceFolder', (argument?: unknown) =>
        this.setResourceFolderRelease(argument, false)),
      vscode.commands.registerCommand('ecode.setResourcePreloadOrder', (argument?: unknown) =>
        this.setResourcePreloadOrder(argument)),
      vscode.commands.registerCommand('ecode.enableResourcePreload', (argument?: unknown) =>
        this.setResourcePreload(argument, true)),
      vscode.commands.registerCommand('ecode.disableResourcePreload', (argument?: unknown) =>
        this.setResourcePreload(argument, false)),
      vscode.commands.registerCommand('ecode.refreshLifecycleDecorations', () =>
        this.refreshLifecycleDecorations(true)),
      vscode.commands.registerCommand(
        'ecode.rollbackPushFile',
        (argument: unknown, remotePath?: string) =>
          this.runCommandSafely(() =>
            this.rollbackPushFile(argument, remotePath)),
      ),
      vscode.commands.registerCommand('ecode.renamePushRecord', (argument?: unknown) =>
        this.runCommandSafely(() => this.renamePushRecord(argument))),
      vscode.commands.registerCommand('ecode.deletePushRecord', (argument?: unknown) =>
        this.runCommandSafely(() => this.deletePushRecord(argument))),
      vscode.commands.registerCommand('ecode.deleteLifecycleRecord', (argument?: unknown) =>
        this.runCommandSafely(() => this.deleteLifecycleRecord(argument))),
      vscode.commands.registerCommand('ecode.deleteLifecycleRecords', () =>
        this.runCommandSafely(() => this.deleteLifecycleRecords())),
      vscode.commands.registerCommand(
        'ecode.openPromotionDiff',
        (candidate: PushRecord | ChangeSet, remotePath: string) =>
          this.runCommandSafely(() =>
            this.openPromotionDiff(candidate, remotePath)),
      ),
      vscode.commands.registerCommand('ecode.openDiff', (change: SyncChange) => this.openDiff(change)),
      vscode.commands.registerCommand('ecode.revertChange', (change?: SyncChange) =>
        this.revertChange(change)),
      vscode.commands.registerCommand('ecode.resolveConflict', (change: SyncChange) =>
        this.resolveConflict(change)),
      vscode.commands.registerCommand('ecode.createChangeSet', () =>
        this.runCommandSafely(() => this.createChangeSet())),
      vscode.commands.registerCommand('ecode.applyChangeSet', (argument?: unknown) =>
        this.runCommandSafely(() => this.applyChangeSet(argument))),
      vscode.commands.registerCommand('ecode.deleteChangeSet', (argument?: unknown) =>
        this.runCommandSafely(() => this.deleteChangeSet(argument))),
      vscode.commands.registerCommand('ecode.refreshAiSupport', () =>
        this.refreshAiSupport(true)),
      vscode.commands.registerCommand('ecode.enableAiSupport', () =>
        this.runCommandSafely(() => this.enableAiSupport())),
      vscode.commands.registerCommand('ecode.openAiGuide', () =>
        this.runCommandSafely(() => this.openAiGuide())),
      vscode.commands.registerCommand('ecode.removeAiSupport', () =>
        this.runCommandSafely(() => this.removeAiSupport())),
      this.componentRegistry.onDidChange(() => this.scheduleAiRefresh()),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('ecode.aiSupport.enabled')) {
          this.scheduleAiRefresh();
          void this.updateViews();
        }
      }),
    ];
  }

  private async executeAiInvocation(
    invocation: AiInvocation,
    invocationContext: AiInvocationContext,
  ): Promise<AiInvocationResult> {
    this.activeAiInvocations++;
    try {
      const activeEnvironment = await this.store.getActiveEnvironment();
      if (
        invocationContext.environmentDirectory
        && !['getState', 'getKnowledge', 'configure', 'addEnvironment']
          .includes(invocation.action)
        && activeEnvironment?.directory !== invocationContext.environmentDirectory
      ) {
        return {
          status: 'rejected',
          message: activeEnvironment
            ? `当前活动环境目录为 ${activeEnvironment.directory}，请求绑定的是 `
              + invocationContext.environmentDirectory
            : '当前没有活动环境',
        };
      }
      if (
        this.busy
        && ![
          'getState',
          'listPushRecords',
          'listLifecycleRecords',
          'listChangeSets',
          'getKnowledge',
        ].includes(invocation.action)
      ) {
        return { status: 'failed', message: '已有同步操作正在执行，请稍后使用新请求重试' };
      }

      switch (invocation.action) {
        case 'getState':
          return { status: 'succeeded', data: await this.getAiState() };
        case 'getLifecycleState':
          return { status: 'succeeded', data: await this.readLifecycleSnapshot() };
        case 'refreshChanges':
          return {
            status: 'succeeded',
            data: await this.runExclusive('正在刷新本地与远端变更...', async () => {
              this.changes = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Ecode: 刷新本地与远端变更',
                cancellable: true,
              }, (progress, token) => this.service.refreshChanges(
                message => progress.report({ message }),
                token,
              ));
              return visibleAiChanges(this.changes);
            }),
          };
        case 'listPushRecords':
          return {
            status: 'succeeded',
            data: activeEnvironment
              ? await this.promotionStore(activeEnvironment.workspaceFolder)
                .listPushRecords(activeEnvironment.id)
              : [],
          };
        case 'listLifecycleRecords':
          return {
            status: 'succeeded',
            data: activeEnvironment
              ? await this.promotionStore(activeEnvironment.workspaceFolder)
                .listLifecycleRecords(activeEnvironment.id)
              : [],
          };
        case 'listChangeSets':
          return {
            status: 'succeeded',
            data: activeEnvironment
              ? await this.promotionStore(activeEnvironment.workspaceFolder).listChangeSets()
              : [],
          };
        case 'getKnowledge':
          return { status: 'succeeded', data: await this.getAiKnowledge() };
        case 'configure':
          return confirmedOperationResult(
            await this.configure(),
            '环境配置已保存',
            '用户取消了环境配置',
          );
        case 'addEnvironment':
          return confirmedOperationResult(
            await this.configure(true),
            '新环境已保存',
            '用户取消了新增环境',
          );
        case 'switchEnvironment':
          return this.switchEnvironmentById(invocation.environmentId!);
        case 'deleteEnvironment':
          return this.deleteEnvironmentById(invocation.environmentId!);
        case 'pull':
          return confirmedOperationResult(
            await this.pull(),
            '拉取已完成，请重新查询状态确认结果',
            '拉取未完成',
          );
        case 'push':
          return this.pushFromAi(invocation.paths!);
        case 'setPreload':
          return this.runVerifiedLifecycleMutation(
            '正在更新前置加载状态...',
            invocation.enabled! ? '设置前置加载' : '取消前置加载',
            () => this.lifecycle.setFilePreloadedByPath(
              invocation.path!,
              invocation.enabled!,
            ),
            result => this.recordLifecyclePreload(
              result.path,
              result.enabled,
              result.previous,
              result.changed,
            ),
          );
        case 'setFolderRelease':
          return this.runVerifiedLifecycleMutation(
            '正在更新文件夹发布状态...',
            invocation.enabled! ? '发布文件夹' : '取消发布',
            () => this.lifecycle.setFolderReleasedByPath(
              invocation.path!,
              invocation.enabled!,
            ),
            result => this.recordLifecycleRelease(
              result.path,
              result.enabled,
              result.previous,
              result.changed,
            ),
          );
        case 'setPreloadOrder':
          return this.runVerifiedLifecycleMutation(
            '正在更新前置加载顺序...',
            '设置前置加载顺序',
            () => this.lifecycle.setPreStateOrderByPath(
              invocation.path!,
              invocation.preStateOrder!,
            ),
            result => this.recordLifecyclePreStateOrder(
              result.path,
              result.preStateOrder,
              result.previousPreStateOrder,
              result.changed,
            ),
          );
        case 'rollbackPushFile': {
          const record = await this.requirePushRecord(invocation.pushRecordId!);
          return confirmedOperationResult(
            await this.rollbackPushFile(record, invocation.path, 'agent'),
            '本地回退已完成，请重新查询变更',
            '用户未确认本地回退',
          );
        }
        case 'renamePushRecord': {
          const record = await this.requirePushRecord(invocation.pushRecordId!);
          await this.renamePushRecord(record, invocation.name);
          return {
            status: 'succeeded',
            data: await this.requirePushRecord(invocation.pushRecordId!),
          };
        }
        case 'deletePushRecord': {
          const record = await this.requirePushRecord(invocation.pushRecordId!);
          return confirmedOperationResult(
            await this.deletePushRecord(record, 'agent'),
            '推送记录已删除',
            '用户未确认删除推送记录',
          );
        }
        case 'deleteLifecycleRecord': {
          const record = await this.requireLifecycleRecord(invocation.lifecycleRecordId!);
          return confirmedOperationResult(
            await this.deleteLifecycleRecord(record, 'agent'),
            '生命周期记录已删除',
            '用户未确认删除生命周期记录',
          );
        }
        case 'revertChange': {
          const change = await this.requireChange(invocation.path!);
          return confirmedOperationResult(
            await this.revertChange(change, 'agent'),
            '本地变更已回退，请重新查询变更',
            '用户未确认回退本地变更',
          );
        }
        case 'resolveConflict': {
          const change = await this.requireChange(invocation.path!);
          return confirmedOperationResult(
            await this.resolveConflict(change, invocation.resolution, 'agent'),
            '冲突已处理，请重新查询变更',
            '用户未确认冲突处理',
          );
        }
        case 'createChangeSet': {
          const changeSet = await this.createChangeSetFromIds(
            invocation.pushRecordIds!,
            invocation.lifecycleRecordIds!,
            invocation.name!,
          );
          return { status: 'succeeded', data: changeSet };
        }
        case 'applyChangeSet':
          return changeSetApplicationResult(
            await this.applyChangeSet(
              await this.requireChangeSet(invocation.changeSetId!),
              'agent',
            ),
          );
        case 'deleteChangeSet':
          return confirmedOperationResult(
            await this.deleteChangeSet(
              await this.requireChangeSet(invocation.changeSetId!),
              'agent',
            ),
            '变更集已删除',
            '用户未确认删除变更集',
          );
      }
    } catch (error: unknown) {
      if (error instanceof SyncCancelledError) {
        return { status: 'cancelled', message: '操作已取消' };
      }
      const message = errorMessage(error);
      output.error(`AI ${invocation.action} failed: ${message}`);
      return { status: 'failed', message };
    } finally {
      this.activeAiInvocations--;
    }
  }

  private async getAiState(): Promise<unknown> {
    const [profile, activeEnvironment, environments] = await Promise.all([
      this.store.getProfile(),
      this.store.getActiveEnvironment(),
      this.store.getEnvironments(),
    ]);
    return {
      busy: this.busy,
      configured: Boolean(profile && activeEnvironment),
      activeEnvironment,
      environments,
      hasSyncBaseline: profile ? await this.service.hasSyncBaseline() : false,
      changeCounts: countChanges(this.changes),
      changes: visibleAiChanges(this.changes),
    };
  }

  private async getAiKnowledge(): Promise<unknown> {
    const profile = await this.store.getProfile();
    const workspaceFolder = profile?.workspaceFolder ?? this.store.getWorkspaceFolder();
    if (!workspaceFolder) {
      return { enabled: false, message: '当前没有工作区' };
    }
    const guide = this.aiSupport.guideUri(workspaceFolder).fsPath;
    return {
      enabled: this.aiSupport.isEnabled(workspaceFolder),
      configured: Boolean(profile),
      guide: fs.existsSync(guide) ? guide : undefined,
      skill: this.aiSupport.skillUri(workspaceFolder).fsPath,
      cli: this.aiSupport.cliUri(workspaceFolder).fsPath,
      environmentDirectory: profile?.environmentDirectory,
    };
  }

  private async switchEnvironmentById(
    environmentId: string,
  ): Promise<AiInvocationResult> {
    if (this.busy) {
      return { status: 'failed', message: '已有同步操作正在执行' };
    }
    const environment = await this.store.getEnvironment(environmentId);
    if (!environment) {
      return { status: 'rejected', message: `环境不存在：${environmentId}` };
    }
    const current = await this.store.getActiveEnvironment();
    if (current?.id === environment.id) {
      return {
        status: 'succeeded',
        environmentDirectory: environment.directory,
        data: environment,
        message: '目标环境已是活动环境',
      };
    }
    const selected = await this.store.setActiveEnvironment(environment.id);
    const profile = toConnectionProfile(selected);
    this.activateWorkspaceContext(profile);
    await this.refreshWorkspaceContext(profile);
    await this.updateViews();
    return {
      status: 'succeeded',
      environmentDirectory: selected.directory,
      data: selected,
    };
  }

  private async deleteEnvironmentById(
    environmentId: string,
  ): Promise<AiInvocationResult> {
    const environment = await this.store.getEnvironment(environmentId);
    if (!environment) {
      return { status: 'rejected', message: `环境不存在：${environmentId}` };
    }
    const result = await this.deleteEnvironment(environment, 'agent');
    const activeEnvironment = await this.store.getActiveEnvironment();
    return result
      ? {
          status: 'succeeded',
          environmentDirectory: activeEnvironment?.directory,
          data: {
            deletedEnvironment: environment,
            activeEnvironment,
          },
          message: '环境配置、源码目录和本地环境数据已删除',
        }
      : { status: 'cancelled', message: '环境未删除' };
  }

  private async pushFromAi(
    paths: string[],
  ): Promise<AiInvocationResult> {
    const [profile, environment] = await Promise.all([
      this.store.getProfile(),
      this.store.getActiveEnvironment(),
    ]);
    if (!profile || !environment) {
      return { status: 'rejected', message: '当前没有活动环境' };
    }
    if (this.busy) {
      return { status: 'failed', message: '已有同步操作正在执行' };
    }
    if (!await this.service.hasSyncBaseline()) {
      return { status: 'rejected', message: '当前环境尚未建立同步基线，请先执行全量拉取' };
    }
    this.changes = await this.service.refreshLocalChanges();
    const pushable = new Set(
      this.changes.filter(isPushableChange).map(change => change.path),
    );
    const unavailable = paths.filter(item => !pushable.has(item));
    if (unavailable.length > 0) {
      return {
        status: 'rejected',
        message: `以下路径不是当前可推送的本地变更：${unavailable.join('、')}`,
      };
    }
    const candidates = await this.service.preparePromotionCandidates(paths);
    const execution = await this.executePush(profile, environment, paths, candidates);
    if (!execution) {
      return { status: 'failed', message: '推送未完成，详情见 Ecode Output' };
    }
    showResult('AI 推送', execution.result);
    return {
      status: execution.result.success && execution.record?.status === 'succeeded'
        ? 'succeeded'
        : execution.record ? 'partial' : 'failed',
      data: {
        pushRecord: execution.record,
        result: execution.result,
      },
      message: execution.record
        ? `已保存推送记录“${execution.record.name}”（${execution.record.id}）`
        : '没有文件通过推送后回读验证',
    };
  }

  private async requirePushRecord(id: string): Promise<PushRecord> {
    const environment = await this.store.getActiveEnvironment();
    if (!environment) {
      throw new Error('当前没有活动环境');
    }
    const record = (await this.promotionStore(environment.workspaceFolder)
      .listPushRecords()).find(item => item.id === id);
    if (!record) {
      throw new Error(`推送记录不存在：${id}`);
    }
    return record;
  }

  private async requireLifecycleRecord(id: string): Promise<LifecycleChangeRecord> {
    const environment = await this.store.getActiveEnvironment();
    if (!environment) {
      throw new Error('当前没有活动环境');
    }
    const record = (await this.promotionStore(environment.workspaceFolder)
      .listLifecycleRecords(environment.id)).find(item => item.id === id);
    if (!record) {
      throw new Error(`生命周期记录不存在：${id}`);
    }
    return record;
  }

  private async requireChangeSet(id: string): Promise<ChangeSet> {
    const environment = await this.store.getActiveEnvironment();
    if (!environment) {
      throw new Error('当前没有活动环境');
    }
    const changeSet = await this.promotionStore(environment.workspaceFolder).getChangeSet(id);
    if (!changeSet) {
      throw new Error(`变更集不存在：${id}`);
    }
    return changeSet;
  }

  private async requireChange(remotePath: string): Promise<SyncChange> {
    this.changes = await this.service.refreshLocalChanges();
    const change = this.changes.find(item => item.path === remotePath);
    if (!change) {
      throw new Error(`当前同步计划中不存在路径：${remotePath}`);
    }
    return change;
  }

  private async createChangeSetFromIds(
    pushRecordIds: string[],
    lifecycleRecordIds: string[],
    name: string,
  ): Promise<ChangeSet> {
    const source = await this.store.getActiveEnvironment();
    if (!source) {
      throw new Error('请先配置并激活源环境');
    }
    if (!await this.service.hasSyncBaseline()) {
      throw new Error('当前源环境尚未建立同步基线，请先执行全量拉取');
    }
    const promotionStore = this.promotionStore(source.workspaceFolder);
    const [availablePushes, availableLifecycle] = await Promise.all([
      promotionStore.listPushRecords(source.id),
      promotionStore.listLifecycleRecords(source.id),
    ]);
    const selected = pushRecordIds.map(id => {
      const record = availablePushes.find(item => item.id === id);
      if (!record) {
        throw new Error(`当前环境中不存在推送记录：${id}`);
      }
      return record;
    }).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const selectedLifecycle = lifecycleRecordIds.map(id => {
      const record = availableLifecycle.find(item => item.id === id);
      if (!record) {
        throw new Error(`当前环境中不存在生命周期记录：${id}`);
      }
      return record;
    }).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    if (selected.length === 0 && selectedLifecycle.length === 0) {
      throw new Error('至少选择一条推送记录或生命周期记录');
    }
    const changeSet = await promotionStore.createChangeSet(name, source.id);
    let updated = changeSet;
    try {
      for (const record of selected) {
        updated = await promotionStore.recordVerifiedCandidates(
          changeSet.id,
          await promotionStore.materializePushRecord(record),
        );
      }
      if (selectedLifecycle.length > 0) {
        updated = await promotionStore.recordLifecycleChanges(
          changeSet.id,
          selectedLifecycle.map(record => record.change),
        );
      }
      if (
        Object.keys(updated.files).length === 0
        && Object.keys(updated.lifecycleChanges ?? {}).length === 0
      ) {
        throw new Error('所选记录折叠后没有可应用的净变化');
      }
    } catch (error: unknown) {
      await promotionStore.deleteChangeSet(changeSet.id);
      throw error;
    }
    await this.updateViews();
    return updated;
  }

  async initialize(): Promise<void> {
    const profile = await this.store.getProfile();
    const workspaceFolder = profile?.workspaceFolder ?? this.store.getWorkspaceFolder();
    if (workspaceFolder) {
      this.aiRequests.configure(workspaceFolder);
    }
    await this.formMetadataRegistry.reload(profile, this.store);
    if (profile) {
      try {
        this.changes = await this.service.refreshLocalChanges();
      } catch (error: unknown) {
        output.warn(`Initial local scan failed: ${errorMessage(error)}`);
      }
      this.configureLocalWatcher(profile);
      await this.refreshAiSupport(false);
    }
    await this.updateViews();
  }

  dispose(): void {
    this.localWatcher?.dispose();
    this.localWatcher = undefined;
    this.aiRequests.dispose();
    if (this.localRefreshTimer) {
      clearTimeout(this.localRefreshTimer);
      this.localRefreshTimer = undefined;
    }
    if (this.aiRefreshTimer) {
      clearTimeout(this.aiRefreshTimer);
      this.aiRefreshTimer = undefined;
    }
  }

  private async configure(createNew = false): Promise<boolean> {
    if (this.busy) {
      return false;
    }
    const workspaceFolder = await selectWorkspaceFolder();
    if (!workspaceFolder) {
      return false;
    }
    // 配置期间使用独立 Store，只有环境成功保存并需要激活时才切换控制器上下文。
    // 这样在多根工作区中取消任一步骤，都不会让现有 Watcher 与 Store 指向不同目录。
    const configurationStore = new WorkspaceStore(workspaceFolder.uri.fsPath);

    const currentEnvironment = await configurationStore.getActiveEnvironment();
    const activeEnvironment = createNew
      ? undefined
      : currentEnvironment;
    const previous = activeEnvironment
      ?? currentEnvironment;
    const configuredEnvironments = await configurationStore.getEnvironments();
    const environmentName = await vscode.window.showInputBox({
      title: '配置 Ecode 环境 (1/5)',
      prompt: '环境名称',
      value: activeEnvironment?.name ?? '',
      placeHolder: '例如：开发环境、预发布环境',
      ignoreFocusOut: true,
      validateInput: value => validateEnvironmentName(
        value,
        configuredEnvironments,
        workspaceFolder.uri.fsPath,
        activeEnvironment?.id,
      ),
    });
    if (!environmentName) {
      return false;
    }
    const environmentDirectory = await vscode.window.showInputBox({
      title: '配置 Ecode 环境 (2/5)',
      prompt: '环境目录',
      value: activeEnvironment?.directory ?? '',
      placeHolder: '例如：dev、test_env、prod_01',
      ignoreFocusOut: true,
      validateInput: value => validateEnvironmentDirectoryInput(
        value,
        configuredEnvironments,
        activeEnvironment,
      ),
    });
    if (!environmentDirectory) {
      return false;
    }
    const serverUrl = await vscode.window.showInputBox({
      title: '配置 Ecode 环境 (3/5)',
      prompt: 'E-cology 服务器地址',
      value: previous?.serverUrl ?? 'http://localhost:8099',
      ignoreFocusOut: true,
      validateInput: validateServerUrl,
    });
    if (!serverUrl) {
      return false;
    }

    const username = await vscode.window.showInputBox({
      title: '配置 Ecode 环境 (4/5)',
      prompt: '登录用户名',
      value: previous?.username ?? 'sysadmin',
      ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : '用户名不能为空',
    });
    if (!username) {
      return false;
    }

    const password = await vscode.window.showInputBox({
      title: '配置 Ecode 环境 (5/5)',
      prompt: '密码将保存到 VS Code SecretStorage',
      password: true,
      ignoreFocusOut: true,
      validateInput: value => value ? undefined : '密码不能为空',
    });
    if (!password) {
      return false;
    }

    const environmentId = activeEnvironment?.id ?? randomUUID();
    const profile: ConnectionProfile = {
      version: 4,
      environmentId,
      environmentDirectory: environmentDirectory.trim(),
      workspaceFolder: workspaceFolder.uri.fsPath,
      serverUrl: serverUrl.trim().replace(/\/+$/, ''),
      username: username.trim(),
    };

    const configured = await this.runExclusive('正在测试连接...', async () => {
      const result = await this.auth.connect(profile, password);
      if (!result.success) {
        throw new Error(result.message);
      }
      const savedEnvironment = await configurationStore.saveEnvironment({
        id: environmentId,
        name: environmentName.trim(),
        directory: profile.environmentDirectory,
        workspaceFolder: profile.workspaceFolder,
        serverUrl: profile.serverUrl,
        username: profile.username,
      }, !createNew || !currentEnvironment);
      if (!createNew || !currentEnvironment) {
        this.activateWorkspaceContext(profile);
        await this.refreshWorkspaceContext(profile);
      }
      vscode.window.showInformationMessage(
        createNew && currentEnvironment
          ? `Ecode: ${savedEnvironment.name}已保存，可通过“切换环境”激活`
          : `Ecode: ${savedEnvironment.name}已保存并激活，请手动执行拉取`,
      );
      return true;
    });
    return configured === true;
  }

  private async switchEnvironment(): Promise<void> {
    if (this.busy) {
      vscode.window.showWarningMessage('Ecode: 已有同步操作正在执行');
      return;
    }
    const current = await this.store.getActiveEnvironment();
    const environments = await this.store.getEnvironments();
    const candidates = switchEnvironmentCandidates(current?.id, environments);
    if (candidates.length === 0) {
      await this.configure(true);
      return;
    }
    const selected = await vscode.window.showQuickPick(
      candidates.map(environment => ({
        label: environment.name,
        description: `${environment.directory}/`,
        detail: `${environment.serverUrl} · ${environment.username}`,
        environment,
      })),
      {
        title: '切换 Ecode 环境',
        placeHolder: '每个环境使用独立源码目录，切换不会改动其他环境源码',
        ignoreFocusOut: true,
      },
    );
    if (!selected) {
      return;
    }
    const confirmation = await vscode.window.showWarningMessage(
      `确认切换到“${selected.environment.name}”（${selected.environment.serverUrl}）？`
        + `扩展将改用独立源码目录 ${selected.environment.directory}/，`
        + '其他环境的源码和同步状态保持不变。',
      { modal: true },
      '确认切换',
    );
    if (confirmation !== '确认切换') {
      return;
    }
    const environment = await this.store.setActiveEnvironment(selected.environment.id);
    const profile = toConnectionProfile(environment);
    this.activateWorkspaceContext(profile);
    await this.refreshWorkspaceContext(profile);
    await this.updateViews();
    vscode.window.showInformationMessage(`Ecode: 已切换到 ${environment.name}`);
  }

  private async deleteEnvironment(
    argument?: unknown,
    confirmationSource: ConfirmationSource = 'vscode',
  ): Promise<boolean> {
    if (this.busy) {
      throw new Error('已有同步操作正在执行');
    }
    const environments = await this.store.getEnvironments();
    if (environments.length <= 1) {
      throw new Error('不能删除最后一个 Ecode 环境；请先新增其他环境');
    }
    const candidate = environmentFromCommandArgument(argument);
    const environment = candidate
      ? environments.find(item => item.id === candidate.id)
      : (await vscode.window.showQuickPick(
          environments.map(item => ({
            label: item.name,
            description: `${item.directory}/`,
            detail: `${item.serverUrl} · ${item.username}`,
            environment: item,
          })),
          {
            title: '删除 Ecode 环境',
            placeHolder: '将同时删除该环境的源码目录和 .ecode-local 环境数据',
            ignoreFocusOut: true,
          },
        ))?.environment;
    if (!environment) {
      return false;
    }
    if (confirmationSource === 'vscode') {
      const confirmation = await vscode.window.showWarningMessage(
        `确认删除环境“${environment.name}”？将永久删除源码目录 `
          + `${environment.directory}/、对应的 .ecode-local 环境数据和本机登录凭据。`
          + '远端代码、推送记录和变更集不会删除。',
        { modal: true },
        '删除环境及本地数据',
      );
      if (confirmation !== '删除环境及本地数据') {
        return false;
      }
    }

    const completed = await this.runExclusive('正在删除环境及本地数据...', async () => {
      const activeBefore = await this.store.getActiveEnvironment();
      const result = await this.store.deleteEnvironment(environment.id);
      await this.auth.removeEnvironment(environment.id);
      if (activeBefore?.id === environment.id) {
        const profile = toConnectionProfile(result.activeEnvironment);
        this.activateWorkspaceContext(profile);
        await this.refreshWorkspaceContext(profile);
      } else {
        await this.refreshAiSupport(false);
      }
      const message = `Ecode: 环境“${environment.name}”及其本地数据已删除`;
      if (result.cleanupPendingPath) {
        vscode.window.showWarningMessage(
          `${message}；隔离数据清理失败，请稍后手工检查 ${result.cleanupPendingPath}`,
        );
      } else {
        vscode.window.showInformationMessage(message);
      }
      return true;
    });
    return completed === true;
  }

  private async pull(): Promise<boolean> {
    const profile = await this.requireProfile();
    if (!profile) {
      return false;
    }
    const result = await this.runExclusive('正在拉取...', async () => {
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Ecode: 全量拉取',
        cancellable: true,
      }, (progress, token) => this.service.pull(
        message => progress.report({ message }),
        token,
      ));
      await this.formMetadataRegistry.reload(profile, this.store);
      await this.refreshAiSupport(false);
      this.changes = this.service.getLastPlan()?.changes ?? [];
      showResult('拉取', result);
      return result;
    });
    return result !== undefined;
  }

  private async refreshChanges(): Promise<void> {
    await this.runExclusive('正在刷新本地与远端变更...', async () => {
      this.changes = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Ecode: 刷新本地与远端变更',
        cancellable: true,
      }, (progress, token) => this.service.refreshChanges(
        message => progress.report({ message }),
        token,
      ));
    });
  }

  private async pushSelected(): Promise<void> {
    const profile = await this.requireProfile();
    if (!profile) {
      return;
    }
    if (!await this.service.hasSyncBaseline()) {
      const action = await vscode.window.showWarningMessage(
        'Ecode: 当前环境尚未建立同步基线，请先执行全量拉取',
        '全量拉取',
      );
      if (action === '全量拉取') {
        await this.pull();
      }
      return;
    }
    this.changes = await this.service.refreshLocalChanges();
    const pushable = this.changes.filter(isPushableChange);
    if (pushable.length === 0) {
      vscode.window.showInformationMessage('Ecode: 没有可推送的新增、修改或删除文件');
      await this.updateViews();
      return;
    }

    const selected = await vscode.window.showQuickPick(
      pushable.map(change => ({
        label: change.path,
        description: change.status === 'localAdded'
          ? '新增'
          : change.status === 'localDeleted'
            ? '删除'
            : change.status === 'conflict' ? '远端已一致，确认推送结果' : '修改',
        change,
        picked: true,
      })),
      {
        title: '选择本次推送的文件',
        canPickMany: true,
        ignoreFocusOut: true,
        placeHolder: '推送前会重新核对远端内容',
      },
    );
    if (!selected?.length) {
      return;
    }
    const activeEnvironment = await this.store.getActiveEnvironment();
    if (!activeEnvironment) {
      throw new Error('当前没有活动环境');
    }
    const selectedPaths = selected.map(item => item.change.path);
    const promotionCandidates = await this.service.preparePromotionCandidates(
      selectedPaths,
    );

    const execution = await this.executePush(
      profile,
      activeEnvironment,
      selectedPaths,
      promotionCandidates,
    );
    if (execution) {
      showResult('推送', execution.result);
      if (execution.record) {
        vscode.window.showInformationMessage(
          `Ecode: 已保存推送记录“${execution.record.name}”`,
        );
      }
    }
  }

  private async executePush(
    profile: ConnectionProfile,
    environment: EnvironmentProfile,
    selectedPaths: string[],
    promotionCandidates: PromotionCandidate[],
  ): Promise<PushExecution | undefined> {
    return this.runExclusive('正在推送...', async () => {
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Ecode: 安全推送',
        cancellable: true,
      }, (progress, token) => this.service.pushSelected(
        selectedPaths,
        message => progress.report({ message }),
        token,
      ));
      const verified = await this.service.filterVerifiedPromotionCandidates(
        promotionCandidates,
      );
      const promotionStore = this.promotionStore(profile.workspaceFolder);
      const record = verified.length > 0
        ? await promotionStore.recordPush(
            environment.id,
            verified,
            selectedPaths,
          )
        : undefined;
      this.changes = this.service.getLastPlan()?.changes ?? [];
      return { result, record };
    });
  }

  private async createChangeSet(): Promise<void> {
    const source = await this.store.getActiveEnvironment();
    if (!source) {
      throw new Error('请先配置并激活源环境');
    }
    if (!await this.service.hasSyncBaseline()) {
      throw new Error('当前源环境尚未建立同步基线，请先执行全量拉取');
    }
    const promotionStore = this.promotionStore(source.workspaceFolder);
    const [pushRecords, lifecycleRecords] = await Promise.all([
      promotionStore.listPushRecords(source.id),
      promotionStore.listLifecycleRecords(source.id),
    ]);
    if (pushRecords.length === 0 && lifecycleRecords.length === 0) {
      throw new Error('当前环境还没有可用的推送记录或生命周期记录');
    }
    type PromotionQuickPickItem = vscode.QuickPickItem & {
      pushRecord?: PushRecord;
      lifecycleRecord?: LifecycleChangeRecord;
    };
    const items: PromotionQuickPickItem[] = [];
    if (pushRecords.length > 0) {
      items.push({ label: '推送记录', kind: vscode.QuickPickItemKind.Separator });
      items.push(...pushRecords.map(record => ({
        label: record.name,
        description: `${new Date(record.createdAt).toLocaleString()} · ${record.files.length} 个文件`,
        detail: `${record.id}${record.status === 'partial' ? ' · 部分成功' : ''}`,
        pushRecord: record,
      })));
    }
    if (lifecycleRecords.length > 0) {
      items.push({ label: '生命周期记录', kind: vscode.QuickPickItemKind.Separator });
      items.push(...lifecycleRecords.map(record => ({
        label: lifecycleChangeLabel(record.change),
        description: new Date(record.createdAt).toLocaleString(),
        detail: `${record.id} · ${record.change.path}`,
        lifecycleRecord: record,
      })));
    }
    const selectedRecords = await vscode.window.showQuickPick(
      items,
      {
        title: '选择组成跨环境变更集的记录',
        placeHolder: '可混合选择推送和生命周期记录；同一目标按时间折叠为最终净变化',
        canPickMany: true,
        ignoreFocusOut: true,
      },
    );
    if (!selectedRecords?.length) {
      return;
    }
    const name = await vscode.window.showInputBox({
      title: '从历史推送创建变更集',
      prompt: '变更集名称',
      placeHolder: '例如：采购申请校验',
      ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : '名称不能为空',
    });
    if (!name) {
      return;
    }
    const changeSet = await promotionStore.createChangeSet(
      name,
      source.id,
    );
    const chronologicalRecords = selectedRecords
      .flatMap(item => item.pushRecord ? [item.pushRecord] : [])
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const chronologicalLifecycle = selectedRecords
      .flatMap(item => item.lifecycleRecord ? [item.lifecycleRecord] : [])
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    let updatedChangeSet = changeSet;
    try {
      for (const record of chronologicalRecords) {
        updatedChangeSet = await promotionStore.recordVerifiedCandidates(
          changeSet.id,
          await promotionStore.materializePushRecord(record),
        );
      }
      if (chronologicalLifecycle.length > 0) {
        updatedChangeSet = await promotionStore.recordLifecycleChanges(
          changeSet.id,
          chronologicalLifecycle.map(record => record.change),
        );
      }
      if (
        Object.keys(updatedChangeSet.files).length === 0
        && Object.keys(updatedChangeSet.lifecycleChanges ?? {}).length === 0
      ) {
        throw new Error('所选记录折叠后没有可应用的净变化');
      }
    } catch (error: unknown) {
      await promotionStore.deleteChangeSet(changeSet.id);
      throw error;
    }
    await this.updateViews();
    vscode.window.showInformationMessage(
      `Ecode: 已从 ${selectedRecords.length} 条历史记录创建 `
        + `变更集“${changeSet.name}”，包含 `
        + `${Object.keys(updatedChangeSet.files).length} 个文件、`
        + `${Object.keys(updatedChangeSet.lifecycleChanges ?? {}).length} 项生命周期配置；`
        + '切换到任意已建立基线的环境即可直接应用',
    );
  }

  private async rollbackPushFile(
    argument: unknown,
    explicitRemotePath?: string,
    confirmationSource: ConfirmationSource = 'vscode',
  ): Promise<boolean> {
    const selection = pushRecordFileSelection(argument, explicitRemotePath);
    if (!selection) {
      throw new Error('未找到要回退的推送文件');
    }
    const { record, remotePath } = selection;
    const environment = await this.store.getActiveEnvironment();
    if (!environment) {
      throw new Error('当前没有活动环境');
    }
    const promotionStore = this.promotionStore(environment.workspaceFolder);
    if (record.environmentId !== environment.id) {
      throw new Error('请先切换到该推送记录所属环境再执行本地回退');
    }
    const candidate = (await promotionStore.materializePushRecord(record))
      .find(item => item.path === remotePath);
    if (!candidate) {
      throw new Error('推送记录中不存在该文件');
    }
    if (confirmationSource === 'vscode') {
      const confirmation = await vscode.window.showWarningMessage(
        `确认把本地文件 ${remotePath} 恢复到推送记录“${record.name}”之前？`
          + '此操作不会修改远端和同步基线；恢复后会显示为待推送的本地变更。',
        { modal: true },
        '确认本地回退',
      );
      if (confirmation !== '确认本地回退') {
        return false;
      }
    }

    const completed = await this.runExclusive('正在回退本地源码...', async () => {
      const recoveries = await this.service.rollbackPushLocally([candidate]);
      this.changes = this.service.getLastPlan()?.changes ?? [];
      vscode.window.showInformationMessage(
        `Ecode: 已将 ${remotePath} 恢复到推送前，`
          + `远端未修改${recoveries.length > 0
            ? `；已保存 ${recoveries.length} 份恢复副本`
            : ''}`,
      );
      return true;
    });
    return completed === true;
  }

  private async renamePushRecord(
    argument?: unknown,
    explicitName?: string,
  ): Promise<void> {
    const record = pushRecordFromCommandArgument(argument);
    if (!record) {
      throw new Error('未找到要重命名的推送记录');
    }
    const environment = await this.store.getActiveEnvironment();
    if (!environment) {
      throw new Error('当前没有活动环境');
    }
    const name = explicitName ?? await vscode.window.showInputBox({
        title: '重命名推送记录',
        prompt: '推送记录名称',
        value: record.name,
        ignoreFocusOut: true,
        validateInput: value => value.trim() ? undefined : '名称不能为空',
      });
    if (name === undefined) {
      return;
    }
    const updated = await this.promotionStore(environment.workspaceFolder)
      .renamePushRecord(record.id, name);
    await this.updateViews();
    vscode.window.showInformationMessage(`Ecode: 推送记录已重命名为“${updated.name}”`);
  }

  private async deletePushRecord(
    argument?: unknown,
    confirmationSource: ConfirmationSource = 'vscode',
  ): Promise<boolean> {
    const record = pushRecordFromCommandArgument(argument);
    if (!record) {
      throw new Error('未找到要删除的推送记录');
    }
    const environment = await this.store.getActiveEnvironment();
    if (!environment) {
      throw new Error('当前没有活动环境');
    }
    if (confirmationSource === 'vscode') {
      const confirmation = await vscode.window.showWarningMessage(
        `确认删除推送记录“${record.name}”？`
          + '这只会删除该历史记录，不会修改本地、远端、变更集或应用记录。',
        { modal: true },
        '确认删除',
      );
      if (confirmation !== '确认删除') {
        return false;
      }
    }
    await this.promotionStore(environment.workspaceFolder).deletePushRecord(record.id);
    await this.updateViews();
    vscode.window.showInformationMessage(`Ecode: 已删除推送记录“${record.name}”`);
    return true;
  }

  private async deleteLifecycleRecord(
    argument?: unknown,
    confirmationSource: ConfirmationSource = 'vscode',
  ): Promise<boolean> {
    const record = lifecycleRecordFromCommandArgument(argument);
    if (!record) {
      throw new Error('未找到要删除的生命周期记录');
    }
    const environment = await this.store.getActiveEnvironment();
    if (!environment || record.environmentId !== environment.id) {
      throw new Error('请先切换到该生命周期记录所属环境');
    }
    if (confirmationSource === 'vscode') {
      const confirmation = await vscode.window.showWarningMessage(
        `确认删除生命周期记录“${lifecycleChangeLabel(record.change)}”？`
          + '这只会删除历史记录，不会修改远端状态或已有变更集。',
        { modal: true },
        '确认删除',
      );
      if (confirmation !== '确认删除') {
        return false;
      }
    }
    await this.promotionStore(environment.workspaceFolder)
      .deleteLifecycleRecord(record.id);
    await this.updateViews();
    vscode.window.showInformationMessage('Ecode: 生命周期记录已删除；远端状态未修改');
    return true;
  }

  private async deleteLifecycleRecords(): Promise<void> {
    const environment = await this.store.getActiveEnvironment();
    if (!environment) {
      throw new Error('当前没有活动环境');
    }
    const promotionStore = this.promotionStore(environment.workspaceFolder);
    const records = await promotionStore.listLifecycleRecords(environment.id);
    if (records.length === 0) {
      vscode.window.showInformationMessage('Ecode: 当前环境没有生命周期记录');
      return;
    }
    const selected = await vscode.window.showQuickPick(
      records.map(record => ({
        label: record.change.path,
        description: lifecycleChangeLabel(record.change),
        detail: `${lifecycleChangeTransition(record.change)} · ${
          new Date(record.createdAt).toLocaleString()
        }`,
        record,
      })),
      {
        canPickMany: true,
        placeHolder: '勾选要删除的生命周期记录；删除历史不会修改远端状态或已有变更集',
      },
    );
    if (!selected || selected.length === 0) {
      return;
    }
    const preview = selected.slice(0, 10)
      .map(item => `${item.label} · ${item.description}`)
      .join('\n');
    const remaining = selected.length > 10
      ? `\n另有 ${selected.length - 10} 条记录`
      : '';
    const confirmation = await vscode.window.showWarningMessage(
      `确认删除选中的 ${selected.length} 条生命周期记录？`,
      {
        modal: true,
        detail: `${preview}${remaining}\n\n只会删除历史记录，不会修改远端状态或已有变更集。`,
      },
      '确认删除',
    );
    if (confirmation !== '确认删除') {
      return;
    }
    let deleted = 0;
    try {
      for (const item of selected) {
        await promotionStore.deleteLifecycleRecord(item.record.id);
        deleted++;
      }
    } catch (error: unknown) {
      await this.updateViews();
      throw new Error(`已删除 ${deleted} 条记录，后续删除失败：${errorMessage(error)}`);
    }
    await this.updateViews();
    vscode.window.showInformationMessage(
      `Ecode: 已删除 ${deleted} 条生命周期记录；远端状态未修改`,
    );
  }

  private async openPromotionDiff(
    candidate: PushRecord | ChangeSet,
    remotePath: string,
  ): Promise<void> {
    const environment = await this.store.getActiveEnvironment();
    if (!environment) {
      throw new Error('当前没有活动环境');
    }
    const promotionStore = this.promotionStore(environment.workspaceFolder);
    const files = isPushRecord(candidate)
      ? await promotionStore.materializePushRecord(candidate)
      : await promotionStore.materializeChangeSetCandidates(candidate);
    const file = files.find(item => item.path === remotePath);
    if (!file) {
      throw new Error('记录中不存在该文件');
    }
    const uris = this.promotionDiff.createDiff(
      remotePath,
      file.kind === 'resource'
        ? promotionResourceSummary(
            '推送前',
            remotePath,
            file.size,
            file.baseHash,
            file.operation !== 'add',
          )
        : file.baseContent,
      file.kind === 'resource'
        ? promotionResourceSummary(
            '推送后',
            remotePath,
            file.size,
            file.resultHash,
            file.operation !== 'delete',
          )
        : file.resultContent,
    );
    await vscode.commands.executeCommand(
      'vscode.diff',
      uris.before,
      uris.after,
      `${remotePath} — 推送前 ↔ 推送后`,
    );
  }

  private async applyChangeSet(
    argument?: unknown,
    confirmationSource: ConfirmationSource = 'vscode',
  ): Promise<DeploymentRecord['status'] | false> {
    const target = await this.store.getActiveEnvironment();
    if (!target) {
      throw new Error('请先配置并激活当前环境');
    }
    const promotionStore = this.promotionStore(target.workspaceFolder);
    const changeSet = await this.selectChangeSet(
      promotionStore,
      argument,
      `选择要应用到当前环境“${target.name}”的变更集`,
    );
    if (!changeSet) {
      return false;
    }
    const artifacts = await promotionStore.materializeChangeSet(changeSet);
    const lifecycleChanges = Object.values(changeSet.lifecycleChanges ?? {});
    if (artifacts.length === 0 && lifecycleChanges.length === 0) {
      throw new Error('变更集中没有可应用的文件或生命周期配置');
    }
    const profile = toConnectionProfile(target);
    if (!await this.service.hasSyncBaseline(profile)) {
      throw new Error(
        `当前环境“${target.name}”尚未建立同步基线，请先执行全量拉取`,
      );
    }
    const preflight = artifacts.length > 0
      ? await this.service.verifyRelease(profile, artifacts)
      : { success: true, files: [] };
    if (!preflight.success) {
      const now = new Date().toISOString();
      await promotionStore.saveDeployment({
        schemaVersion: 2,
        id: `DEP-${randomUUID()}`,
        changeSetId: changeSet.id,
        targetEnvironmentId: target.id,
        startedAt: now,
        completedAt: now,
        status: 'conflict',
        files: preflight.files,
        lifecycle: lifecycleChanges.map(change => ({
          kind: change.kind,
          path: change.path,
          status: 'skipped',
          message: '代码预检未通过，未执行生命周期配置',
        })),
      });
      throw new Error(formatPromotionFailures(
        '当前环境预检未通过，未写入任何文件',
        preflight.files,
      ));
    }
    if (confirmationSource === 'vscode') {
      const preloadCount = lifecycleChanges.filter(change =>
        change.kind === 'filePreload').length;
      const orderCount = lifecycleChanges.filter(change =>
        change.kind === 'preloadOrder').length;
      const releaseCount = lifecycleChanges.filter(change =>
        change.kind === 'folderRelease').length;
      const confirmation = await vscode.window.showWarningMessage(
        `确认将变更集“${changeSet.name}”应用到当前环境“${target.name}”？`
          + `本次将处理 ${artifacts.length} 个文件、${preloadCount} 项文件前置、`
          + `${orderCount} 项加载顺序、${releaseCount} 项发布状态，`
          + '生命周期配置只会在代码全部成功后执行。',
        { modal: true },
        '确认应用',
      );
      if (confirmation !== '确认应用') {
        return false;
      }
    }

    const completed = await this.runExclusive(
      `正在向 ${target.name} 应用变更...`,
      async () => {
        const startedAt = new Date().toISOString();
        const appliedCandidates: PromotionCandidate[] = [];
        const result = await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: `Ecode: 应用变更集 ${changeSet.name}`,
          cancellable: true,
        }, async (progress, token) => {
          const files = artifacts.length > 0
            ? await this.service.deployRelease(
                profile,
                artifacts,
                message => progress.report({ message }),
                token,
                candidate => appliedCandidates.push(candidate),
              )
            : [];
          const codeSucceeded = files.every(file => file.status === 'succeeded');
          const lifecycle = codeSucceeded
            ? await deployLifecycleChanges(
                lifecycleChanges,
                this.lifecycle,
                message => progress.report({ message }),
                () => token.isCancellationRequested,
              )
            : lifecycleChanges.map(change => ({
                kind: change.kind,
                path: change.path,
                status: 'skipped' as const,
                message: '代码未全部成功，生命周期配置留待重试',
              }));
          return { files, lifecycle };
        });
        const record: DeploymentRecord = {
          schemaVersion: 2,
          id: `DEP-${randomUUID()}`,
          changeSetId: changeSet.id,
          targetEnvironmentId: target.id,
          startedAt,
          completedAt: new Date().toISOString(),
          status: deploymentStatus(result.files, result.lifecycle),
          files: result.files,
          lifecycle: result.lifecycle,
        };
        await promotionStore.saveDeployment(record);
        for (const lifecycleResult of result.lifecycle) {
          const sourceChange = lifecycleChanges.find(change =>
            change.kind === lifecycleResult.kind
            && sameRemotePath(change.path, lifecycleResult.path));
          const appliedChange = sourceChange
            ? appliedLifecycleChange(sourceChange, lifecycleResult)
            : undefined;
          if (appliedChange) {
            await promotionStore.recordLifecycleChange(target.id, appliedChange);
          }
        }
        const pushRecord = appliedCandidates.length > 0
          ? await promotionStore.recordPush(
              target.id,
              appliedCandidates,
              artifacts.map(artifact => artifact.path),
              changeSet.name,
            )
          : undefined;
        this.changes = await this.service.refreshLocalChanges();
        if (record.status === 'succeeded') {
          vscode.window.showInformationMessage(
            `Ecode: 变更集“${changeSet.name}”已成功应用到当前环境 ${target.name}`
              + `${pushRecord ? `，并保存同名推送记录` : ''}`,
          );
        } else {
          vscode.window.showErrorMessage(formatPromotionFailures(
            `应用结果：${record.status}`,
            result.files,
            result.lifecycle,
          ));
        }
        return record.status;
      },
    );
    return completed ?? false;
  }

  private async deleteChangeSet(
    argument?: unknown,
    confirmationSource: ConfirmationSource = 'vscode',
  ): Promise<boolean> {
    const environment = await this.store.getActiveEnvironment();
    if (!environment) {
      throw new Error('请先配置并激活当前环境');
    }
    const promotionStore = this.promotionStore(environment.workspaceFolder);
    const changeSet = await this.selectChangeSet(
      promotionStore,
      argument,
      '选择要删除的跨环境变更集',
    );
    if (!changeSet) {
      return false;
    }
    if (confirmationSource === 'vscode') {
      const confirmation = await vscode.window.showWarningMessage(
        `确认删除变更集“${changeSet.name}”？`
          + '这只会删除变更集记录，不会删除推送记录、应用记录，'
          + '也不会回退任何本地或远端代码。',
        { modal: true },
        '确认删除',
      );
      if (confirmation !== '确认删除') {
        return false;
      }
    }
    await promotionStore.deleteChangeSet(changeSet.id);
    await this.updateViews();
    vscode.window.showInformationMessage(
      `Ecode: 已删除变更集“${changeSet.name}”；已有代码和历史记录未修改`,
    );
    return true;
  }

  private async selectChangeSet(
    promotionStore: PromotionStore,
    argument: unknown,
    title: string,
  ): Promise<ChangeSet | undefined> {
    const available = (await promotionStore.listChangeSets())
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    if (available.length === 0) {
      throw new Error('当前工作区还没有变更集');
    }
    const candidate = changeSetFromCommandArgument(argument);
    if (candidate) {
      const current = available.find(item => item.id === candidate.id);
      if (!current) {
        throw new Error('变更集不存在或已删除');
      }
      return current;
    }
    return (await vscode.window.showQuickPick(
      available.map(changeSet => ({
        label: changeSet.name,
        description: changeSet.id,
        detail: `${Object.keys(changeSet.files).length} 个文件`,
        changeSet,
      })),
      { title, ignoreFocusOut: true },
    ))?.changeSet;
  }

  private async openDiff(change: SyncChange): Promise<void> {
    if (!change?.path || change.status === 'unsupported') {
      return;
    }
    const profile = await this.requireProfile();
    if (!profile) {
      return;
    }
    const local = vscode.Uri.file(
      resolveSafeLocalPath(
        resolveEnvironmentSourceRoot(
          profile.workspaceFolder,
          profile.environmentDirectory,
        ),
        change.path,
      ),
    );
    const baseline = virtualUri(BASELINE_SCHEME, change.path);
    const remote = virtualUri(REMOTE_SCHEME, change.path);
    const localSummary = virtualUri(LOCAL_SCHEME, change.path);
    const empty = virtualUri(EMPTY_SCHEME, change.path);
    const localOrEmpty = change.kind === 'resource'
      ? localSummary
      : fs.existsSync(local.fsPath) ? local : empty;

    if (change.status === 'conflict') {
      const comparison = await vscode.window.showQuickPick([
        { label: '本地 ↔ 最新远端', left: localOrEmpty, right: remote },
        { label: '基线 ↔ 本地', left: baseline, right: localOrEmpty },
        { label: '基线 ↔ 最新远端', left: baseline, right: remote },
      ], { title: `查看冲突: ${change.path}` });
      if (comparison) {
        await vscode.commands.executeCommand(
          'vscode.diff',
          comparison.left,
          comparison.right,
          `${change.path} — ${comparison.label}`,
        );
      }
      return;
    }

    const right = change.status === 'remoteModified' || change.status === 'remoteAdded'
      ? remote
      : change.status === 'localDeleted' || change.status === 'remoteDeleted'
        ? empty
        : localOrEmpty;
    await vscode.commands.executeCommand(
      'vscode.diff',
      baseline,
      right,
      `${change.path} — Ecode 差异`,
    );
  }

  private async resolveConflict(
    change: SyncChange,
    explicitResolution?: AiInvocation['resolution'],
    confirmationSource: ConfirmationSource = 'vscode',
  ): Promise<boolean> {
    if (change?.status !== 'conflict') {
      return false;
    }
    if (change.conflictReason === 'remoteDeletedLocalModified') {
      const actions = [
        {
          label: '接受远端删除',
          description: '先备份本地修改，再删除本地文件',
          value: 'acceptRemoteDeletion' as const,
        },
        {
          label: '保留本地并重新创建远端',
          description: '移除旧基线，将当前本地文件转为待推送的新增文件',
          value: 'keepLocal' as const,
        },
      ];
      if (
        explicitResolution
        && !['acceptRemoteDeletion', 'keepLocal'].includes(explicitResolution)
      ) {
        throw new Error('远端删除冲突只支持 acceptRemoteDeletion 或 keepLocal');
      }
      const action = explicitResolution
        ? actions.find(item => item.value === explicitResolution)
        : await vscode.window.showQuickPick(
            actions,
            { title: `解决远端删除冲突: ${change.path}` },
          );
      if (!action) {
        return false;
      }
      if (confirmationSource === 'vscode') {
        const confirmed = await vscode.window.showWarningMessage(
          action.value === 'acceptRemoteDeletion'
            ? '本地修改将保存为恢复副本，然后删除本地文件。'
            : '将确认远端文件仍不存在，并把当前本地文件标记为待新增。',
          { modal: true },
          '确认',
        );
        if (confirmed !== '确认') {
          return false;
        }
      }
      const completed = await this.runExclusive('正在解决删除冲突...', async () => {
        if (action.value === 'acceptRemoteDeletion') {
          const recovery = await this.service.acceptRemoteDeletion(change.path);
          vscode.window.showInformationMessage(
            recovery ? `已接受远端删除；本地恢复副本: ${recovery}` : '已接受远端删除',
          );
        } else {
          await this.service.keepLocalAfterRemoteDeletion(change.path);
          vscode.window.showInformationMessage('已保留本地文件，可重新检查后推送为远端新增');
        }
        this.changes = this.service.getLastPlan()?.changes ?? [];
        return true;
      });
      return completed === true;
    }
    const actions = [
      {
        label: '接受最新远端',
        description: '先备份本地内容，再以远端内容替换本地',
        value: 'acceptRemote' as const,
      },
      ...(change.conflictReason === 'localDeletedRemoteModified' ? [] : [{
        label: '已手工合并，保留当前本地',
        description: '将最新远端设为新基线，当前本地内容仍待推送',
        value: 'markMerged' as const,
      }]),
    ];
    if (
      explicitResolution
      && !actions.some(item => item.value === explicitResolution)
    ) {
      throw new Error(
        change.conflictReason === 'localDeletedRemoteModified'
          ? '当前冲突只支持 acceptRemote'
          : '当前冲突只支持 acceptRemote 或 markMerged',
      );
    }
    const action = explicitResolution
      ? actions.find(item => item.value === explicitResolution)
      : await vscode.window.showQuickPick(
          actions,
          { title: `解决冲突: ${change.path}` },
        );
    if (!action) {
      return false;
    }

    if (confirmationSource === 'vscode') {
      const confirmed = await vscode.window.showWarningMessage(
        action.value === 'acceptRemote'
          ? '本地文件将被最新远端内容替换，替换前会保存恢复副本。'
          : '仅在已经检查并手工合并远端修改后使用此操作。',
        { modal: true },
        '确认',
      );
      if (confirmed !== '确认') {
        return false;
      }
    }

    const completed = await this.runExclusive('正在解决冲突...', async () => {
      if (action.value === 'acceptRemote') {
        const recovery = await this.service.acceptRemote(change.path);
        vscode.window.showInformationMessage(
          recovery ? `已接受远端；本地恢复副本: ${recovery}` : '已接受最新远端内容',
        );
      } else {
        await this.service.markMerged(change.path);
        vscode.window.showInformationMessage('已更新基线，当前本地内容可重新检查后推送');
      }
      this.changes = this.service.getLastPlan()?.changes ?? [];
      return true;
    });
    return completed === true;
  }

  private async revertChange(
    candidate?: SyncChange,
    confirmationSource: ConfirmationSource = 'vscode',
  ): Promise<boolean> {
    const profile = await this.requireProfile();
    if (!profile) {
      return false;
    }
    this.changes = await this.service.refreshLocalChanges();
    const revertible = this.changes.filter(change =>
      ['localAdded', 'localModified', 'localDeleted'].includes(change.status),
    );
    let change = candidate && revertible.some(item =>
      item.path === candidate.path && item.status === candidate.status)
      ? candidate
      : undefined;
    if (!change) {
      const selected = await vscode.window.showQuickPick(
        revertible.map(item => ({
          label: item.path,
          description: item.status === 'localAdded'
            ? '删除本地新增文件'
            : item.status === 'localDeleted' ? '恢复已删除文件' : '恢复为同步基线',
          change: item,
        })),
        {
          title: '选择要回退的本地变更',
          placeHolder: revertible.length > 0 ? undefined : '没有可回退的本地变更',
        },
      );
      change = selected?.change;
    }
    if (!change) {
      return false;
    }

    if (confirmationSource === 'vscode') {
      const confirmed = await vscode.window.showWarningMessage(
        change.status === 'localAdded'
          ? `将删除本地新增文件 ${change.path}，删除前保存恢复副本。`
          : change.status === 'localDeleted'
            ? `将从同步基线恢复已删除文件 ${change.path}。`
            : `将使用同步基线回退 ${change.path}，当前内容会先保存为恢复副本。`,
        { modal: true },
        '确认回退',
      );
      if (confirmed !== '确认回退') {
        return false;
      }
    }
    const completed = await this.runExclusive('正在回退本地变更...', async () => {
      const recovery = await this.service.revertLocalChange(change.path);
      this.changes = this.service.getLastPlan()?.changes ?? [];
      vscode.window.showInformationMessage(
        recovery ? `已回退本地变更；恢复副本: ${recovery}` : '已回退本地变更',
      );
      return true;
    });
    return completed === true;
  }

  private scheduleAiRefresh(): void {
    if (this.aiRefreshTimer) {
      clearTimeout(this.aiRefreshTimer);
    }
    this.aiRefreshTimer = setTimeout(() => {
      this.aiRefreshTimer = undefined;
      void this.refreshAiSupport(false);
    }, 1000);
  }

  private async enableAiSupport(): Promise<boolean> {
    const profile = await this.store.getProfile();
    if (!profile) {
      throw new Error('请先配置环境');
    }
    await vscode.workspace
      .getConfiguration('ecode', vscode.Uri.file(profile.workspaceFolder))
      .update(
        'aiSupport.enabled',
        true,
        vscode.ConfigurationTarget.WorkspaceFolder,
      );
    const result = await this.aiSupport.refresh(profile);
    this.lastAiSupportError = undefined;
    await this.updateViews();
    vscode.window.showInformationMessage(
      result.changedFiles.length > 0
        ? `Ecode: AI Coding 支持已启用（生成 ${result.changedFiles.length} 个文件）`
        : 'Ecode: AI Coding 支持已启用',
    );
    return true;
  }

  private async refreshAiSupport(showMessage: boolean): Promise<boolean> {
    const profile = await this.store.getProfile();
    if (!profile) {
      if (showMessage) {
        vscode.window.showErrorMessage('Ecode: 请先配置环境');
      }
      return false;
    }
    if (!this.aiSupport.isEnabled(profile.workspaceFolder)) {
      if (showMessage) {
        vscode.window.showInformationMessage(
          'Ecode: 当前工作区已关闭 AI Coding 支持，请执行“Ecode: 启用 AI Coding 支持”',
        );
      }
      return false;
    }
    try {
      const result = await this.aiSupport.refresh(profile);
      this.lastAiSupportError = undefined;
      if (showMessage) {
        vscode.window.showInformationMessage(
          result.changedFiles.length > 0
            ? `Ecode: AI Coding 支持已刷新（${result.changedFiles.length} 个文件）`
            : 'Ecode: AI Coding 支持已是最新',
        );
      }
      return true;
    } catch (error: unknown) {
      const message = errorMessage(error);
      output.error(`AI coding support refresh failed: ${message}`);
      if (showMessage) {
        vscode.window.showErrorMessage(`Ecode: ${message}`);
      } else if (this.lastAiSupportError !== message) {
        this.lastAiSupportError = message;
        vscode.window.showWarningMessage(
          `Ecode: AI Coding 支持刷新失败：${message}`,
        );
      }
      if (this.activeAiInvocations > 0) {
        throw error;
      }
      return false;
    }
  }

  private async openAiGuide(): Promise<void> {
    const profile = await this.store.getProfile();
    if (!profile) {
      vscode.window.showErrorMessage('Ecode: 请先配置环境');
      return;
    }
    await this.refreshAiSupport(false);
    try {
      await vscode.commands.executeCommand(
        'markdown.showPreview',
        this.aiSupport.guideUri(profile.workspaceFolder),
      );
    } catch (error: unknown) {
      vscode.window.showErrorMessage(`Ecode: 无法打开 AI Coding 指南：${errorMessage(error)}`);
    }
  }

  private async removeAiSupport(): Promise<boolean> {
    const profile = await this.store.getProfile();
    if (!profile) {
      vscode.window.showErrorMessage('Ecode: 当前没有有效连接配置');
      return false;
    }
    const confirmation = await vscode.window.showWarningMessage(
      '将删除公共知识目录、当前环境的 AI 项目知识及 AGENTS.md 的 Ecode 管理区块。'
        + '同步状态、变更集和其他环境数据不会被删除。',
      { modal: true },
      '移除 AI 支持',
    );
    if (confirmation !== '移除 AI 支持') {
      return false;
    }
    await vscode.workspace
      .getConfiguration('ecode', vscode.Uri.file(profile.workspaceFolder))
      .update(
        'aiSupport.enabled',
        false,
        vscode.ConfigurationTarget.WorkspaceFolder,
      );
    await this.aiSupport.remove(
      profile,
      (await this.store.getEnvironments()).map(environment => environment.directory),
    );
    await this.updateViews();
    vscode.window.showInformationMessage('Ecode: 已移除当前工作区的 AI Coding 支持');
    return true;
  }

  private async runCommandSafely(operation: () => Promise<unknown>): Promise<void> {
    try {
      await operation();
    } catch (error: unknown) {
      const message = errorMessage(error);
      output.error(message);
      vscode.window.showErrorMessage(`Ecode: ${message}`);
    }
  }

  scheduleLifecycleDecorationRefresh(): void {
    if (this.busy) {
      return;
    }
    void this.refreshLifecycleDecorations(false);
  }

  private async refreshLifecycleDecorations(showMessage: boolean): Promise<void> {
    if (this.lifecycleDecorationRefresh) {
      await this.lifecycleDecorationRefresh;
      return;
    }
    if (this.busy) {
      if (showMessage) {
        vscode.window.showWarningMessage('Ecode: 已有同步操作正在执行，请稍后刷新状态标记');
      }
      return;
    }
    const profile = await this.store.getProfile();
    if (!profile) {
      if (showMessage) {
        vscode.window.showErrorMessage('Ecode: 请先配置环境');
      }
      return;
    }
    const refresh = (async (): Promise<void> => {
      this.tree.setLifecycleLoading(true);
      try {
        await this.readLifecycleSnapshot();
        await this.updateViews();
        if (showMessage) {
          vscode.window.showInformationMessage(
            'Ecode: 目录类型与生命周期状态标记已刷新',
          );
        }
      } catch (error: unknown) {
        const message = errorMessage(error);
        if (showMessage) {
          vscode.window.showErrorMessage(`Ecode: 刷新状态标记失败: ${message}`);
        } else {
          output.warn(`Unable to refresh lifecycle decorations: ${message}`);
        }
      } finally {
        this.tree.setLifecycleLoading(false);
      }
    })();
    this.lifecycleDecorationRefresh = refresh;
    try {
      await refresh;
    } finally {
      if (this.lifecycleDecorationRefresh === refresh) {
        this.lifecycleDecorationRefresh = undefined;
      }
    }
  }

  private async readLifecycleSnapshot(): Promise<LifecycleSnapshot> {
    const requestedProfile = await this.store.getProfile();
    const snapshot = await this.lifecycle.getSnapshot();
    const profile = await this.store.getProfile();
    if (requestedProfile && profile) {
      const requestedSourceRoot = resolveEnvironmentSourceRoot(
        requestedProfile.workspaceFolder,
        requestedProfile.environmentDirectory,
      );
      const sourceRoot = resolveEnvironmentSourceRoot(
        profile.workspaceFolder,
        profile.environmentDirectory,
      );
      const requestedIdentity = lifecycleConnectionIdentity(
        requestedProfile.environmentId,
        requestedSourceRoot,
        requestedProfile.serverUrl,
        requestedProfile.username,
      );
      const identity = lifecycleConnectionIdentity(
        profile.environmentId,
        sourceRoot,
        profile.serverUrl,
        profile.username,
      );
      if (requestedIdentity === identity) {
        this.lifecycleSnapshot = snapshot;
        this.lifecycleSnapshotSourceRoot = sourceRoot;
        this.lifecycleSnapshotIdentity = identity;
        this.lifecycleSnapshotFresh = true;
      }
    }
    return snapshot;
  }

  private async requireLifecycleSnapshot(): Promise<LifecycleSnapshot> {
    const profile = await this.store.getProfile();
    if (!profile) {
      throw new Error('请先配置 Ecode 环境');
    }
    const sourceRoot = resolveEnvironmentSourceRoot(
      profile.workspaceFolder,
      profile.environmentDirectory,
    );
    const identity = lifecycleConnectionIdentity(
      profile.environmentId,
      sourceRoot,
      profile.serverUrl,
      profile.username,
    );
    if (
      this.lifecycleSnapshot
      && this.lifecycleSnapshotFresh
      && sameLocalPath(this.lifecycleSnapshotSourceRoot, sourceRoot)
      && this.lifecycleSnapshotIdentity === identity
    ) {
      return this.lifecycleSnapshot;
    }
    return this.readLifecycleSnapshot();
  }

  private async recordLifecyclePreload(
    remotePath: string,
    enabled: boolean,
    previous: boolean | undefined,
    changed = true,
  ): Promise<LifecycleChangeRecord | undefined> {
    const file = this.lifecycleSnapshot?.files.find(item =>
      sameRemotePath(item.path, remotePath));
    if (file) {
      file.preloadState = enabled ? 'preloaded' : 'normal';
      this.tree.refresh();
    }
    if (!changed || previous === undefined) {
      return undefined;
    }
    return this.recordLifecycleChange({
      kind: 'filePreload',
      path: remotePath,
      before: previous,
      after: enabled,
      verifiedAt: new Date().toISOString(),
    });
  }

  private async recordLifecycleRelease(
    remotePath: string,
    enabled: boolean,
    previous: boolean | undefined,
    changed = true,
  ): Promise<LifecycleChangeRecord | undefined> {
    const folder = this.lifecycleSnapshot?.folders.find(item =>
      sameRemotePath(item.path, remotePath));
    if (folder) {
      folder.released = enabled;
      this.tree.refresh();
    }
    if (!changed || previous === undefined) {
      return undefined;
    }
    return this.recordLifecycleChange({
      kind: 'folderRelease',
      path: remotePath,
      before: previous,
      after: enabled,
      verifiedAt: new Date().toISOString(),
    });
  }

  private async recordLifecyclePreStateOrder(
    remotePath: string,
    preStateOrder: string,
    previousPreStateOrder: string,
    changed = true,
  ): Promise<LifecycleChangeRecord | undefined> {
    const folder = this.lifecycleSnapshot?.folders.find(item =>
      sameRemotePath(item.path, remotePath));
    if (folder) {
      folder.preStateOrder = preStateOrder;
      this.tree.refresh();
    }
    if (!changed) {
      return undefined;
    }
    return this.recordLifecycleChange({
      kind: 'preloadOrder',
      path: remotePath,
      before: previousPreStateOrder,
      after: preStateOrder,
      verifiedAt: new Date().toISOString(),
    });
  }

  private async recordLifecycleChange(
    change: LifecycleChange,
  ): Promise<LifecycleChangeRecord> {
    const environment = await this.store.getActiveEnvironment();
    if (!environment) {
      throw new Error('当前没有活动环境，无法保存生命周期记录');
    }
    const record = await this.promotionStore(environment.workspaceFolder)
      .recordLifecycleChange(environment.id, change);
    await this.updateViews();
    return record;
  }

  private async setResourcePreload(
    argument: unknown,
    enabled: boolean,
  ): Promise<void> {
    if (this.lifecycleDecorationRefresh) {
      await this.lifecycleDecorationRefresh;
    }
    await this.runExclusive('正在更新前置加载状态...', async () => {
      const remotePath = requireLifecycleTreePath(argument, 'file');
      const file = requireLifecyclePath(
        (await this.requireLifecycleSnapshot()).files,
        remotePath,
        '前置加载文件',
      );
      await this.confirmAndSetFilePreload(file, enabled);
    });
  }

  private async setResourceFolderRelease(
    argument: unknown,
    enabled: boolean,
  ): Promise<void> {
    if (this.lifecycleDecorationRefresh) {
      await this.lifecycleDecorationRefresh;
    }
    await this.runExclusive('正在更新文件夹发布状态...', async () => {
      const remotePath = requireLifecycleTreePath(argument, 'folder');
      const folder = requireLifecyclePath(
        (await this.requireLifecycleSnapshot()).folders,
        remotePath,
        '发布文件夹',
      );
      await this.confirmAndSetFolderRelease(folder, enabled);
    });
  }

  private async setResourcePreloadOrder(
    argument: unknown,
  ): Promise<void> {
    if (this.lifecycleDecorationRefresh) {
      await this.lifecycleDecorationRefresh;
    }
    await this.runExclusive('正在更新前置加载顺序...', async () => {
      const remotePath = requireLifecycleTreePath(argument, 'folder');
      const folder = requireLifecyclePath(
        (await this.requireLifecycleSnapshot()).folders,
        remotePath,
        '前置加载顺序文件夹',
      );
      if (!folder.rootFolder) {
        throw new Error(`仅分类下的根文件夹支持设置前置加载顺序: ${folder.path}`);
      }
      const input = await vscode.window.showInputBox({
        title: 'Ecode: 修改前置加载顺序',
        prompt: folder.path,
        value: folder.preStateOrder ?? '10000',
        placeHolder: '整数或最多两位小数',
        validateInput: value => {
          try {
            normalizePreStateOrder(value);
            return undefined;
          } catch (error: unknown) {
            return errorMessage(error);
          }
        },
      });
      if (input === undefined) {
        return;
      }
      const preStateOrder = normalizePreStateOrder(input);
      if (
        folder.preStateOrder !== undefined
        && Number(folder.preStateOrder) === Number(preStateOrder)
      ) {
        vscode.window.showInformationMessage(
          `Ecode: 前置加载顺序未变化 · ${folder.path}`,
        );
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        '确认修改前置加载顺序？',
        {
          modal: true,
          detail: `${folder.path}\n${folder.preStateOrder ?? '未设置'} → ${preStateOrder}`,
        },
        '修改顺序',
      );
      if (confirmed !== '修改顺序') {
        return;
      }
      const result = await this.lifecycle.setPreStateOrderByPath(
        folder.path,
        preStateOrder,
      );
      assertLifecycleVerification(result.verified, '设置前置加载顺序');
      await this.recordLifecyclePreStateOrder(
        folder.path,
        preStateOrder,
        result.previousPreStateOrder,
        result.changed,
      );
      vscode.window.showInformationMessage(
        `Ecode: 已修改前置加载顺序 · ${folder.path} · ${preStateOrder}`,
      );
    });
  }

  private async confirmAndSetFilePreload(
    file: LifecycleFile,
    enabled: boolean,
  ): Promise<void> {
    if (!file.canPreload) {
      throw new Error('仅 JS/CSS 文件支持前置加载');
    }
    const requiredState = enabled ? 'normal' : 'preloaded';
    if (file.preloadState !== requiredState) {
      throw new Error(`文件当前前置状态为 ${file.preloadState}，请刷新后重试`);
    }
    const verb = enabled ? '设置前置加载' : '取消前置加载';
    const confirmed = await vscode.window.showWarningMessage(
      `确认对文件执行“${verb}”？`,
      { modal: true, detail: file.path },
      verb,
    );
    if (confirmed !== verb) {
      return;
    }
    const result = await this.lifecycle.setFilePreloadedByPath(file.path, enabled);
    assertLifecycleVerification(result.verified, verb);
    await this.recordLifecyclePreload(
      file.path,
      enabled,
      result.previous,
      result.changed,
    );
    vscode.window.showInformationMessage(`Ecode: 已${verb} · ${file.path}`);
  }

  private async confirmAndSetFolderRelease(
    folder: LifecycleFolder,
    enabled: boolean,
  ): Promise<void> {
    if (!folder.rootFolder) {
      throw new Error(`仅支持发布分类下的根文件夹: ${folder.path}`);
    }
    const verb = enabled ? '发布文件夹' : '取消发布';
    const confirmed = await vscode.window.showWarningMessage(
      `确认${verb}？`,
      {
        modal: true,
        detail: `${folder.path}\n该操作只改变 Ecode 发布状态，不会推送本地文件。`,
      },
      verb,
    );
    if (confirmed !== verb) {
      return;
    }
    const result = await this.lifecycle.setFolderReleasedByPath(folder.path, enabled);
    assertLifecycleVerification(result.verified, verb);
    await this.recordLifecycleRelease(
      folder.path,
      enabled,
      result.previous,
      result.changed,
    );
    vscode.window.showInformationMessage(`Ecode: 已${verb} · ${folder.path}`);
  }

  private async requireProfile(): Promise<ConnectionProfile | undefined> {
    const profile = await this.store.getProfile();
    if (!profile) {
      vscode.window.showErrorMessage('Ecode: 请先配置环境');
      await this.configure();
      return this.store.getProfile();
    }
    return profile;
  }

  private promotionStore(workspaceFolder: string): PromotionStore {
    return new PromotionStore(workspaceFolder);
  }

  private async runVerifiedLifecycleMutation<T extends { verified?: boolean }>(
    busyLabel: string,
    operationLabel: string,
    operation: () => Promise<T>,
    record?: (result: T) => Promise<unknown>,
  ): Promise<AiInvocationResult> {
    const data = await this.runExclusive(busyLabel, async () => {
      const result = await operation();
      assertLifecycleVerification(result.verified, operationLabel);
      if (record) {
        await record(result);
      }
      return result;
    });
    return lifecycleMutationInvocationResult(operationLabel, data);
  }

  private async runExclusive<T>(
    label: string,
    operation: () => Promise<T>,
  ): Promise<T | undefined> {
    if (this.busy) {
      vscode.window.showWarningMessage('Ecode: 已有同步操作正在执行');
      return;
    }
    this.busy = true;
    await this.updateViews(label);
    try {
      return await operation();
    } catch (error: unknown) {
      if (error instanceof SyncCancelledError) {
        vscode.window.showInformationMessage('Ecode: 操作已取消');
      } else {
        const message = errorMessage(error);
        output.error(message);
        vscode.window.showErrorMessage(`Ecode: ${message}`);
      }
      if (this.activeAiInvocations > 0) {
        throw error;
      }
    } finally {
      this.busy = false;
      await this.updateViews();
    }
  }

  private configureLocalWatcher(profile: ConnectionProfile): void {
    this.localWatcher?.dispose();
    this.localWatcher = undefined;
    if (this.localRefreshTimer) {
      clearTimeout(this.localRefreshTimer);
      this.localRefreshTimer = undefined;
    }

    const syncRoot = resolveEnvironmentSourceRoot(
      profile.workspaceFolder,
      profile.environmentDirectory,
    );
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(syncRoot, '**/*'),
    );
    const schedule = (): void => {
      this.scheduleLocalRefresh();
      this.scheduleAiRefresh();
    };
    this.localWatcher = vscode.Disposable.from(
      watcher,
      watcher.onDidCreate(schedule),
      watcher.onDidChange(schedule),
      watcher.onDidDelete(schedule),
    );
  }

  private activateWorkspaceContext(profile: ConnectionProfile): void {
    // Store 与两个 Watcher 必须在同一个同步片段中切换，避免后续异步刷新失败时
    // 留下“新 Store + 旧 Watcher”的混合上下文。
    this.store.setWorkspaceFolder(profile.workspaceFolder);
    this.changes = [];
    this.configureLocalWatcher(profile);
    this.aiRequests.configure(profile.workspaceFolder);
  }

  private async refreshWorkspaceContext(profile: ConnectionProfile): Promise<void> {
    await this.formMetadataRegistry.reload(profile, this.store);
    this.changes = await this.service.refreshLocalChanges();
    await this.refreshAiSupport(false);
  }

  private scheduleLocalRefresh(): void {
    if (this.localRefreshTimer) {
      clearTimeout(this.localRefreshTimer);
    }
    this.localRefreshTimer = setTimeout(() => {
      this.localRefreshTimer = undefined;
      void this.refreshLocalChangesAutomatically();
    }, 2000);
  }

  private async refreshLocalChangesAutomatically(): Promise<void> {
    if (this.busy) {
      this.scheduleLocalRefresh();
      return;
    }
    this.busy = true;
    try {
      this.changes = await this.service.refreshLocalChanges();
      await this.updateViews();
    } catch (error: unknown) {
      output.warn(`Automatic local scan failed: ${errorMessage(error)}`);
    } finally {
      this.busy = false;
    }
  }

  private async updateViews(busyMessage?: string): Promise<void> {
    const profile = await this.store.getProfile();
    const activeEnvironment = await this.store.getActiveEnvironment();
    const environments = await this.store.getEnvironments();
    const lifecycleSourceRoot = profile
      ? resolveEnvironmentSourceRoot(
          profile.workspaceFolder,
          profile.environmentDirectory,
        )
      : undefined;
    const lifecycleIdentity = profile && lifecycleSourceRoot
      ? lifecycleConnectionIdentity(
          profile.environmentId,
          lifecycleSourceRoot,
          profile.serverUrl,
          profile.username,
        )
      : undefined;
    if (
      !sameLocalPath(this.lifecycleSnapshotSourceRoot, lifecycleSourceRoot)
      || this.lifecycleSnapshotIdentity !== lifecycleIdentity
    ) {
      this.lifecycleSnapshot = undefined;
      this.lifecycleSnapshotSourceRoot = lifecycleSourceRoot;
      this.lifecycleSnapshotIdentity = lifecycleIdentity;
      this.lifecycleSnapshotFresh = false;
      if (profile && lifecycleSourceRoot) {
        const cached = await this.lifecycle.getCachedSnapshot();
        if (
          sameLocalPath(this.lifecycleSnapshotSourceRoot, lifecycleSourceRoot)
          && this.lifecycleSnapshotIdentity === lifecycleIdentity
        ) {
          this.lifecycleSnapshot = cached?.snapshot;
        }
      }
    }
    this.workspaceChangeDecorations.update(lifecycleSourceRoot, this.changes);
    await vscode.commands.executeCommand(
      'setContext',
      'ecode.aiSupportEnabled',
      Boolean(profile && this.aiSupport.isEnabled(profile.workspaceFolder)),
    );
    this.componentRegistry.setSourceRoots(environments.map(environment =>
      resolveEnvironmentSourceRoot(
        environment.workspaceFolder,
        environment.directory,
      )));
    const lastSyncByEnvironment = new Map<string, string>();
    let changeSets: ChangeSet[] = [];
    let deployments: DeploymentRecord[] = [];
    let pushRecords: PushRecord[] = [];
    let lifecycleRecords: LifecycleChangeRecord[] = [];
    const manifestLoadOrder = [...environments].sort((left, right) =>
      Number(left.id === activeEnvironment?.id)
      - Number(right.id === activeEnvironment?.id));
    for (const environment of manifestLoadOrder) {
      try {
        const syncRoot = resolveEnvironmentSourceRoot(
          environment.workspaceFolder,
          environment.directory,
        );
        const manifest = await this.store.loadManifest(
          serverFingerprint(environment.serverUrl, environment.username),
          syncRoot,
        );
        if (Date.parse(manifest.updatedAt) > 0) {
          lastSyncByEnvironment.set(
            environment.id,
            new Date(manifest.updatedAt).toLocaleString(),
          );
        }
      } catch (error: unknown) {
        output.warn(
          `Unable to read last sync state for ${environment.name}: ${errorMessage(error)}`,
        );
      }
    }
    if (profile) {
      try {
        const promotionStore = this.promotionStore(profile.workspaceFolder);
        [changeSets, deployments, pushRecords, lifecycleRecords] = await Promise.all([
          promotionStore.listChangeSets(),
          promotionStore.listDeployments(),
          promotionStore.listPushRecords(),
          promotionStore.listLifecycleRecords(),
        ]);
        changeSets.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        deployments.sort((left, right) =>
          right.completedAt.localeCompare(left.completedAt));
      } catch (error: unknown) {
        output.warn(`Unable to read promotion state: ${errorMessage(error)}`);
      }
    }
    const appMetadataByEnvironment = new Map<string, EcodeAppMetadata[]>();
    await Promise.all(environments.map(async environment => {
      try {
        const sourceRoot = resolveEnvironmentSourceRoot(
          environment.workspaceFolder,
          environment.directory,
        );
        const snapshot = await this.store.loadAppMetadata(sourceRoot);
        appMetadataByEnvironment.set(environment.id, snapshot?.apps ?? []);
      } catch (error: unknown) {
        output.warn(`Unable to read App metadata for ${environment.name}: ${errorMessage(error)}`);
      }
    }));
    const environmentStates: EnvironmentTreeState[] = environments.map(environment => {
      const active = environment.id === activeEnvironment?.id;
      const environmentSourceRoot = resolveEnvironmentSourceRoot(
        environment.workspaceFolder,
        environment.directory,
      );
      const environmentLifecycleIdentity = lifecycleConnectionIdentity(
        environment.id,
        environmentSourceRoot,
        environment.serverUrl,
        environment.username,
      );
      const hasCurrentLifecycle = active
        && sameLocalPath(this.lifecycleSnapshotSourceRoot, environmentSourceRoot)
        && this.lifecycleSnapshotIdentity === environmentLifecycleIdentity;
      return {
        environment,
        active,
        lastSync: lastSyncByEnvironment.get(environment.id),
        changes: active ? this.changes : undefined,
        pushRecords: pushRecords.filter(record =>
          record.environmentId === environment.id),
        lifecycleRecords: lifecycleRecords.filter(record =>
          record.environmentId === environment.id),
        busyMessage: active ? busyMessage : undefined,
        lifecycle: hasCurrentLifecycle && this.lifecycleSnapshot
          ? this.lifecycleSnapshot
          : undefined,
        lifecycleFresh: hasCurrentLifecycle
          && this.lifecycleSnapshotFresh
          && Boolean(this.lifecycleSnapshot),
        apps: appMetadataByEnvironment.get(environment.id) ?? [],
      };
    });
    this.tree.update(
      environmentStates,
      changeSets,
      deployments,
    );
    const count = this.changes.filter(change => change.status !== 'clean').length;
    this.status.text = busyMessage
      ? '$(sync~spin) Ecode'
      : count > 0 ? `$(cloud) Ecode ${count}` : '$(cloud) Ecode';
    this.status.tooltip = profile
      ? `${profile.serverUrl}\n源码目录: ${profile.environmentDirectory}/\n${count} 项变更或警告`
      : '尚未配置 Ecode 环境';
    this.status.command = profile
      ? 'ecode.refreshChanges'
      : 'ecode.configure';
    this.status.show();
  }
}

async function selectWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    vscode.window.showErrorMessage('Ecode: 请先打开一个工作区文件夹');
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }
  const selected = await vscode.window.showQuickPick(
    folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })),
    { title: '选择 Ecode 同步所在的工作区文件夹' },
  );
  return selected?.folder;
}

function validateServerUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol)
      ? undefined
      : '仅支持 http:// 或 https:// 地址';
  } catch {
    return '请输入有效的服务器地址';
  }
}

export function isPushableChange(change: SyncChange): boolean {
  return ['localAdded', 'localModified', 'localDeleted'].includes(change.status)
    || (
      change.status === 'conflict'
      && change.localHash !== undefined
      && change.localHash === change.remoteHash
    );
}

export function visibleAiChanges(changes: readonly SyncChange[]): SyncChange[] {
  return changes.filter(change => change.status !== 'clean');
}

export function lifecycleMutationInvocationResult<T>(
  operationLabel: string,
  data: T | undefined,
): AiInvocationResult {
  return data === undefined
    ? {
        status: 'failed',
        message: `${operationLabel}未完成，远端状态可能不确定，请重新查询生命周期状态确认`,
      }
    : { status: 'succeeded', data };
}

export function countChanges(
  changes: readonly SyncChange[],
): Record<string, number> {
  const counts: Record<string, number> = { total: changes.length };
  for (const change of changes) {
    counts[change.status] = (counts[change.status] ?? 0) + 1;
  }
  return counts;
}

export function validateEnvironmentName(
  value: string,
  environments: EnvironmentProfile[],
  workspaceFolder: string,
  editingEnvironmentId?: string,
): string | undefined {
  const name = value.trim();
  if (!name) {
    return '环境名称不能为空';
  }
  const workspaceKey = path.resolve(workspaceFolder).toLocaleLowerCase('en-US');
  const nameKey = name.toLocaleLowerCase('en-US');
  const duplicate = environments.find(environment =>
    environment.id !== editingEnvironmentId
    && path.resolve(environment.workspaceFolder).toLocaleLowerCase('en-US') === workspaceKey
    && environment.name.trim().toLocaleLowerCase('en-US') === nameKey);
  return duplicate
    ? `环境名称“${duplicate.name}”已存在`
    : undefined;
}

export function validateEnvironmentDirectoryInput(
  value: string,
  environments: EnvironmentProfile[],
  editingEnvironment?: EnvironmentProfile,
): string | undefined {
  const validation = validateEnvironmentDirectory(value);
  if (validation) {
    return validation;
  }
  const directory = value.trim();
  const directoryKey = directory.toLocaleLowerCase('en-US');
  if (
    editingEnvironment
    && editingEnvironment.directory.toLocaleLowerCase('en-US') !== directoryKey
  ) {
    return '环境目录创建后不可修改；如需更换目录，请新增环境';
  }
  const duplicate = environments.find(environment =>
    environment.id !== editingEnvironment?.id
    && environment.directory.toLocaleLowerCase('en-US') === directoryKey);
  return duplicate
    ? `环境目录“${duplicate.directory}”已由环境“${duplicate.name}”使用`
    : undefined;
}

export function switchEnvironmentCandidates(
  currentEnvironmentId: string | undefined,
  environments: EnvironmentProfile[],
): EnvironmentProfile[] {
  return environments.filter(environment => environment.id !== currentEnvironmentId);
}

function showResult(operation: string, result: SyncOperationResult): void {
  const summary = `${operation}完成：${result.pulled} 拉取，${result.pushed} 推送，`
    + `${result.deletedLocal} 个本地删除，${result.deletedRemote} 个远端删除，`
    + `${result.conflicts} 冲突，${result.unsupported} 不支持，${result.failed} 失败`;
  if (result.errors.length > 0) {
    output.error(result.errors.join('\n'));
  }
  if (!result.success) {
    vscode.window.showWarningMessage(`${summary}。详情见 Ecode Output`);
  } else {
    vscode.window.showInformationMessage(summary);
  }
}

function toConnectionProfile(environment: EnvironmentProfile): ConnectionProfile {
  return {
    version: 4,
    environmentId: environment.id,
    environmentDirectory: environment.directory,
    workspaceFolder: environment.workspaceFolder,
    serverUrl: environment.serverUrl,
    username: environment.username,
  };
}

function deploymentStatus(
  files: DeploymentFileResult[],
  lifecycle: DeploymentLifecycleResult[] = [],
): DeploymentRecord['status'] {
  const statuses = [
    ...files.map(file => file.status),
    ...lifecycle.map(item => item.status),
  ];
  if (statuses.length > 0 && statuses.every(status => status === 'succeeded')) {
    return 'succeeded';
  }
  if (statuses.some(status => status === 'succeeded')) {
    return 'partial';
  }
  if (files.some(file => file.status === 'conflict')) {
    return 'conflict';
  }
  return 'failed';
}

function formatPromotionFailures(
  prefix: string,
  files: DeploymentFileResult[],
  lifecycle: DeploymentLifecycleResult[] = [],
): string {
  const failures = [
    ...files.filter(file => file.status === 'conflict' || file.status === 'failed')
      .map(file => ({ path: file.path, message: file.message ?? file.status })),
    ...lifecycle.filter(item => item.status !== 'succeeded')
      .map(item => ({ path: item.path, message: item.message ?? item.status })),
  ];
  const detail = failures.slice(0, 3)
    .map(item => `${item.path}: ${item.message}`)
    .join('；');
  const remaining = failures.length > 3 ? `；另有 ${failures.length - 3} 项` : '';
  return detail ? `${prefix}：${detail}${remaining}` : prefix;
}

function appliedLifecycleChange(
  source: LifecycleChange,
  result: DeploymentLifecycleResult,
): LifecycleChange | undefined {
  if (result.status !== 'succeeded' || result.changed !== true) {
    return undefined;
  }
  const verifiedAt = new Date().toISOString();
  if (source.kind === 'preloadOrder' && typeof result.previous === 'string') {
    return { ...source, before: result.previous, verifiedAt };
  }
  if (source.kind !== 'preloadOrder' && typeof result.previous === 'boolean') {
    return { ...source, before: result.previous, verifiedAt };
  }
  return undefined;
}

function lifecycleRecordFromCommandArgument(
  argument: unknown,
): LifecycleChangeRecord | undefined {
  if (
    argument
    && typeof argument === 'object'
    && 'record' in argument
  ) {
    return lifecycleRecordFromCommandArgument(argument.record);
  }
  if (
    !argument
    || typeof argument !== 'object'
    || !('id' in argument)
    || typeof argument.id !== 'string'
    || !('environmentId' in argument)
    || typeof argument.environmentId !== 'string'
    || !('change' in argument)
  ) {
    return undefined;
  }
  return argument as LifecycleChangeRecord;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function promotionResourceSummary(
  label: string,
  remotePath: string,
  size: number | undefined,
  hash: string | undefined,
  exists: boolean,
): string {
  return [
    `${label}二进制资源摘要`,
    '',
    `路径: ${remotePath}`,
    `扩展名: ${path.posix.extname(remotePath) || '(无)'}`,
    `存在: ${exists ? '是' : '否'}`,
    `大小: ${size === undefined ? '(未知)' : `${size} bytes`}`,
    `SHA-256: ${hash ?? '(无)'}`,
    '',
    '二进制资源不执行文本 Diff。',
  ].join('\n');
}

function requireLifecycleTreePath(
  argument: unknown,
  expected: 'file' | 'folder',
): string {
  if (
    !argument
    || typeof argument !== 'object'
    || !('type' in argument)
    || argument.type !== 'lifecycleSource'
    || !('kind' in argument)
    || argument.kind !== expected
    || !('remotePath' in argument)
    || typeof argument.remotePath !== 'string'
  ) {
    throw new Error(
      expected === 'folder'
        ? '请在 Ecode 侧边栏源码目录中选择根文件夹'
        : '请在 Ecode 侧边栏源码目录中选择文件',
    );
  }
  return normalizeRemotePath(argument.remotePath);
}

function requireLifecyclePath<T extends { path: string }>(
  items: readonly T[],
  remotePath: string,
  targetLabel: string,
): T {
  const key = normalizeRemotePath(remotePath).toLocaleLowerCase('en-US');
  const matches = items.filter(item =>
    item.path.toLocaleLowerCase('en-US') === key);
  if (matches.length === 0) {
    throw new Error(`找不到${targetLabel}: ${remotePath}`);
  }
  if (matches.length > 1) {
    throw new Error(`${targetLabel}路径不唯一，无法安全操作: ${remotePath}`);
  }
  return matches[0];
}

function sameLocalPath(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return path.resolve(left).toLocaleLowerCase('en-US')
    === path.resolve(right).toLocaleLowerCase('en-US');
}

function sameRemotePath(left: string, right: string): boolean {
  return left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US');
}

function assertLifecycleVerification(
  verified: boolean | undefined,
  operation: string,
): void {
  if (verified !== true) {
    throw new Error(
      verified === false
        ? `${operation}接口返回成功，但远端状态复核未通过`
        : `${operation}接口可能已写入，但当前服务端无法回读确认；未生成生命周期记录`,
    );
  }
}

function confirmedOperationResult(
  completed: boolean,
  successMessage: string,
  cancelledMessage: string,
): AiInvocationResult {
  return completed
    ? { status: 'succeeded', message: successMessage }
    : { status: 'cancelled', message: cancelledMessage };
}

function changeSetApplicationResult(
  status: DeploymentRecord['status'] | false,
): AiInvocationResult {
  if (status === false) {
    return { status: 'cancelled', message: '用户未确认应用变更集或操作未开始' };
  }
  if (status === 'succeeded') {
    return { status: 'succeeded', data: { deploymentStatus: status } };
  }
  return {
    status: status === 'partial' ? 'partial' : 'failed',
    data: { deploymentStatus: status },
    message: `变更集应用结果：${status}`,
  };
}

function isPushRecord(candidate: unknown): candidate is PushRecord {
  return typeof candidate === 'object'
    && candidate !== null
    && 'environmentId' in candidate
    && 'files' in candidate;
}

function isEnvironmentProfile(candidate: unknown): candidate is EnvironmentProfile {
  return typeof candidate === 'object'
    && candidate !== null
    && 'id' in candidate
    && typeof candidate.id === 'string'
    && 'directory' in candidate
    && typeof candidate.directory === 'string';
}

function environmentFromCommandArgument(
  argument: unknown,
): EnvironmentProfile | undefined {
  if (isEnvironmentProfile(argument)) {
    return argument;
  }
  if (
    typeof argument === 'object'
    && argument !== null
    && 'state' in argument
    && typeof argument.state === 'object'
    && argument.state !== null
    && 'environment' in argument.state
    && isEnvironmentProfile(argument.state.environment)
  ) {
    return argument.state.environment;
  }
  return undefined;
}

function pushRecordFromCommandArgument(argument: unknown): PushRecord | undefined {
  if (isPushRecord(argument)) {
    return argument;
  }
  if (
    typeof argument === 'object'
    && argument !== null
    && 'record' in argument
    && isPushRecord(argument.record)
  ) {
    return argument.record;
  }
  return undefined;
}

function isChangeSet(candidate: unknown): candidate is ChangeSet {
  return typeof candidate === 'object'
    && candidate !== null
    && 'sourceEnvironmentId' in candidate
    && 'files' in candidate;
}

function pushRecordFileSelection(
  argument: unknown,
  explicitRemotePath?: string,
): { record: PushRecord; remotePath: string } | undefined {
  if (isPushRecord(argument) && explicitRemotePath) {
    return { record: argument, remotePath: explicitRemotePath };
  }
  if (
    typeof argument === 'object'
    && argument !== null
    && 'record' in argument
    && isPushRecord(argument.record)
    && 'file' in argument
    && typeof argument.file === 'object'
    && argument.file !== null
    && 'path' in argument.file
    && typeof argument.file.path === 'string'
  ) {
    return { record: argument.record, remotePath: argument.file.path };
  }
  return undefined;
}

function changeSetFromCommandArgument(argument: unknown): ChangeSet | undefined {
  if (isChangeSet(argument)) {
    return argument;
  }
  if (
    typeof argument === 'object'
    && argument !== null
    && 'changeSet' in argument
    && isChangeSet(argument.changeSet)
  ) {
    return argument.changeSet;
  }
  return undefined;
}
