import type { EcodeApiClient } from './EcodeApiClient';
import type { ApiResponse } from './types';

export type FileMarkType = 'pre-state' | '';

export interface EcodeSystemInfo {
  version?: string;
  build?: string;
}

export interface ReleaseRecord {
  folderId: string;
  name?: string;
  path?: string;
}

export class LifecycleApi {
  constructor(private readonly client: EcodeApiClient) {}

  async getSystemInfo(): Promise<ApiResponse<EcodeSystemInfo>> {
    const result = await this.client.get<unknown>('/api/cloudstore/ecode/sysInfo');
    if (!result.status) {
      return result as ApiResponse<EcodeSystemInfo>;
    }
    const source = responseSource(result);
    return {
      status: true,
      data: {
        version: findString(source, 'version', 'ecodeVersion', 'sysVersion'),
        build: findString(source, 'build', 'buildVersion', 'buildNumber'),
      },
    };
  }

  async listReleases(): Promise<ApiResponse<ReleaseRecord[]>> {
    const releases = new Map<string, ReleaseRecord>();
    let expectedCount: number | undefined;
    for (let pageNum = 1; pageNum <= 1000; pageNum++) {
      const query = new URLSearchParams({
        pageNum: String(pageNum),
        pageSize: '1000',
      });
      const result = await this.client.get<unknown>(
        `/api/cloudstore/ecode/releaseList?${query}`,
      );
      if (!result.status) {
        return result as ApiResponse<ReleaseRecord[]>;
      }
      const rows = findArray(result.data ?? result, 0);
      if (!rows) {
        return {
          status: false,
          msg: '发布列表响应格式无法识别',
        };
      }
      const previousSize = releases.size;
      for (const row of rows) {
        const normalized = normalizeReleaseRecord(row);
        if (normalized) {
          releases.set(normalized.folderId, normalized);
        }
      }
      const count = findNumber(result, 'count', 'total');
      expectedCount = count ?? expectedCount;
      if (
        releases.size === previousSize
        && expectedCount !== undefined
        && releases.size < expectedCount
      ) {
        return {
          status: false,
          msg: `发布列表分页未完整返回: ${releases.size}/${expectedCount}`,
        };
      }
      if (
        rows.length === 0
        || (expectedCount !== undefined && releases.size >= expectedCount)
        || releases.size === previousSize
      ) {
        break;
      }
    }
    if (expectedCount !== undefined && releases.size < expectedCount) {
      return {
        status: false,
        msg: `发布列表超过分页读取上限: ${releases.size}/${expectedCount}`,
      };
    }
    return { status: true, data: [...releases.values()] };
  }

  async markFile(id: string, type: FileMarkType): Promise<ApiResponse<unknown>> {
    return this.client.postForm('/api/cloudstore/ecode/markFile', { id, type });
  }

  async setPreStateOrder(
    appId: string,
    preStateOrder: string,
  ): Promise<ApiResponse<unknown>> {
    return this.client.postForm('/api/ecode/type/setPreStateOrder', {
      appId,
      preStateOrder,
    });
  }

  async publishFolder(folderId: string): Promise<ApiResponse<unknown>> {
    return this.client.postForm('/api/cloudstore/ecode/release', {
      path: '',
      folderId,
    });
  }

  async unpublishFolder(folderId: string): Promise<ApiResponse<unknown>> {
    return this.client.postForm('/api/cloudstore/ecode/deleteReleaseFile', {
      folderIds: folderId,
    });
  }

}

function responseSource(result: ApiResponse<unknown>): unknown {
  return result.data !== undefined ? result.data : result;
}

function normalizeReleaseRecord(value: unknown): ReleaseRecord | undefined {
  const record = asCaseInsensitiveRecord(value);
  const folderId = firstString(record, 'folderid', 'appid', 'id');
  if (!folderId) {
    return undefined;
  }
  return {
    folderId,
    name: firstString(record, 'name', 'foldername'),
    path: firstString(record, 'path', 'releasepath'),
  };
}

function findArray(value: unknown, depth: number): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (depth >= 4) {
    return undefined;
  }
  const record = asRecord(value);
  for (const key of ['data', 'list', 'releaseList', 'rows', 'datas']) {
    if (key in record) {
      const found = findArray(record[key], depth + 1);
      if (found) {
        return found;
      }
    }
  }
  for (const nested of Object.values(record)) {
    const found = findArray(nested, depth + 1);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function findString(value: unknown, ...names: string[]): string | undefined {
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth > 3) {
      continue;
    }
    const record = asCaseInsensitiveRecord(current.value);
    const direct = firstString(record, ...names.map(name => name.toLowerCase()));
    if (direct) {
      return direct;
    }
    for (const nested of Object.values(record)) {
      if (nested && typeof nested === 'object') {
        queue.push({ value: nested, depth: current.depth + 1 });
      }
    }
  }
  return undefined;
}

function findNumber(value: unknown, ...names: string[]): number | undefined {
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth > 3) {
      continue;
    }
    const record = asCaseInsensitiveRecord(current.value);
    for (const name of names) {
      const candidate = record[name.toLowerCase()];
      const parsed = typeof candidate === 'number'
        ? candidate
        : typeof candidate === 'string' ? Number(candidate) : NaN;
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
    }
    for (const nested of Object.values(record)) {
      if (nested && typeof nested === 'object') {
        queue.push({ value: nested, depth: current.depth + 1 });
      }
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asCaseInsensitiveRecord(value: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(asRecord(value)).map(([key, item]) => [key.toLowerCase(), item]),
  );
}

function firstString(record: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = record[name.toLowerCase()];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}
