import type { ApiResponse } from './types';

/**
 * Ecode HTTP 客户端
 *
 * 使用 Cookie（ecology_JSessionid）进行会话鉴权。
 */
export class EcodeApiClient {
  private cookie: string | null = null;
  private timeout: number;

  constructor(
    private baseUrl: string,
    timeoutMs = 30000,
  ) {
    this.timeout = timeoutMs;
  }

  setCookie(cookie: string): void { this.cookie = cookie; }
  clearAuth(): void { this.cookie = null; }
  getCookie(): string | null { return this.cookie; }
  getBaseUrl(): string { return this.baseUrl; }

  buildUrl(path: string): string {
    const base = this.baseUrl.replace(/\/+$/, '');
    const p = path.replace(/^\/+/, '');
    return `${base}/${p}`;
  }

  async get<T>(path: string, extraHeaders?: Record<string, string>): Promise<ApiResponse<T>> {
    return this.request<T>('GET', path, undefined, extraHeaders);
  }

  async post<T>(path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<ApiResponse<T>> {
    return this.request<T>('POST', path, body, extraHeaders);
  }

  /**
   * 上传文件（FormData），不走 JSON 序列化
   */
  async uploadForm<T>(path: string, form: import('form-data'), extraHeaders?: Record<string, string>): Promise<ApiResponse<T>> {
    const url = this.buildUrl(path);
    const headers: Record<string, string> = { ...form.getHeaders(), ...extraHeaders };
    if (this.cookie) { headers['Cookie'] = this.cookie; }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: form as never,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        return { status: false, msg: `HTTP ${response.status}`, code: response.status };
      }
      const json = await response.json();
      return { status: true, data: json as T };
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { status: false, msg: `请求超时 (${this.timeout}ms)`, code: -1 };
      }
      return { status: false, msg: err instanceof Error ? err.message : String(err), code: -1 };
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<ApiResponse<T>> {
    const url = this.buildUrl(path);
    const headers: Record<string, string> = { ...extraHeaders };
    if (this.cookie) { headers['Cookie'] = this.cookie; }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.status === 401 || response.status === 302) {
        return { status: false, msg: 'Session expired', code: 401 };
      }
      if (!response.ok) {
        return { status: false, msg: `HTTP ${response.status}`, code: response.status };
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const json = await response.json() as Record<string, unknown>;
        if ('status' in json || 'msg' in json) {
          return json as unknown as ApiResponse<T>;
        }
        return { status: true, data: json as T };
      }

      // 服务器可能不设 Content-Type，尝试 JSON 解析
      const text = await response.text();
      try {
        const json = JSON.parse(text) as Record<string, unknown>;
        if ('status' in json || 'msg' in json) {
          return json as unknown as ApiResponse<T>;
        }
        return { status: true, data: json as T };
      } catch {
        return { status: true, data: text as unknown as T };
      }
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { status: false, msg: `请求超时 (${this.timeout}ms)`, code: -1 };
      }
      return { status: false, msg: err instanceof Error ? err.message : String(err), code: -1 };
    }
  }
}
