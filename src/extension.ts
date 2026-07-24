import * as fs from 'fs';
import * as vscode from 'vscode';
import { resolveSafeLocalPath, resolveSafeSyncRoot } from './domain/paths';
import { serverFingerprint } from './domain/text';
import type { ConnectionProfile, SyncChange, SyncOperationResult } from './domain/types';
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
  const controller = new ExtensionController(context, store, auth, service, tree, status);

  context.subscriptions.push(
    output,
    status,
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
    ...controller.registerCommands(),
  );

  await controller.initialize();
  output.info('Ecode Local 0.2.0 activated without network access');
}

export function deactivate(): void {
  // 没有后台任务或自动同步需要清理。
}

class ExtensionController {
  private busy = false;
  private changes: SyncChange[] = [];
  private localWatcher: vscode.Disposable | undefined;
  private localRefreshTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: WorkspaceStore,
    private readonly auth: AuthManager,
    private readonly service: EcodeSyncService,
    private readonly tree: EcodeTreeProvider,
    private readonly status: vscode.StatusBarItem,
  ) {}

  registerCommands(): vscode.Disposable[] {
    return [
      vscode.commands.registerCommand('ecode.configure', () => this.configure()),
      vscode.commands.registerCommand('ecode.setup', () => this.configure()),
      vscode.commands.registerCommand('ecode.pull', () => this.pull()),
      vscode.commands.registerCommand('ecode.refreshChanges', () => this.refreshChanges()),
      vscode.commands.registerCommand('ecode.pushSelected', () => this.pushSelected()),
      vscode.commands.registerCommand('ecode.openDiff', (change: SyncChange) => this.openDiff(change)),
      vscode.commands.registerCommand('ecode.resolveConflict', (change: SyncChange) =>
        this.resolveConflict(change)),
    ];
  }

  async initialize(): Promise<void> {
    const profile = await this.store.getProfile();
    if (profile) {
      try {
        this.changes = await this.service.refreshLocalChanges();
      } catch (error: unknown) {
        output.warn(`Initial local scan failed: ${errorMessage(error)}`);
      }
      this.configureLocalWatcher(profile);
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
  }

  private async configure(): Promise<void> {
    if (this.busy) {
      return;
    }
    const workspaceFolder = await selectWorkspaceFolder();
    if (!workspaceFolder) {
      return;
    }

    const previous = await this.store.getProfile();
    const serverUrl = await vscode.window.showInputBox({
      title: '配置 Ecode 连接 (1/4)',
      prompt: 'E-cology 服务器地址',
      value: previous?.serverUrl ?? 'http://localhost:8099',
      ignoreFocusOut: true,
      validateInput: validateServerUrl,
    });
    if (!serverUrl) {
      return;
    }

    const username = await vscode.window.showInputBox({
      title: '配置 Ecode 连接 (2/4)',
      prompt: '登录用户名',
      value: previous?.username ?? 'sysadmin',
      ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : '用户名不能为空',
    });
    if (!username) {
      return;
    }

    const password = await vscode.window.showInputBox({
      title: '配置 Ecode 连接 (3/4)',
      prompt: '密码将保存到 VS Code SecretStorage',
      password: true,
      ignoreFocusOut: true,
      validateInput: value => value ? undefined : '密码不能为空',
    });
    if (!password) {
      return;
    }

    const localDirectory = await vscode.window.showInputBox({
      title: '配置 Ecode 连接 (4/4)',
      prompt: '工作区内的本地同步子目录',
      value: previous?.localDirectory ?? 'ecode',
      ignoreFocusOut: true,
      validateInput: value => validateLocalDirectory(workspaceFolder.uri.fsPath, value),
    });
    if (!localDirectory) {
      return;
    }

    const profile: ConnectionProfile = {
      version: 2,
      workspaceFolder: workspaceFolder.uri.fsPath,
      serverUrl: serverUrl.trim().replace(/\/+$/, ''),
      username: username.trim(),
      localDirectory: localDirectory.trim(),
    };

    await this.runExclusive('正在测试连接...', async () => {
      const result = await this.auth.connect(profile, password);
      if (!result.success) {
        throw new Error(result.message);
      }
      await this.store.saveProfile(profile);
      this.changes = await this.service.refreshLocalChanges();
      this.configureLocalWatcher(profile);
      vscode.window.showInformationMessage('Ecode: 连接配置已保存，请手动执行拉取');
    });
  }

  private async pull(): Promise<void> {
    const profile = await this.requireProfile();
    if (!profile) {
      return;
    }
    const syncRoot = resolveSafeSyncRoot(profile.workspaceFolder, profile.localDirectory);
    const choice = await vscode.window.showWarningMessage(
      `将全量检查远端源码并安全拉取到 ${syncRoot}。本地修改不会被覆盖。`,
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
      change.status === 'localAdded' || change.status === 'localModified',
    );
    if (pushable.length === 0) {
      vscode.window.showInformationMessage('Ecode: 没有可推送的新增或修改文件');
      await this.updateViews();
      return;
    }

    const selected = await vscode.window.showQuickPick(
      pushable.map(change => ({
        label: change.path,
        description: change.status === 'localAdded' ? '新增' : '修改',
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

    const confirmation = await vscode.window.showWarningMessage(
      `确认向 ${profile.serverUrl} 推送 ${selected.length} 个文件？`
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
        resolveSafeSyncRoot(profile.workspaceFolder, profile.localDirectory),
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
      vscode.window.showWarningMessage(
        'Ecode 0.2.0 只检测远端删除，不执行删除冲突解决。请在服务器恢复文件或另存本地代码。',
      );
      return;
    }
    const action = await vscode.window.showQuickPick([
      {
        label: '接受最新远端',
        description: '先备份本地内容，再以远端内容替换本地',
        value: 'acceptRemote' as const,
      },
      {
        label: '已手工合并，保留当前本地',
        description: '将最新远端设为新基线，当前本地内容仍待推送',
        value: 'markMerged' as const,
      },
    ], { title: `解决冲突: ${change.path}` });
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

  private async requireProfile(): Promise<ConnectionProfile | undefined> {
    const profile = await this.store.getProfile();
    if (!profile) {
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

    const syncRoot = resolveSafeSyncRoot(profile.workspaceFolder, profile.localDirectory);
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(syncRoot, '**/*'),
    );
    const schedule = (): void => this.scheduleLocalRefresh();
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
    }, 5000);
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
        const syncRoot = resolveSafeSyncRoot(profile.workspaceFolder, profile.localDirectory);
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
    this.tree.update(profile, this.changes, busyMessage, lastSync);
    const count = this.changes.filter(change => change.status !== 'clean').length;
    this.status.text = busyMessage
      ? '$(sync~spin) Ecode'
      : count > 0 ? `$(cloud) Ecode ${count}` : '$(cloud) Ecode';
    this.status.tooltip = profile
      ? `${profile.serverUrl}\n${count} 项变更或警告`
      : '尚未配置 Ecode 连接';
    this.status.command = profile ? 'ecode.refreshChanges' : 'ecode.configure';
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

function validateLocalDirectory(workspaceFolder: string, value: string): string | undefined {
  try {
    resolveSafeSyncRoot(workspaceFolder, value);
    return undefined;
  } catch (error: unknown) {
    return errorMessage(error);
  }
}

function showResult(operation: string, result: SyncOperationResult): void {
  const summary = `${operation}完成：${result.pulled} 拉取，${result.pushed} 推送，`
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
