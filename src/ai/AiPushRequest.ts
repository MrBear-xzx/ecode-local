import * as path from 'path';
import {
  normalizeRemotePath,
  validateEnvironmentDirectory,
} from '../domain/paths';
import type { SyncOperationResult } from '../domain/types';

export const AI_PUSH_REQUEST_DIRECTORY = 'ai-requests';
export const AI_PUSH_RESULT_DIRECTORY = 'ai-results';

export interface AiPushRequest {
  schemaVersion: 1;
  id: string;
  action: 'push';
  environmentDirectory: string;
  paths: string[];
  createdAt: string;
}

export interface AiPushResult {
  schemaVersion: 1;
  id: string;
  action: 'push';
  environmentDirectory?: string;
  processedAt: string;
  status: 'succeeded' | 'partial' | 'cancelled' | 'rejected' | 'failed';
  pushRecordId?: string;
  result?: SyncOperationResult;
  message?: string;
}

export function parseAiPushRequest(
  raw: string,
  fileName: string,
): AiPushRequest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('AI 推送请求不是有效 JSON');
  }
  if (!isRecord(value)) {
    throw new Error('AI 推送请求必须是 JSON 对象');
  }
  const id = requireString(value.id, 'id');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new Error('AI 推送请求 id 只能包含英文字母、数字、下划线和横线，最长 64 位');
  }
  if (path.basename(fileName, '.json') !== id || path.extname(fileName) !== '.json') {
    throw new Error('AI 推送请求文件名必须为 <id>.json，并与请求 id 一致');
  }
  if (value.schemaVersion !== 1) {
    throw new Error('AI 推送请求 schemaVersion 必须为 1');
  }
  if (value.action !== 'push') {
    throw new Error('AI 推送请求 action 仅支持 push');
  }
  const environmentDirectory = requireString(
    value.environmentDirectory,
    'environmentDirectory',
  ).trim();
  const directoryError = validateEnvironmentDirectory(environmentDirectory);
  if (directoryError) {
    throw new Error(directoryError);
  }
  const createdAt = requireString(value.createdAt, 'createdAt');
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error('AI 推送请求 createdAt 必须是有效 ISO 时间');
  }
  if (!Array.isArray(value.paths) || value.paths.length === 0) {
    throw new Error('AI 推送请求 paths 至少包含一个源码路径');
  }
  if (value.paths.length > 100) {
    throw new Error('单个 AI 推送请求最多包含 100 个源码路径');
  }
  const paths = value.paths.map((item, index) => {
    if (typeof item !== 'string') {
      throw new Error(`AI 推送请求 paths[${index}] 必须是字符串`);
    }
    return normalizeRemotePath(item);
  });
  const keys = paths.map(item => item.toLocaleLowerCase('en-US'));
  if (new Set(keys).size !== keys.length) {
    throw new Error('AI 推送请求 paths 不能包含重复路径');
  }
  return {
    schemaVersion: 1,
    id,
    action: 'push',
    environmentDirectory,
    paths,
    createdAt,
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`AI 推送请求 ${field} 必须是非空字符串`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
