import * as vscode from 'vscode';
import { TokenStore } from './TokenStore';
import { RSACrypto, type RsaInfo } from './RSACrypto';
import { EcodeApiClient } from '../api/EcodeApiClient';

/**
 * Ecode 鉴权管理器
 */
export class AuthManager {
  private tokenStore: TokenStore;
  private rsa: RSACrypto;
  private client: EcodeApiClient | null = null;
  private sessionCookie: string | null = null;

  private readonly rsaEndpoint = '/rsa/weaver.rsa.GetRsaInfo';
  private readonly loginEndpoint = '/api/hrm/login/checkLogin';

  constructor(private context: vscode.ExtensionContext) {
    this.tokenStore = new TokenStore(context.secrets);
    this.rsa = new RSACrypto();
  }

  /** 登录 */
  async login(serverUrl: string, username: string, password: string): Promise<{ success: boolean; message: string }> {
    try {
      this.client = new EcodeApiClient(serverUrl);

      // Step 0: 获取 session cookie
      const initResponse = await fetch(`${serverUrl.replace(/\/+$/, '')}/`);
      const setCookie = initResponse.headers.get('set-cookie');
      if (setCookie) {
        const match = setCookie.match(/ecology_JSessionid=([^;]+)/);
        if (match) {
          this.sessionCookie = `ecology_JSessionid=${match[1]}`;
        }
      }

      // Step 1: 获取 RSA 公钥
      const rsaResponse = await fetch(`${serverUrl.replace(/\/+$/, '')}${this.rsaEndpoint}`, {
        headers: this.sessionCookie ? { Cookie: this.sessionCookie } : {},
      });
      if (!rsaResponse.ok) {
        return { success: false, message: `获取 RSA 公钥失败: HTTP ${rsaResponse.status}` };
      }
      const rsaInfo = await rsaResponse.json() as RsaInfo;

      // Step 2: RSA 加密凭据
      const encryptedLoginId = this.rsa.encryptWithRsa(rsaInfo, username);
      const encryptedPassword = this.rsa.encryptWithRsa(rsaInfo, password);

      // Step 3: 提交登录
      const params = new URLSearchParams();
      params.append('islanguid', '7');
      params.append('loginid', encryptedLoginId);
      params.append('userpassword', encryptedPassword);
      params.append('logintype', '1');
      params.append('isie', 'false');

      const loginUrl = this.client.buildUrl(this.loginEndpoint);
      const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded',
      };
      if (this.sessionCookie) { headers['Cookie'] = this.sessionCookie; }

      const response = await fetch(loginUrl, { method: 'POST', headers, body: params });

      if (response.status !== 200) {
        return { success: false, message: `登录失败: HTTP ${response.status}` };
      }

      const result = await response.json() as { msgcode: string; msg?: string };
      if (result.msgcode !== '0') {
        return { success: false, message: result.msg || '登录被服务器拒绝' };
      }

      if (!this.sessionCookie) {
        return { success: false, message: '未获取到 session cookie' };
      }

      this.client.setCookie(this.sessionCookie);

      await this.tokenStore.storeCookie(this.sessionCookie);
      await this.tokenStore.storeUsername(username);

      return { success: true, message: '登录成功' };
    } catch (err: unknown) {
      return { success: false, message: `登录异常: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** 检查是否具备自动登录条件 */
  async isLoginReady(): Promise<boolean> {
    if (await this.tokenStore.getCookie()) { return true; }
    const hasPassword = !!(await this.tokenStore.getPassword());
    const serverUrl = vscode.workspace.getConfiguration('ecode').get<string>('server.url');
    return !!(hasPassword && serverUrl);
  }

  /**
   * 自动登录：优先 Cookie → 验证有效性 → 无效则密码登录
   */
  async autoLogin(): Promise<EcodeApiClient | null> {
    const serverUrl = vscode.workspace.getConfiguration('ecode').get<string>('server.url');
    if (!serverUrl) { return null; }

    // 1. 尝试 Cookie
    const savedCookie = await this.tokenStore.getCookie();
    if (savedCookie) {
      this.sessionCookie = savedCookie;
      if (!this.client) { this.client = new EcodeApiClient(serverUrl); }
      this.client.setCookie(savedCookie);

      // 验证 Cookie 有效性
      const valid = await this.verifySession();
      if (valid) {
        return this.client;
      }
      // Cookie 过期，清除后走密码登录
      await this.tokenStore.clear();
      this.sessionCookie = null;
    }

    // 2. 密码登录
    const username = vscode.workspace.getConfiguration('ecode').get<string>('server.username');
    const password = await this.tokenStore.getPassword();
    if (username && password) {
      const result = await this.login(serverUrl, username, password);
      if (result.success) {
        await this.tokenStore.storePassword(password);
        return this.client;
      }
      // 密码登录也失败，清除密码防止反复重试
      await this.tokenStore.clear();
    }

    return null;
  }

  /** 验证当前会话是否有效 */
  private async verifySession(): Promise<boolean> {
    if (!this.client || !this.sessionCookie) { return false; }
    try {
      const result = await this.client.get('/api/ecode/type/tree');
      // status=true 且不是 401 → 有效
      return result.status === true;
    } catch {
      return false;
    }
  }

  async savePassword(password: string): Promise<void> {
    await this.tokenStore.storePassword(password);
  }

  async getClient(): Promise<EcodeApiClient | null> {
    if (!this.client) {
      const serverUrl = vscode.workspace.getConfiguration('ecode').get<string>('server.url');
      if (!serverUrl) { return null; }
      this.client = new EcodeApiClient(serverUrl);
    }
    if (!this.sessionCookie) {
      this.sessionCookie = await this.tokenStore.getCookie() ?? null;
    }
    if (this.sessionCookie) { this.client.setCookie(this.sessionCookie); }
    return this.client;
  }

  async isLoggedIn(): Promise<boolean> {
    return !!(await this.tokenStore.getCookie());
  }

  async logout(): Promise<void> {
    await this.tokenStore.clear();
    this.client = null;
    this.sessionCookie = null;
  }
}
