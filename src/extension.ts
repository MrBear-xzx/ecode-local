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
  syncEngine.enableAutoSync(context);
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
  syncEngine.disableAutoSync();
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
    vscode.window.showInformationMessage('推送代码功能开发中，敬请期待');
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

    if (result.failed === 0) {
      vscode.window.showInformationMessage(`下载完成: ${result.downloaded} 个文件 → ${syncEngine.getLocalDir()}`);
    } else if (result.downloaded > 0) {
      vscode.window.showWarningMessage(`${result.downloaded} 成功, ${result.failed} 失败. 查看 Ecode Output 面板`);
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
    '**⬆ [推送代码](command:ecode.menuPush)**  &nbsp; TODO 后续实现',
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
