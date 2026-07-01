import * as vscode from 'vscode';
import { AuthManager } from './sync/auth/AuthManager';
import { EcodeSyncEngine } from './sync/EcodeSyncEngine';
import { SetupPanel } from './ui/webview/SetupPanel';

let authManager: AuthManager;
let syncEngine: EcodeSyncEngine;
let statusBar: vscode.StatusBarItem;
let output: vscode.LogOutputChannel;

export async function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Ecode', { log: true });
  output.info('Ecode extension activating...');

  authManager = new AuthManager(context);
  syncEngine = new EcodeSyncEngine(authManager, output);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(statusBar);

  registerCommands(context);
  resetStatusBar();

  // 自动登录（仅连接，不触发下载）
  const loginReady = await authManager.isLoginReady();
  if (loginReady) {
    const client = await authManager.autoLogin();
    if (client) {
      output.info('Auto-login succeeded');
    }
  } else {
    output.info('No credentials — opening setup');
    vscode.commands.executeCommand('ecode.setup');
  }

  output.info('Ecode extension activated');
}

export function deactivate() {
  // 当前版本无自动任务需要清理
}

// ==================== 命令注册 ====================

function registerCommands(context: vscode.ExtensionContext) {

  // 悬停菜单动作
  context.subscriptions.push(vscode.commands.registerCommand('ecode.menuPull', async () => {
    const client = await authManager.autoLogin();
    if (!client) {
      vscode.commands.executeCommand('ecode.setup');
    } else {
      pullCode('manual').catch(err => output.error(`Pull failed: ${err}`));
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('ecode.menuPush', async () => {
    const client = await authManager.autoLogin();
    if (!client) {
      vscode.window.showErrorMessage('Ecode: 未连接，请先配置服务器');
      vscode.commands.executeCommand('ecode.setup');
      return;
    }

    // 获取变更状态
    const status = await syncEngine.getStatus();
    const changes = status.filter(d => d.status === 'added' || d.status === 'modified');

    if (changes.length === 0) {
      vscode.window.showInformationMessage('Ecode: 没有需要推送的更改');
      return;
    }

    // 展示变更摘要
    const summary = changes.slice(0, 5).map(d =>
      `${d.status === 'added' ? '+' : '~'} ${d.path}`
    ).join('\n');
    const more = changes.length > 5 ? `\n  ... 还有 ${changes.length - 5} 个文件` : '';

    const choice = await vscode.window.showInformationMessage(
      `将推送 ${changes.length} 个文件:\n${summary}${more}`,
      { modal: false },
      '确认推送',
    );
    if (choice !== '确认推送') { return; }

    // 推送
    statusBar.text = '$(sync~spin) 推送中...';
    try {
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Ecode: 推送代码...',
        cancellable: false,
      }, async () => {
        return syncEngine.pushChanged();
      });

      if (result.success) {
        vscode.window.showInformationMessage(`推送完成: ${result.pushed} 个文件`);
      } else {
        vscode.window.showWarningMessage(
          `推送完成: ${result.pushed} 成功, ${result.failed} 失败. 查看 Ecode Output 面板`,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`推送失败: ${msg}`);
      output.error(`Push failed: ${err}`);
    }
    resetStatusBar();
  }));

  // Setup
  context.subscriptions.push(vscode.commands.registerCommand('ecode.setup', async () => {
    const result = await SetupPanel.show(context, authManager);
    if (result?.configured) {
      pullCode('setup').catch(err => output.error(`Pull after setup failed: ${err}`));
    }
  }));

  output.info('Commands registered');
}

// ==================== 拉取 ====================

async function pullCode(source: 'auto' | 'setup' | 'manual'): Promise<void> {
  try {
    const client = await authManager.autoLogin();
    if (!client) {
      output.warn(`pullCode(${source}): autoLogin failed`);
      return;
    }

    if (source !== 'manual') {
      const choice = await vscode.window.showInformationMessage(
        `从 Ecode 服务器拉取代码到 ${syncEngine.getLocalDir()}？`,
        '开始下载',
      );
      if (choice !== '开始下载') { return; }
    }

    statusBar.text = '$(sync~spin) 下载中...';
    statusBar.tooltip = '正在从服务器拉取代码';

    const result = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Ecode: 全量下载代码...',
      cancellable: true,
    }, async (progress, token) => {
      const r = await syncEngine.pull(
        msg => progress.report({ message: msg }),
        token,
      );
      return r;
    });

    resetStatusBar();

    if (result.conflicts.length > 0) {
      output.warn(`${result.conflicts.length} files skipped due to local modifications`);
    }

    if (result.failed === 0) {
      vscode.window.showInformationMessage(`下载完成: ${result.pulled} 个文件 → ${syncEngine.getLocalDir()}`);
    } else if (result.pulled > 0) {
      vscode.window.showWarningMessage(`${result.pulled} 成功, ${result.failed} 失败. 查看 Ecode Output 面板`);
    } else {
      vscode.window.showErrorMessage(`下载失败: ${result.failed} 个文件. 查看 Ecode Output 面板`);
    }
  } catch (err: unknown) {
    vscode.window.showErrorMessage(`代码拉取失败: ${err instanceof Error ? err.message : String(err)}`);
    output.error(`pullCode failed: ${err}`);
    resetStatusBar();
  }
}

// ==================== 状态栏 ====================

function buildHoverMenu(): vscode.MarkdownString {
  const m = new vscode.MarkdownString(
    '**⚙ [基础配置](command:ecode.setup)**  &nbsp; 服务器、账号密码\n\n' +
    '**⬇ [拉取代码](command:ecode.menuPull)**  &nbsp; 全量下载到本地\n\n' +
    '**⬆ [推送代码](command:ecode.menuPush)**  &nbsp; 推送本地更改到服务器',
    true,
  );
  m.isTrusted = true;
  return m;
}

function resetStatusBar() {
  statusBar.text = '$(cloud) Ecode';
  statusBar.tooltip = buildHoverMenu();
  statusBar.command = 'ecode.setup';
  statusBar.show();
}
