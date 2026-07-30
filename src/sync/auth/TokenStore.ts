import type * as vscode from 'vscode';

export class TokenStore {
  readonly identity: string;
  private readonly cookieKey: string;
  private readonly passwordKey: string;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    identity: string,
  ) {
    this.identity = identity;
    const prefix = `ecode.v1.auth.${identity}`;
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

}
