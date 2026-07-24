import type { ApiResponse } from './types';

export class EcodeApiClient {
  private cookie: string | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 30000,
  ) {}

  setCookie(cookie: string): void {
    this.cookie = cookie;
  }

  clearAuth(): void {
    this.cookie = undefined;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  buildUrl(requestPath: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}/${requestPath.replace(/^\/+/, '')}`;
  }

  async get<T>(requestPath: string): Promise<ApiResponse<T>> {
    return this.request<T>('GET', requestPath);
  }

  async postForm<T>(requestPath: string, values: Record<string, string>): Promise<ApiResponse<T>> {
    const body = new URLSearchParams(values).toString();
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body)),
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (this.cookie) {
      headers.Cookie = this.cookie;
    }
    return this.fetchResponse<T>(this.buildUrl(requestPath), {
      method: 'POST',
      headers,
      body,
    });
  }

  private async request<T>(method: string, requestPath: string): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {};
    if (this.cookie) {
      headers.Cookie = this.cookie;
    }
    return this.fetchResponse<T>(this.buildUrl(requestPath), { method, headers });
  }

  private async fetchResponse<T>(url: string, init: RequestInit): Promise<ApiResponse<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 302) {
        return { status: false, msg: 'Session expired', code: 401 };
      }
      if (!response.ok) {
        return { status: false, msg: `HTTP ${response.status}`, code: response.status };
      }

      const text = await response.text();
      if (!text) {
        return { status: true };
      }
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (
          'status' in parsed || 'api_status' in parsed || 'msg' in parsed ||
          'errcode' in parsed || 'errorCode' in parsed
        ) {
          return normalizeResponse<T>(parsed);
        }
        return { status: true, data: parsed as T };
      } catch {
        return { status: true, data: text as T };
      }
    } catch (error: unknown) {
      const message = error instanceof Error && error.name === 'AbortError'
        ? `请求超时 (${this.timeoutMs}ms)`
        : error instanceof Error ? error.message : String(error);
      return { status: false, msg: message, code: -1 };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeResponse<T>(parsed: Record<string, unknown>): ApiResponse<T> {
  const rawStatus = parsed.api_status ?? parsed.status;
  const status = rawStatus === true || rawStatus === 1 || rawStatus === '1' || rawStatus === 'true';
  const rawCode = parsed.code ?? parsed.errorCode ?? parsed.errcode;
  const code = typeof rawCode === 'number' || typeof rawCode === 'string'
    ? rawCode
    : undefined;
  const rawMessage = parsed.msg ?? parsed.errorMsg ?? parsed.message;
  const msg = typeof rawMessage === 'string' ? rawMessage : undefined;
  return {
    ...parsed,
    status,
    code,
    msg,
  } as unknown as ApiResponse<T>;
}
