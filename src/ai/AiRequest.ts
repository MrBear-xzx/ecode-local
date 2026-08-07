import * as path from 'path';
import {
  normalizeRemotePath,
  validateEnvironmentDirectory,
} from '../domain/paths';
import { normalizePreStateOrder } from '../domain/lifecycle';

export const CLI_REQUEST_DIRECTORY = 'agent-cli/requests';
export const CLI_RESULT_DIRECTORY = 'agent-cli/results';

export const AI_INSPECT_ACTIONS = [
  'getState',
  'getLifecycleState',
  'refreshChanges',
  'listPushRecords',
  'listChangeSets',
  'getKnowledge',
] as const;

export const AI_EXECUTE_ACTIONS = [
  'configure',
  'addEnvironment',
  'switchEnvironment',
  'deleteEnvironment',
  'pull',
  'push',
  'setPreload',
  'setPreloadOrder',
  'setFolderRelease',
  'rollbackPushFile',
  'renamePushRecord',
  'deletePushRecord',
  'revertChange',
  'resolveConflict',
  'createChangeSet',
  'applyChangeSet',
  'deleteChangeSet',
] as const;

export type AiInspectAction = typeof AI_INSPECT_ACTIONS[number];
export type AiExecuteAction = typeof AI_EXECUTE_ACTIONS[number];
export type AiAction = AiInspectAction | AiExecuteAction;

export const AI_CONFIRMATION_ACTIONS = [
  'switchEnvironment',
  'deleteEnvironment',
  'push',
  'setPreload',
  'setPreloadOrder',
  'setFolderRelease',
  'rollbackPushFile',
  'deletePushRecord',
  'revertChange',
  'resolveConflict',
  'applyChangeSet',
  'deleteChangeSet',
] as const satisfies readonly AiAction[];

export type ConflictResolution =
  | 'acceptRemote'
  | 'markMerged'
  | 'acceptRemoteDeletion'
  | 'keepLocal';

export interface AiInvocation {
  action: AiAction;
  confirmed?: true;
  environmentId?: string;
  paths?: string[];
  path?: string;
  enabled?: boolean;
  preStateOrder?: string;
  pushRecordId?: string;
  pushRecordIds?: string[];
  changeSetId?: string;
  name?: string;
  resolution?: ConflictResolution;
}

export interface AiRequest extends AiInvocation {
  schemaVersion: 2;
  id: string;
  environmentDirectory: string;
  createdAt: string;
  expiresAt: string;
}

export interface AiResult {
  schemaVersion: 2;
  id: string;
  action: AiAction;
  environmentDirectory?: string;
  processedAt: string;
  status: 'succeeded' | 'partial' | 'cancelled' | 'rejected' | 'failed';
  data?: unknown;
  message?: string;
}

export interface AiInvocationResult {
  status: AiResult['status'];
  environmentDirectory?: string;
  data?: unknown;
  message?: string;
}

export function parseAiRequest(raw: string, fileName: string): AiRequest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('AI 请求不是有效 JSON');
  }
  if (!isRecord(value)) {
    throw new Error('AI 请求必须是 JSON 对象');
  }
  const id = requireIdentifier(value.id, 'id', 64);
  if (path.basename(fileName, '.json') !== id || path.extname(fileName) !== '.json') {
    throw new Error('AI 请求文件名必须为 <id>.json，并与请求 id 一致');
  }

  if (value.schemaVersion !== 2) {
    throw new Error('AI 请求 schemaVersion 必须为 2');
  }
  const invocation = parseAiInvocation(value);
  return {
    schemaVersion: 2,
    id,
    environmentDirectory: parseEnvironmentDirectory(value.environmentDirectory),
    createdAt: parseTimestamp(value.createdAt, 'createdAt'),
    expiresAt: parseTimestamp(value.expiresAt, 'expiresAt'),
    ...invocation,
  };
}

