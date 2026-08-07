import { serverFingerprint } from './text';

export function lifecycleConnectionIdentity(
  environmentId: string,
  sourceRoot: string,
  serverUrl: string,
  username: string,
): string {
  return JSON.stringify([
    environmentId,
    sourceRoot.toLocaleLowerCase('en-US'),
    serverFingerprint(serverUrl, username),
  ]);
}

export function normalizePreStateOrder(value: string): string {
  const trimmed = value.trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(trimmed)) {
    throw new Error('前置加载顺序必须是整数或最多两位小数');
  }
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric) || Math.abs(numeric) > Number.MAX_SAFE_INTEGER / 100) {
    throw new Error('前置加载顺序数值过大');
  }
  return Object.is(numeric, -0) ? '0' : String(numeric);
}
