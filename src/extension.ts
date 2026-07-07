import * as vscode from 'vscode';
import { AuthManager } from './sync/auth/AuthManager';
import { EcodeSyncEngine } from './sync/EcodeSyncEngine';
import { SetupPanel } from './ui/webview/SetupPanel';
import { MAIN_BRANCH } from './constants';
import type { PushSummary } from './sync/api/types';

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
  await updateStatusBar();

  // 自动登录（不影响 git 初始化，初始化在 Setup 完成后触发）
  const loginReady = await authManager.isLoginReady();
  if (loginReady) {
    const client = await authManager.autoLogin();
    if (client) {
      output.info('Auto-login succeeded');
      // 已有凭据且登录成功 → 执行 git 初始化
      await syncEngine.initialize();
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

  // ============ 拉取 ============

  context.subscriptions.push(vscode.commands.registerCommand('ecode.menuPull', async () => {
    const client = await authManager.autoLogin();
    if (!client) {
      vscode.commands.executeCommand('ecode.setup');
    } else {
      pullCode('manual').catch(err => output.error(`Pull failed: ${err}`));
    }
  }));

  // ============ 推送 ============

  context.subscriptions.push(vscode.commands.registerCommand('ecode.menuPush', async () => {
    const client = await authManager.autoLogin();
    if (!client) {
      vscode.window.showErrorMessage('Ecode: 未连接，请先配置服务器');
      vscode.commands.executeCommand('ecode.setup');
      return;
    }

    // Git 环境检查
    if (!(await syncEngine.isGitReady())) {
      vscode.window.showErrorMessage('Ecode: 工作区不是 Git 仓库，请先使用 git init 初始化');
      return;
    }

    // main 分支 dirty 检查
    if (await syncEngine.isMainDirty()) {
      vscode.window.showErrorMessage(
        'Ecode: main 分支存在未提交的更改，请先提交或切换到开发分支再推送',
      );
      return;
    }

    // 获取行级别差异摘要
    let summary: PushSummary;
    try {
      summary = await syncEngine.getPushSummary();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Ecode: 获取变更失败 — ${msg}`);
      return;
    }

    // 获取变更文件列表用于推送
    const status = await syncEngine.getStatus();
    const changes = status.filter(d => d.status === 'added' || d.status === 'modified');

    if (changes.length === 0) {
      vscode.window.showInformationMessage('Ecode: 没有需要推送的更改');
      return;
    }

    // 构建行差异摘要
    const summaryText = buildPushSummary(summary);
    // 写入完整差异到 Output 面板
    output.info(buildFullDiff(summary));

    const choice = await vscode.window.showInformationMessage(
      summaryText,
      { modal: true },
      '确认推送',
    );
    if (choice !== '确认推送') { return; }

    // 执行推送
    statusBar.text = '$(sync~spin) 推送中...';
    try {
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Ecode: 推送代码...',
        cancellable: false,
      }, async () => {
        return syncEngine.pushChanged(changes);
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
    updateStatusBar();
  }));

  // ============ 新建开发分支 ============

  context.subscriptions.push(vscode.commands.registerCommand('ecode.branchNew', async () => {
    if (!(await syncEngine.isGitReady())) {
      vscode.window.showErrorMessage('Ecode: 工作区不是 Git 仓库');
      return;
    }

    const branchName = await vscode.window.showInputBox({
      prompt: '请输入新分支名称',
      placeHolder: 'feature-xxx',
      validateInput: (value) => {
        if (!value.trim()) { return '分支名不能为空'; }
        if (/[\s~^:?*[\\\]]/.test(value)) { return '分支名包含非法字符'; }
        return null;
      },
    });

    if (!branchName) { return; }

    try {
      await syncEngine.startDevBranch(branchName.trim());
      vscode.window.showInformationMessage(`已创建并切换到分支: ${branchName}`);
      updateStatusBar();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`创建分支失败: ${msg}`);
    }
  }));

  // ============ Setup ============

  context.subscriptions.push(vscode.commands.registerCommand('ecode.setup', async () => {
    const result = await SetupPanel.show(context, authManager);
    if (result?.configured) {
      // Setup 完成 → 先执行 git 初始化 → 再拉取代码
      await syncEngine.initialize();
      pullCode('setup').catch(err => output.error(`Pull after setup failed: ${err}`));
    }
  }));

  output.info('Commands registered');
}

// ==================== 推送摘要构建 ====================

function buildPushSummary(summary: PushSummary): string {
  const MAX_FILES = 5;
  const lines: string[] = [];

  lines.push(`推送至 ${summary.serverUrl}`);
  lines.push(`基线: ${summary.baseBranch}  |  当前: ${summary.currentBranch}`);
  lines.push(`${summary.changes.length} 个文件 (+${summary.totalAdditions} -${summary.totalDeletions})`);
  lines.push('');

  const shown = summary.changes.slice(0, MAX_FILES);
  const remaining = summary.changes.length - MAX_FILES;

  for (const diff of shown) {
    const prefix = diff.status === 'added' ? '+' : diff.status === 'deleted' ? '-' : '~';

    if (diff.status === 'added') {
      lines.push(`${prefix} ${diff.path} (新文件, ${diff.additions} 行)`);
    } else if (diff.status === 'deleted') {
      lines.push(`${prefix} ${diff.path} (已删除, ${diff.deletions} 行)`);
    } else {
      lines.push(`${prefix} ${diff.path} (+${diff.additions} -${diff.deletions})`);
    }

    // 展示 hunks（最多 2 个 hunk，每个 hunk 最多 8 行）
    if (diff.hunks.length > 0) {
      const maxHunks = 2;
      for (const hunk of diff.hunks.slice(0, maxHunks)) {
        lines.push(`  @@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
        const maxLines = 8;
        for (const line of hunk.lines.slice(0, maxLines)) {
          const sign = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
          lines.push(`  ${sign} ${line.content.trimEnd()}`);
        }
        if (hunk.lines.length > maxLines) {
          lines.push(`  ... (${hunk.lines.length - maxLines} 行省略)`);
        }
      }
      if (diff.hunks.length > maxHunks) {
        lines.push(`  ... 共 ${diff.hunks.length} 个变更块`);
      }
    }

    if (diff.truncated) {
      lines.push('  [差异已截断，完整内容见 Ecode Output 面板]');
    }
    lines.push('');
  }

  if (remaining > 0) {
    lines.push(`... 还有 ${remaining} 个文件`);
  }

  return lines.join('\n');
}

function buildFullDiff(summary: PushSummary): string {
  const lines: string[] = ['=== 完整变更差异 ==='];
  for (const diff of summary.changes) {
    if (diff.hunks.length === 0) {
      lines.push(`\n${diff.status === 'added' ? '+' : '-'} ${diff.path} (${diff.additions}/${diff.deletions})`);
      continue;
    }
    lines.push(`\n--- ${diff.path} ---`);
    for (const hunk of diff.hunks) {
      lines.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
      for (const line of hunk.lines) {
        const sign = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
        lines.push(`${sign} ${line.content.trimEnd()}`);
      }
    }
  }
  return lines.join('\n');
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

    updateStatusBar();

    // 拉取成功且有文件更新 → 提交到 git
    if (result.pulled > 0) {
      const gitMgr = syncEngine.getGitManager();
      if (gitMgr) {
        await gitMgr.commit('sync: 从服务器拉取代码');
        output.info('Pull committed to git');
      }
    }

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
    updateStatusBar();
  }
}

// ==================== 状态栏 ====================

async function updateStatusBar() {
  let branchName = '';
  try {
    const gitMgr = syncEngine.getGitManager();
    if (gitMgr) {
      branchName = await gitMgr.getCurrentBranch();
    }
  } catch {
    // 忽略
  }

  statusBar.text = branchName
    ? `$(cloud) Ecode [${branchName}]`
    : '$(cloud) Ecode';
  statusBar.tooltip = buildHoverMenu(branchName);
  statusBar.command = 'ecode.setup';
  statusBar.show();
}

function buildHoverMenu(branchName: string): vscode.MarkdownString {
  const parts: string[] = [
    '**⚙ [基础配置](command:ecode.setup)**  &nbsp; 服务器、账号密码',
    '',
    '**⎇ [新建开发分支](command:ecode.branchNew)**  &nbsp; 从 main 创建新分支',
  ];

  if (branchName) {
    parts.push(`当前分支: **${escapeMarkdown(branchName)}**`);
  }

  parts.push('');
  parts.push('**⬇ [拉取代码](command:ecode.menuPull)**  &nbsp; 全量下载到本地');
  parts.push('**⬆ [推送代码](command:ecode.menuPush)**  &nbsp; 对比 main 并推送变更');

  const m = new vscode.MarkdownString(parts.join('\n'), true);
  m.isTrusted = true;
  return m;
}

/** 转义 Markdown 特殊字符，防止在 isTrusted MarkdownString 中注入 */
function escapeMarkdown(text: string): string {
  return text.replace(/([\\[\](){}*_~`#+\-.!|><])/g, '\\$1');
}