export function parseAiInvocation(value: unknown): AiInvocation {
  if (!isRecord(value)) {
    throw new Error('AI 调用参数必须是对象');
  }
  const action = requireAction(value.action);
  const invocation: AiInvocation = { action };
  if (AI_CONFIRMATION_ACTIONS.includes(action as never)) {
    if (value.confirmed !== true) {
      throw new Error(
        `AI action ${action} 需要先取得用户明确授权，并设置 confirmed: true`,
      );
    }
    invocation.confirmed = true;
  } else if (value.confirmed !== undefined) {
    throw new Error(`AI action ${action} 不接受 confirmed`);
  }

  switch (action) {
    case 'switchEnvironment':
    case 'deleteEnvironment':
      invocation.environmentId = requireIdentifier(value.environmentId, 'environmentId');
      break;
    case 'push':
      invocation.paths = parsePaths(value.paths);
      break;
    case 'setPreload':
    case 'setFolderRelease':
      invocation.path = parseRemotePath(value.path, 'path');
      invocation.enabled = requireBoolean(value.enabled, 'enabled');
      break;
    case 'setPreloadOrder':
      invocation.path = parseRemotePath(value.path, 'path');
      invocation.preStateOrder = normalizePreStateOrder(
        requireString(value.preStateOrder, 'preStateOrder', 100),
      );
      break;
    case 'rollbackPushFile':
      invocation.pushRecordId = requireIdentifier(value.pushRecordId, 'pushRecordId');
      invocation.path = parseRemotePath(value.path, 'path');
      break;
    case 'renamePushRecord':
      invocation.pushRecordId = requireIdentifier(value.pushRecordId, 'pushRecordId');
      invocation.name = requireString(value.name, 'name', 200);
      break;
    case 'deletePushRecord':
      invocation.pushRecordId = requireIdentifier(value.pushRecordId, 'pushRecordId');
      break;
    case 'revertChange':
      invocation.path = parseRemotePath(value.path, 'path');
      break;
    case 'resolveConflict':
      invocation.path = parseRemotePath(value.path, 'path');
      invocation.resolution = requireEnum<ConflictResolution>(
        value.resolution,
        'resolution',
        ['acceptRemote', 'markMerged', 'acceptRemoteDeletion', 'keepLocal'],
      );
      break;
    case 'createChangeSet':
      invocation.pushRecordIds = parseIdentifiers(value.pushRecordIds, 'pushRecordIds');
      invocation.name = requireString(value.name, 'name', 200);
      break;
    case 'applyChangeSet':
    case 'deleteChangeSet':
      invocation.changeSetId = requireIdentifier(value.changeSetId, 'changeSetId');
      break;
    default:
      break;
  }
  return invocation;
}

function requireAction(value: unknown): AiAction {
  if (
    typeof value !== 'string'
    || ![
      ...AI_INSPECT_ACTIONS,
      ...AI_EXECUTE_ACTIONS,
    ].includes(value as never)
  ) {
    throw new Error('AI 请求 action 不受支持');
  }
  return value as AiAction;
}

function parseEnvironmentDirectory(value: unknown): string {
  const directory = requireString(value, 'environmentDirectory', 100);
  const error = validateEnvironmentDirectory(directory);
  if (error) {
    throw new Error(error);
  }
  return directory;
}

function parseTimestamp(value: unknown, field: string): string {
  const timestamp = requireString(value, field, 100);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`AI 请求 ${field} 必须是有效 ISO 时间`);
  }
  return timestamp;
}

function parsePaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('AI 请求 paths 至少包含一个源码路径');
  }
  if (value.length > 100) {
    throw new Error('单个 AI 请求最多包含 100 个源码路径');
  }
  const paths = value.map((item, index) => parseRemotePath(item, `paths[${index}]`));
  const keys = paths.map(item => item.toLocaleLowerCase('en-US'));
  if (new Set(keys).size !== keys.length) {
    throw new Error('AI 请求 paths 不能包含重复路径');
  }
  return paths;
}

function parseRemotePath(value: unknown, field: string): string {
  return normalizeRemotePath(requireString(value, field, 1000));
}

function parseIdentifiers(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error(`AI 请求 ${field} 必须包含 1 到 100 个标识`);
  }
  const values = value.map((item, index) =>
    requireIdentifier(item, `${field}[${index}]`));
  if (new Set(values).size !== values.length) {
    throw new Error(`AI 请求 ${field} 不能重复`);
  }
  return values;
}

function requireIdentifier(value: unknown, field: string, maxLength = 128): string {
  const identifier = requireString(value, field, maxLength);
  if (!/^[A-Za-z0-9_-]+$/.test(identifier)) {
    throw new Error(`AI 请求 ${field} 只能包含英文字母、数字、下划线和横线`);
  }
  return identifier;
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`AI 请求 ${field} 必须是非空字符串`);
  }
  const result = value.trim();
  if (result.length > maxLength) {
    throw new Error(`AI 请求 ${field} 最长 ${maxLength} 个字符`);
  }
  return result;
}

function requireEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`AI 请求 ${field} 必须是 ${allowed.join('、')} 之一`);
  }
  return value as T;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`AI 请求 ${field} 必须是布尔值`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
