import * as vscode from 'vscode';
import { AuthManager } from '../../sync/auth/AuthManager';

/**
 * Ecode 配置向导面板
 *
 * 在 Webview 中以表单形式配置服务器连接信息，
 * 替代命令行逐步输入的方式。
 */
export class SetupPanel {
  public static readonly viewType = 'ecode.setup';
  private static current: SetupPanel | undefined;

  private panel: vscode.WebviewPanel;
  private resolve?: (result: SetupResult | null) => void;
  private hasPassword: boolean = false;
  private context: vscode.ExtensionContext;
  private authManager: AuthManager;

  /** 打开配置面板并等待用户输入 */
  static async show(context: vscode.ExtensionContext, authManager?: AuthManager): Promise<SetupResult | null> {
    // 复用已打开的面板
    if (SetupPanel.current) {
      SetupPanel.current.panel.reveal();
      return null;
    }

    return new Promise((resolve) => {
      const panel = vscode.window.createWebviewPanel(
        SetupPanel.viewType,
        'Ecode Setup',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        },
      );

      SetupPanel.current = new SetupPanel(panel, resolve, context, authManager);
    });
  }

  private constructor(
    panel: vscode.WebviewPanel,
    resolve: (result: SetupResult | null) => void,
    context: vscode.ExtensionContext,
    authManager?: AuthManager,
  ) {
    this.panel = panel;
    this.resolve = resolve;
    this.context = context;
    this.authManager = authManager || new AuthManager(context);

    this.init(context).then(() => {
      // HTML 已就绪（密码状态已知）
    });

    this.panel.onDidDispose(() => {
      SetupPanel.current = undefined;
      if (this.resolve) {
        this.resolve(null);
        this.resolve = undefined;
      }
    });

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
    );
  }

  private savedPwd: string = '';

  private async init(context: vscode.ExtensionContext): Promise<void> {
    const pwd = await context.secrets.get('ecode.auth.password');
    this.hasPassword = !!pwd;
    this.savedPwd = pwd || '';
    this.panel.webview.html = this.buildHtml();
  }

  private buildHtml(): string {
    const config = vscode.workspace.getConfiguration('ecode');
    const savedUrl = config.get<string>('server.url') || 'http://localhost:8099';
    const savedUser = config.get<string>('server.username') || 'sysadmin';
    const savedDir = config.get<string>('localDir') || 'ecode';
    // 对密码做 HTML 转义，防止 XSS
    const pwdValue = this.savedPwd.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ecode Setup</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 24px;
    }
    .container { max-width: 480px; margin: 0 auto; }
    h1 { font-size: 22px; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
    .subtitle { color: var(--vscode-descriptionForeground); margin-bottom: 24px; font-size: 13px; }
    .form-group { margin-bottom: 16px; }
    label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 4px; color: var(--vscode-input-placeholderForeground); text-transform: uppercase; letter-spacing: 0.5px; }
    input { width: 100%; padding: 8px 12px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 2px; font-size: 13px; }
    input:focus { outline: 1px solid var(--vscode-focusBorder); }
    .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 20px; border: none; border-radius: 2px; font-size: 13px; cursor: pointer; }
    .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary { background: transparent; color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-button-secondaryBackground); }
    .actions { display: flex; gap: 8px; margin-top: 24px; }
    .status { margin-top: 12px; font-size: 12px; padding: 8px; border-radius: 2px; display: none; }
    .status.success { background: #1b3a1b; color: #4ec94e; display: block; }
    .status.error { background: #3a1b1b; color: #e05555; display: block; }
    .status.loading { background: #1b2a3a; color: #5eaee8; display: block; }
    .divider { border: none; border-top: 1px solid var(--vscode-sideBarSectionHeader-border); margin: 20px 0; }
    .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <h1><span style="font-size:28px">☁</span> Ecode Setup</h1>
    <p class="subtitle">配置泛微 E-cology 服务器连接，开始本地化开发</p>

    <form id="setupForm">
      <div class="form-group">
        <label for="url">服务器地址</label>
        <input id="url" type="text" placeholder="http://localhost:8099" value="${savedUrl}" />
        <div class="hint">E-cology OA 服务器地址（默认端口 8099）</div>
      </div>

      <div class="form-group">
        <label for="username">用户名</label>
        <input id="username" type="text" placeholder="sysadmin" value="${savedUser}" />
        <div class="hint">E-cology 系统管理员账号</div>
      </div>

      <div class="form-group">
        <label for="password">密码</label>
        <input id="password" type="password" value="${pwdValue}" placeholder="请输入密码" />
      </div>

      <div class="form-group">
        <label for="localDir">本地目录</label>
        <input id="localDir" type="text" value="${savedDir}" placeholder="ecode" />
        <div class="hint">代码下载到工作区的哪个目录（相对于项目根目录）</div>
      </div>

      <div class="actions">
        <button type="submit" class="btn btn-primary" id="connectBtn">🔗 连接测试 & 保存</button>
        <button type="button" class="btn btn-secondary" id="skipBtn">跳过</button>
      </div>

      <div id="status" class="status"></div>
    </form>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const form = document.getElementById('setupForm');
    const status = document.getElementById('status');
    const connectBtn = document.getElementById('connectBtn');

    function setStatus(type, msg) {
      status.className = 'status ' + type;
      status.textContent = msg;
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const url = document.getElementById('url').value.trim();
      const username = document.getElementById('username').value.trim();
      const password = document.getElementById('password').value;
      const localDir = document.getElementById('localDir').value.trim();

      if (!url || !username || !password) {
        setStatus('error', '请填写所有必填字段');
        return;
      }

      setStatus('loading', '正在连接服务器...');
      connectBtn.disabled = true;

      vscode.postMessage({
        type: 'connect',
        url, username, password, localDir,
      });
    });

    document.getElementById('skipBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'skip' });
    });

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'result') {
        connectBtn.disabled = false;
        if (msg.success) {
          setStatus('success', '✅ ' + msg.message);
          setTimeout(() => vscode.postMessage({ type: 'close' }), 800);
        } else {
          setStatus('error', '❌ ' + (msg.message || '连接失败'));
        }
      }
    });
  </script>
