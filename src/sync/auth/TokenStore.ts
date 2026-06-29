import * as vscode from 'vscode';

/**
 * 会话存储
 *
 * 使用 VSCode SecretStorage 存储 E-cology 会话 Cookie。
 * 参考实现使用 Cookie 而非 Token 进行鉴权。
 */
export class TokenStore {
  private static COOKIE_KEY = 'ecode.auth.cookie';
  private static USERNAME_KEY = 'ecode.auth.username';
  private static PASSWORD_KEY = 'ecode.auth.password';

  constructor(private secrets: vscode.SecretStorage) {}

  /** 存储会话 Cookie */
  async storeCookie(cookie: string): Promise<void> {
    await this.secrets.store(TokenStore.COOKIE_KEY, cookie);
  }

  /** 获取存储的 Cookie */
  async getCookie(): Promise<string | undefined> {
    return this.secrets.get(TokenStore.COOKIE_KEY);
  }

  /** 存储用户名 */
  async storeUsername(username: string): Promise<void> {
    await this.secrets.store(TokenStore.USERNAME_KEY, username);
  }

  /** 获取用户名 */
  async getUsername(): Promise<string | undefined> {
    return this.secrets.get(TokenStore.USERNAME_KEY);
  }

  /** 存储密码（持久化到 SecretStorage，加密存储） */
  async storePassword(password: string): Promise<void> {
    await this.secrets.store(TokenStore.PASSWORD_KEY, password);
  }

  /** 获取存储的密码 */
  async getPassword(): Promise<string | undefined> {
    return this.secrets.get(TokenStore.PASSWORD_KEY);
  }

  /** 清除密码 */
  private async deletePassword(): Promise<void> {
    await this.secrets.delete(TokenStore.PASSWORD_KEY);
  }

  /** 清除所有鉴权信息 */
  async clear(): Promise<void> {
    await this.secrets.delete(TokenStore.COOKIE_KEY);
    await this.secrets.delete(TokenStore.PASSWORD_KEY);
    // 保留用户名以便下次登录
  }
}
