import * as fs from 'fs';
import * as vscode from 'vscode';
import { AiSupportService } from './ai/AiSupportService';
import { ECODE_SOURCE_DIRECTORY } from './domain/constants';
import { resolveEcodeSourceRoot, resolveSafeLocalPath } from './domain/paths';
import { classifyLegacyProfile } from './domain/profileMigration';
import { serverFingerprint } from './domain/text';
import type {
  ConnectionProfile,
  LegacyConnectionProfile,
  SyncChange,
  SyncOperationResult,
} from './domain/types';
import { registerEcodeLanguageFeatures } from './language/EcodeLanguageProvider';
import { WorkspaceComponentRegistry } from './language/WorkspaceComponentRegistry';
import { WorkspaceFormMetadataRegistry } from './language/WorkspaceFormMetadataRegistry';
import { WorkspaceStore } from './storage/WorkspaceStore';
import { EcodeSyncService, SyncCancelledError } from './sync/EcodeSyncService';
import { AuthManager } from './sync/auth/AuthManager';
import { EcodeTreeProvider } from './ui/EcodeTreeProvider';
import {
  BASELINE_SCHEME,
  EMPTY_SCHEME,
  REMOTE_SCHEME,
  VirtualDocumentProvider,
  virtualUri,
} from './ui/VirtualDocumentProvider';