</body>
</html>`;
  }

  private async handleMessage(msg: { type: string } & Record<string, unknown>) {
    switch (msg.type) {
      case 'connect': {
        try {
          const url = msg.url as string;
          const username = msg.username as string;
          const password = msg.password as string;
          const localDir = msg.localDir as string | undefined;

          // 保存配置
          const config = vscode.workspace.getConfiguration('ecode');
          await config.update('server.url', url, vscode.ConfigurationTarget.Workspace);
          await config.update('server.username', username, vscode.ConfigurationTarget.Workspace);
          if (localDir) {
            await config.update('localDir', localDir, vscode.ConfigurationTarget.Workspace);
          }

          // 测试连接
          if (password) {
            const result = await this.authManager.login(url, username, password);
            if (result.success) {
              // 登录成功 → 保存密码
              await this.authManager.savePassword(password);
              this.panel.webview.postMessage({
                type: 'result',
                success: true,
                message: result.message,
              });
            } else {
              this.panel.webview.postMessage({
                type: 'result',
                success: false,
                message: result.message,
              });
            }
          } else {
            // 没有新密码，使用已有凭据
            const client = await this.authManager.autoLogin();
            if (client) {
              this.panel.webview.postMessage({
                type: 'result',
                success: true,
                message: '设置已保存（使用已有凭据）',
              });
            } else {
              this.panel.webview.postMessage({
                type: 'result',
                success: false,
                message: '无有效凭据，请输入密码',
              });
            }
          }
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          this.panel.webview.postMessage({
            type: 'result',
            success: false,
            message: errorMsg,
          });
        }
        break;
      }

      case 'close': {
        this.resolve?.({ configured: true } as SetupResult);
        this.resolve = undefined;
        this.panel.dispose();
        break;
      }

      case 'skip': {
        this.resolve?.(null);
        this.resolve = undefined;
        this.panel.dispose();
        break;
      }
    }
  }
}

export interface SetupResult {
  configured: boolean;
}
