import type { ApiResponse } from './api/types';

export class SyncCancelledError extends Error {
  constructor() {
    super('同步操作已取消');
    this.name = 'SyncCancelledError';
  }
}

export class SessionExpiredError extends Error {}

export class EcodeOperationError extends Error {
  constructor(message: string, readonly code?: number | string) {
    super(message);
  }
}

export function requireSuccess<T>(response: ApiResponse<T>, prefix: string): T {
  if (!response.status || response.data === undefined) {
    if (isUnauthorized(response.code)) {
      throw new SessionExpiredError(response.msg || 'Session expired');
    }
    const detail = response.msg
      ?? (response.code !== undefined ? `错误码 ${response.code}` : undefined);
    throw new EcodeOperationError(
      `${prefix}${detail ? `: ${detail}` : ''}`,
      response.code,
    );
  }
  return response.data;
}

export function isUnauthorized(code: number | string | undefined): boolean {
  return code === 401
    || code === '401'
    || code === '002'
    || code === '005'
    || code === '1001'
    || code === '1002';
}
