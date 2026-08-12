import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { basename } from 'path';
import { Readable } from 'stream';
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

  buildSameOriginUrl(requestPath: string): string {
    const base = new URL(this.baseUrl);
    const target = new URL(requestPath, `${base.toString().replace(/\/+$/, '')}/`);
    if (target.origin !== base.origin) {
      throw new Error('资源地址与当前 Ecode 服务不同源');
    }
    return target.toString();
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

  async getRaw(requestPath: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.cookie) {
      headers.Cookie = this.cookie;
    }
    return this.fetchRaw(this.buildSameOriginUrl(requestPath), {
      method: 'GET',
      headers,
    });
  }

  async postMultipartFile<T>(
    requestPath: string,
    fieldName: string,
    filePath: string,
    fileName = basename(filePath),
  ): Promise<ApiResponse<T>> {
    const file = await stat(filePath);
    const boundary = `----ecode-local-${Date.now().toString(16)}`;
    const header = Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${escapeMultipart(fieldName)}"; `
      + `filename="${escapeMultipart(fileName)}"\r\n`
      + 'Content-Type: application/octet-stream\r\n\r\n',
      'utf8',
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Readable.from((async function* streamMultipart() {
      yield header;
      for await (const chunk of createReadStream(filePath)) {
        yield chunk;
      }
      yield footer;
    })());
    const headers: Record<string, string> = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(header.length + file.size + footer.length),
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (this.cookie) {
      headers.Cookie = this.cookie;
    }
    return this.fetchResponse<T>(this.buildUrl(requestPath), {
      method: 'POST',
      headers,
      body: body as unknown as RequestInit['body'],
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
  }

  private async request<T>(method: string, requestPath: string): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {};
    if (this.cookie) {
      headers.Cookie = this.cookie;
    }
    return this.fetchResponse<T>(this.buildUrl(requestPath), { method, headers });
  }

  private async fetchResponse<T>(url: string, init: RequestInit): Promise<ApiResponse<T>> {
    let response: Response;
    try {
      response = await this.fetchRaw(url, init);
    } catch (error: unknown) {
      const message = error instanceof Error && error.name === 'AbortError'
        ? `请求超时 (${this.timeoutMs}ms)`
        : error instanceof Error ? error.message : String(error);
      return { status: false, msg: message, code: -1 };
    }
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
  }

  private async fetchRaw(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function escapeMultipart(value: string): string {
  return value.replace(/["\r\n]/g, '_');
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