let output: vscode.LogOutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('Ecode', { log: true });
  const store = new WorkspaceStore(context);
  const auth = new AuthManager(context);
  const service = new EcodeSyncService(store, auth, output);
  const tree = new EcodeTreeProvider();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const componentRegistry = new WorkspaceComponentRegistry();
  const formMetadataRegistry = new WorkspaceFormMetadataRegistry();
  const extensionVersion = String(context.extension.packageJSON.version ?? 'unknown');
  const aiSupport = new AiSupportService(
    componentRegistry,
    formMetadataRegistry,
    extensionVersion,
    output,
  );
  const controller = new ExtensionController(
    context,
    store,
    auth,
    service,
    tree,
    status,
    componentRegistry,
    formMetadataRegistry,
    aiSupport,
  );

  context.subscriptions.push(
    output,
    status,
    componentRegistry,
    formMetadataRegistry,
    controller,
    vscode.window.registerTreeDataProvider('ecode.workspace', tree),
    vscode.workspace.registerTextDocumentContentProvider(
      BASELINE_SCHEME,
      new VirtualDocumentProvider(BASELINE_SCHEME, service),
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      REMOTE_SCHEME,
      new VirtualDocumentProvider(REMOTE_SCHEME, service),
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      EMPTY_SCHEME,
      new VirtualDocumentProvider(EMPTY_SCHEME, service),
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

class ExtensionController {
  private busy = false;
  private changes: SyncChange[] = [];
  private localWatcher: vscode.Disposable | undefined;
  private localRefreshTimer: NodeJS.Timeout | undefined;
  private aiRefreshTimer: NodeJS.Timeout | undefined;
  private legacyProfile: LegacyConnectionProfile | undefined;
  private lastAiSupportError: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: WorkspaceStore,
    private readonly auth: AuthManager,
    private readonly service: EcodeSyncService,
    private readonly tree: EcodeTreeProvider,
    private readonly status: vscode.StatusBarItem,
    private readonly componentRegistry: WorkspaceComponentRegistry,
    private readonly formMetadataRegistry: WorkspaceFormMetadataRegistry,
    private readonly aiSupport: AiSupportService,
  ) {}

  registerCommands(): vscode.Disposable[] {
    return [
      vscode.commands.registerCommand('ecode.configure', () => this.configure()),
      vscode.commands.registerCommand('ecode.setup', () => this.configure()),
      vscode.commands.registerCommand('ecode.pull', () => this.pull()),
      vscode.commands.registerCommand('ecode.refreshChanges', () => this.refreshChanges()),
      vscode.commands.registerCommand('ecode.pushSelected', () => this.pushSelected()),
      vscode.commands.registerCommand('ecode.openDiff', (change: SyncChange) => this.openDiff(change)),
      vscode.commands.registerCommand('ecode.revertChange', (change?: SyncChange) =>
        this.revertChange(change)),
      vscode.commands.registerCommand('ecode.resolveConflict', (change: SyncChange) =>
        this.resolveConflict(change)),
      vscode.commands.registerCommand('ecode.refreshAiSupport', () =>
        this.refreshAiSupport(true)),
      vscode.commands.registerCommand('ecode.openAiGuide', () =>
        this.runCommandSafely(() => this.openAiGuide())),
      vscode.commands.registerCommand('ecode.removeAiSupport', () =>
        this.runCommandSafely(() => this.removeAiSupport())),
      vscode.commands.registerCommand('ecode.confirmSourceDirectoryMigration', () =>
        this.runCommandSafely(() => this.confirmSourceDirectoryMigration())),
      this.componentRegistry.onDidChange(() => this.scheduleAiRefresh()),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('ecode.aiSupport.enabled')) {
          this.scheduleAiRefresh();
        }
      }),
    ];
  }

  async initialize(): Promise<void> {
    const profile = await this.loadActiveProfile();
    await this.formMetadataRegistry.reload(profile, this.store);
    if (profile) {
      try {
        this.changes = await this.service.refreshLocalChanges();
      } catch (error: unknown) {
        output.warn(`Initial local scan failed: ${errorMessage(error)}`);
      }
      this.configureLocalWatcher(profile);
      await this.refreshAiSupport(false);
    } else if (this.legacyProfile) {
      const action = await vscode.window.showWarningMessage(
        `Ecode: 旧连接使用自定义源码目录“${this.legacyProfile.localDirectory}”，同步已暂停。`,
        '确认改用 ecode',
      );
      if (action === '确认改用 ecode') {
        await this.runCommandSafely(() => this.confirmSourceDirectoryMigration());
      }
    }
    await this.updateViews();
  }

  dispose(): void {
    this.localWatcher?.dispose();
    this.localWatcher = undefined;
    if (this.localRefreshTimer) {
      clearTimeout(this.localRefreshTimer);
      this.localRefreshTimer = undefined;
    }
    if (this.aiRefreshTimer) {
      clearTimeout(this.aiRefreshTimer);
      this.aiRefreshTimer = undefined;
    }
  }

  private async configure(): Promise<void> {
    if (this.busy) {
      return;
    }
    const workspaceFolder = await selectWorkspaceFolder();
    if (!workspaceFolder) {
      return;
    }

    const previous = await this.store.getProfile()
      ?? this.legacyProfile
      ?? await this.store.getLegacyProfile();
    const serverUrl = await vscode.window.showInputBox({
      title: '配置 Ecode 连接 (1/3)',
      prompt: 'E-cology 服务器地址',
      value: previous?.serverUrl ?? 'http://localhost:8099',
      ignoreFocusOut: true,
      validateInput: validateServerUrl,
    });
    if (!serverUrl) {
      return;
    }

    const username = await vscode.window.showInputBox({
      title: '配置 Ecode 连接 (2/3)',
      prompt: '登录用户名',
      value: previous?.username ?? 'sysadmin',
      ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : '用户名不能为空',
    });
    if (!username) {
      return;
    }

    const password = await vscode.window.showInputBox({
      title: '配置 Ecode 连接 (3/3)',
      prompt: '密码将保存到 VS Code SecretStorage',
      password: true,
      ignoreFocusOut: true,
      validateInput: value => value ? undefined : '密码不能为空',
    });
    if (!password) {
      return;
    }

    const profile: ConnectionProfile = {
      version: 3,
      workspaceFolder: workspaceFolder.uri.fsPath,
      serverUrl: serverUrl.trim().replace(/\/+$/, ''),
      username: username.trim(),
    };

    await this.runExclusive('正在测试连接...', async () => {
      const result = await this.auth.connect(profile, password);
      if (!result.success) {
        throw new Error(result.message);
      }
      await this.store.saveProfile(profile);
      await this.store.clearLegacyProfile();
      this.legacyProfile = undefined;
      await this.formMetadataRegistry.reload(profile, this.store);
      this.changes = await this.service.refreshLocalChanges();
      this.configureLocalWatcher(profile);
      await this.refreshAiSupport(false);
      vscode.window.showInformationMessage('Ecode: 连接配置已保存，请手动执行拉取');
    });
  }

  private async pull(): Promise<void> {
    const profile = await this.requireProfile();
    if (!profile) {
      return;
    }
    const syncRoot = resolveEcodeSourceRoot(profile.workspaceFolder);
    const choice = await vscode.window.showWarningMessage(
      `将全量检查远端源码并安全拉取到 ${syncRoot}。`
        + '远端删除会同步到未修改的本地文件，删除前保存恢复副本；本地修改不会被覆盖。',
      { modal: true },
      '开始拉取',
    );
    if (choice !== '开始拉取') {
      return;
    }

    await this.runExclusive('正在拉取...', async () => {
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
    });
  }

  private async refreshChanges(): Promise<void> {
    await this.runExclusive('正在扫描本地变更...', async () => {
      this.changes = await this.service.refreshLocalChanges();
    });
  }

  private async pushSelected(): Promise<void> {
    const profile = await this.requireProfile();
    if (!profile) {
      return;
    }
    this.changes = await this.service.refreshLocalChanges();
    const pushable = this.changes.filter(change =>
      ['localAdded', 'localModified', 'localDeleted'].includes(change.status),
    );
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
          : change.status === 'localDeleted' ? '删除' : '修改',
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

    const deletionCount = selected.filter(item => item.change.status === 'localDeleted').length;
    const confirmation = await vscode.window.showWarningMessage(
      `确认向 ${profile.serverUrl} 推送 ${selected.length} 项变更`
        + `${deletionCount > 0 ? `（含 ${deletionCount} 个远端删除）` : ''}？`
        + ' JavaScript 将使用与 Ecode 在线编辑器一致的 Babel 7.5.5 配置生成编译内容。',
      { modal: true },
      '确认推送',
    );
    if (confirmation !== '确认推送') {
      return;
    }

    await this.runExclusive('正在推送...', async () => {
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Ecode: 安全推送',
        cancellable: true,
      }, (progress, token) => this.service.pushSelected(
        selected.map(item => item.change.path),
        message => progress.report({ message }),
        token,
      ));
      this.changes = this.service.getLastPlan()?.changes ?? [];
      showResult('推送', result);
    });
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
        resolveEcodeSourceRoot(profile.workspaceFolder),
        change.path,
      ),
    );
    const baseline = virtualUri(BASELINE_SCHEME, change.path);
    const remote = virtualUri(REMOTE_SCHEME, change.path);
    const empty = virtualUri(EMPTY_SCHEME, change.path);
    const localOrEmpty = fs.existsSync(local.fsPath) ? local : empty;

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

  private async resolveConflict(change: SyncChange): Promise<void> {
    if (change?.status !== 'conflict') {
      return;
    }
    if (change.conflictReason === 'remoteDeletedLocalModified') {
      const action = await vscode.window.showQuickPick([
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
      ], { title: `解决远端删除冲突: ${change.path}` });
      if (!action) {
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        action.value === 'acceptRemoteDeletion'
          ? '本地修改将保存为恢复副本，然后删除本地文件。'
          : '将确认远端文件仍不存在，并把当前本地文件标记为待新增。',
        { modal: true },
        '确认',
      );
      if (confirmed !== '确认') {
        return;
      }
      await this.runExclusive('正在解决删除冲突...', async () => {
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
      });
      return;
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
    const action = await vscode.window.showQuickPick(actions, { title: `解决冲突: ${change.path}` });
    if (!action) {
      return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      action.value === 'acceptRemote'
        ? '本地文件将被最新远端内容替换，替换前会保存恢复副本。'
        : '仅在已经检查并手工合并远端修改后使用此操作。',
      { modal: true },
      '确认',
    );
    if (confirmed !== '确认') {
      return;
    }

    await this.runExclusive('正在解决冲突...', async () => {
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
    });
  }

  private async revertChange(candidate?: SyncChange): Promise<void> {
    const profile = await this.requireProfile();
    if (!profile) {
      return;
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
      return;
    }

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
      return;
    }
    await this.runExclusive('正在回退本地变更...', async () => {
      const recovery = await this.service.revertLocalChange(change.path);
      this.changes = this.service.getLastPlan()?.changes ?? [];
      vscode.window.showInformationMessage(
        recovery ? `已回退本地变更；恢复副本: ${recovery}` : '已回退本地变更',
      );
    });
  }

  private async loadActiveProfile(): Promise<ConnectionProfile | undefined> {
    const current = await this.store.getProfile();
    if (current) {
      this.legacyProfile = undefined;
      return current;
    }
    const legacy = await this.store.getLegacyProfile();
    if (!legacy) {
      this.legacyProfile = undefined;
      return undefined;
    }
    try {
      const migration = classifyLegacyProfile(legacy);
      if (migration.kind === 'migrated') {
        await this.store.saveProfile(migration.profile);
        await this.store.clearLegacyProfile();
        this.legacyProfile = undefined;
        output.info('Migrated v2 connection profile with fixed ecode source directory');
        return migration.profile;
      }
    } catch (error: unknown) {
      output.warn(`Unable to validate legacy source directory: ${errorMessage(error)}`);
    }
    this.legacyProfile = legacy;
    return undefined;
  }

  private async confirmSourceDirectoryMigration(): Promise<void> {
    const legacy = this.legacyProfile ?? await this.store.getLegacyProfile();
    if (!legacy) {
      vscode.window.showInformationMessage('Ecode: 没有需要迁移的旧连接配置');
      return;
    }
    const sourceRoot = resolveEcodeSourceRoot(legacy.workspaceFolder);
    let entries: string[] = [];
    try {
      entries = await fs.promises.readdir(sourceRoot);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    if (entries.length > 0) {
      const confirmation = await vscode.window.showWarningMessage(
        `固定源码目录 ${sourceRoot} 已包含 ${entries.length} 个项目。`
          + '扩展不会覆盖或移动这些内容，确认将其作为新的同步源码目录吗？',
        { modal: true },
        '确认使用 ecode',
      );
      if (confirmation !== '确认使用 ecode') {
        return;
      }
    }
    const profile: ConnectionProfile = {
      version: 3,
      workspaceFolder: legacy.workspaceFolder,
      serverUrl: legacy.serverUrl,
      username: legacy.username,
    };
    await this.store.saveProfile(profile);
    await this.store.clearLegacyProfile();
    this.legacyProfile = undefined;
    await this.formMetadataRegistry.reload(profile, this.store);
    try {
      this.changes = await this.service.refreshLocalChanges();
    } catch (error: unknown) {
      output.warn(`Initial scan after source directory migration failed: ${errorMessage(error)}`);
      this.changes = [];
    }
    this.configureLocalWatcher(profile);
    await this.refreshAiSupport(false);
    await this.updateViews();
    vscode.window.showInformationMessage(
      `Ecode: 已改用固定源码目录 ${ECODE_SOURCE_DIRECTORY}/，旧目录未做任何修改`,
    );
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

  private async refreshAiSupport(showMessage: boolean): Promise<void> {
    const profile = await this.store.getProfile();
    if (!profile) {
      if (showMessage) {
        vscode.window.showErrorMessage('Ecode: 请先配置连接或完成源码目录迁移');
      }
      return;
    }
    if (!this.aiSupport.isEnabled(profile.workspaceFolder)) {
      if (showMessage) {
        vscode.window.showInformationMessage(
          'Ecode: 当前工作区已关闭 AI Coding 支持，请先启用 ecode.aiSupport.enabled',
        );
      }
      return;
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
    }
  }

  private async openAiGuide(): Promise<void> {
    const profile = await this.store.getProfile();
    if (!profile) {
      vscode.window.showErrorMessage('Ecode: 请先配置连接或完成源码目录迁移');
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

  private async removeAiSupport(): Promise<void> {
    const profile = await this.store.getProfile();
    if (!profile) {
      vscode.window.showErrorMessage('Ecode: 当前没有有效连接配置');
      return;
    }
    const confirmation = await vscode.window.showWarningMessage(
      '将删除 .ecode-local/ecode-ai 中由扩展管理的文件及 AGENTS.md 的 Ecode 管理区块。'
        + '其他文件不会被删除。',
      { modal: true },
      '移除 AI 支持',
    );
    if (confirmation !== '移除 AI 支持') {
      return;
    }
    await vscode.workspace
      .getConfiguration('ecode', vscode.Uri.file(profile.workspaceFolder))
      .update(
        'aiSupport.enabled',
        false,
        vscode.ConfigurationTarget.WorkspaceFolder,
      );
    await this.aiSupport.remove(profile.workspaceFolder);
    vscode.window.showInformationMessage('Ecode: 已移除当前工作区的 AI Coding 支持');
  }

  private async runCommandSafely(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error: unknown) {
      const message = errorMessage(error);
      output.error(message);
      vscode.window.showErrorMessage(`Ecode: ${message}`);
    }
  }

  private async requireProfile(): Promise<ConnectionProfile | undefined> {
    const profile = await this.store.getProfile();
    if (!profile) {
      if (this.legacyProfile ?? await this.store.getLegacyProfile()) {
        vscode.window.showErrorMessage(
          'Ecode: 旧连接使用自定义源码目录，请先确认迁移到固定的 ecode/ 目录',
        );
        return undefined;
      }
      vscode.window.showErrorMessage('Ecode: 请先配置连接');
      await this.configure();
      return this.store.getProfile();
    }
    return profile;
  }

  private async runExclusive(label: string, operation: () => Promise<void>): Promise<void> {
    if (this.busy) {
      vscode.window.showWarningMessage('Ecode: 已有同步操作正在执行');
      return;
    }
    this.busy = true;
    await this.updateViews(label);
    try {
      await operation();
    } catch (error: unknown) {
      if (error instanceof SyncCancelledError) {
        vscode.window.showInformationMessage('Ecode: 操作已取消');
      } else {
        const message = errorMessage(error);
        output.error(message);
        vscode.window.showErrorMessage(`Ecode: ${message}`);
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

    const syncRoot = resolveEcodeSourceRoot(profile.workspaceFolder);
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
    let lastSync: string | undefined;
    if (profile) {
      try {
        const syncRoot = resolveEcodeSourceRoot(profile.workspaceFolder);
        const manifest = await this.store.loadManifest(
          serverFingerprint(profile.serverUrl, profile.username),
          syncRoot,
        );
        if (Date.parse(manifest.updatedAt) > 0) {
          lastSync = new Date(manifest.updatedAt).toLocaleString();
        }
      } catch (error: unknown) {
        output.warn(`Unable to read last sync state: ${errorMessage(error)}`);
      }
    }
    this.tree.update(
      profile,
      this.changes,
      busyMessage,
      lastSync,
      this.legacyProfile,
    );
    const count = this.changes.filter(change => change.status !== 'clean').length;
    this.status.text = busyMessage
      ? '$(sync~spin) Ecode'
      : count > 0 ? `$(cloud) Ecode ${count}` : '$(cloud) Ecode';
    this.status.tooltip = profile
      ? `${profile.serverUrl}\n${count} 项变更或警告`
      : this.legacyProfile
        ? `旧源码目录 ${this.legacyProfile.localDirectory} 需要迁移`
        : '尚未配置 Ecode 连接';
    this.status.command = profile
      ? 'ecode.refreshChanges'
      : this.legacyProfile
        ? 'ecode.confirmSourceDirectoryMigration'
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
