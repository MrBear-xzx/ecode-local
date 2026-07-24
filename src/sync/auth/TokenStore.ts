import type * as vscode from 'vscode';

export class TokenStore {
  private readonly cookieKey: string;
  private readonly passwordKey: string;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    identity: string,
  ) {
    const prefix = `ecode.v2.auth.${identity}`;
    this.cookieKey = `${prefix}.cookie`;
    this.passwordKey = `${prefix}.password`;
  }

  async storeCookie(cookie: string): Promise<void> {
    await this.secrets.store(this.cookieKey, cookie);
  }

  async getCookie(): Promise<string | undefined> {
    return this.secrets.get(this.cookieKey);
  }

  async storePassword(password: string): Promise<void> {
    await this.secrets.store(this.passwordKey, password);
  }

  async getPassword(): Promise<string | undefined> {
    return this.secrets.get(this.passwordKey);
  }

  async clearSession(): Promise<void> {
    await this.secrets.delete(this.cookieKey);
  }

  async clear(): Promise<void> {
    await Promise.all([
      this.secrets.delete(this.cookieKey),
      this.secrets.delete(this.passwordKey),
    ]);
  }

  async clearAllV2(): Promise<void> {
    const keys = await this.secrets.keys();
    await Promise.all(keys
      .filter(key => key.startsWith('ecode.v2.'))
      .map(key => this.secrets.delete(key)));
  }
}
