import type * as vscode from 'vscode';
import type { ConnectionProfile } from '../../domain/types';
import { serverFingerprint } from '../../domain/text';
import { EcodeApiClient } from '../api/EcodeApiClient';
import type { ApiResponse } from '../api/types';
import { TokenStore } from './TokenStore';
import { RSACrypto, type RsaInfo } from './RSACrypto';

export interface LoginResult {
  success: boolean;
  message: string;
}

export class AuthManager {
  private readonly secrets: vscode.SecretStorage;
  private readonly rsa = new RSACrypto();
  private client: EcodeApiClient | undefined;
  private clientUrl = '';
  private sessionVerified = false;
  private sessionIdentity = '';

  constructor(context: vscode.ExtensionContext) {
    this.secrets = context.secrets;
  }

  async connect(profile: ConnectionProfile, password: string): Promise<LoginResult> {
    const tokens = this.tokens(profile);
    const result = await this.login(profile.serverUrl, profile.username, password, tokens);
    if (!result.success) {
      return result;
    }

    const client = this.client;
    const tree = client
      ? await client.get('/api/ecode/type/tree')
      : { status: false, msg: '未创建 API 客户端' };
    if (!tree.status) {
      await tokens.clearSession();
      client?.clearAuth();
      this.sessionVerified = false;
      this.sessionIdentity = '';
      return {
        success: false,
        message: `登录成功，但无法读取远端文件树${apiFailureDetail(tree)}`,
      };
    }

    await tokens.storePassword(password);
    return result;
  }

  async getAuthenticatedClient(profile: ConnectionProfile): Promise<EcodeApiClient | undefined> {
    const client = this.clientFor(profile.serverUrl);
    const identity = serverFingerprint(profile.serverUrl, profile.username);
    const tokens = new TokenStore(this.secrets, identity);
    if (this.sessionVerified && this.sessionIdentity === identity) {
      return client;
    }
    client.clearAuth();
    this.sessionVerified = false;
    this.sessionIdentity = '';
    const cookie = await tokens.getCookie();
    if (cookie) {
      client.setCookie(cookie);
      const verified = await client.get('/api/ecode/type/tree');
      if (verified.status) {
        this.sessionVerified = true;
        this.sessionIdentity = identity;
        return client;
      }
      await tokens.clearSession();
      client.clearAuth();
    }

    const password = await tokens.getPassword();
    if (!password) {
      return undefined;
    }
    const result = await this.login(profile.serverUrl, profile.username, password, tokens);
    return result.success ? this.client : undefined;
  }

  async reconnect(profile: ConnectionProfile): Promise<EcodeApiClient | undefined> {
    const tokens = this.tokens(profile);
    await tokens.clearSession();
    this.client?.clearAuth();
    this.sessionVerified = false;
    this.sessionIdentity = '';
    const password = await tokens.getPassword();
    if (!password) {
      return undefined;
    }
    const result = await this.login(profile.serverUrl, profile.username, password, tokens);
    return result.success ? this.client : undefined;
  }

  async clearV2Credentials(): Promise<void> {
    await new TokenStore(this.secrets, 'all').clearAllV2();
    this.client = undefined;
    this.clientUrl = '';
    this.sessionVerified = false;
    this.sessionIdentity = '';
  }

  private async login(
    serverUrl: string,
    username: string,
    password: string,
    tokens: TokenStore,
  ): Promise<LoginResult> {
    const normalizedUrl = serverUrl.trim().replace(/\/+$/, '');
    try {
      const client = this.clientFor(normalizedUrl);
      client.clearAuth();
      this.sessionVerified = false;
      this.sessionIdentity = '';

      const initResponse = await fetchWithTimeout(`${normalizedUrl}/`);
      const sessionCookie = extractSessionCookie(initResponse.headers.get('set-cookie'));

      const rsaResponse = await fetchWithTimeout(`${normalizedUrl}/rsa/weaver.rsa.GetRsaInfo`, {
        headers: sessionCookie ? { Cookie: sessionCookie } : {},
      });
      if (!rsaResponse.ok) {
        return { success: false, message: `获取 RSA 公钥失败: HTTP ${rsaResponse.status}` };
      }

      const rsaInfo = await rsaResponse.json() as RsaInfo;
      const params = new URLSearchParams({
        islanguid: '7',
        loginid: this.rsa.encryptWithRsa(rsaInfo, username),
        userpassword: this.rsa.encryptWithRsa(rsaInfo, password),
        logintype: '1',
        isie: 'false',
      });

      const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded',
      };
      if (sessionCookie) {
        headers.Cookie = sessionCookie;
      }

      const response = await fetchWithTimeout(client.buildUrl('/api/hrm/login/checkLogin'), {
        method: 'POST',
        headers,
        body: params,
      });
      if (!response.ok) {
        return { success: false, message: `登录失败: HTTP ${response.status}` };
      }

      const result = await response.json() as { msgcode?: string; msg?: string };
      if (result.msgcode !== '0') {
        return { success: false, message: result.msg || '登录被服务器拒绝' };
      }
      if (!sessionCookie) {
        return { success: false, message: '未获取到 session cookie' };
      }

      client.setCookie(sessionCookie);
      await tokens.storeCookie(sessionCookie);
      this.sessionVerified = true;
      this.sessionIdentity = serverFingerprint(normalizedUrl, username);
      return { success: true, message: '连接测试成功' };
    } catch (error: unknown) {
      return {
        success: false,
        message: `登录异常: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private clientFor(serverUrl: string): EcodeApiClient {
    const normalized = serverUrl.trim().replace(/\/+$/, '');
    if (!this.client || this.clientUrl !== normalized) {
      this.client = new EcodeApiClient(normalized);
      this.clientUrl = normalized;
      this.sessionVerified = false;
      this.sessionIdentity = '';
    }
    return this.client;
  }

  private tokens(profile: ConnectionProfile): TokenStore {
    return new TokenStore(
      this.secrets,
      serverFingerprint(profile.serverUrl, profile.username),
    );
  }
}

function extractSessionCookie(setCookie: string | null): string | undefined {
  const match = setCookie?.match(/ecology_JSessionid=([^;]+)/i);
  return match ? `ecology_JSessionid=${match[1]}` : undefined;
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs = 30000,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function apiFailureDetail(response: ApiResponse<unknown>): string {
  if (response.msg) {
    return `: ${response.msg}`;
  }
  if (response.code !== undefined) {
    return `: 错误码 ${response.code}`;
  }
  return '：服务端返回 status=false，且未提供错误码或错误消息';
}
