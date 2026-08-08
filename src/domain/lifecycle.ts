import { serverFingerprint } from './text';
import type { LifecycleChange } from './types';

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

export function lifecycleChangeLabel(change: LifecycleChange): string {
  if (change.kind === 'filePreload') {
    return change.after ? '设置前置加载' : '取消前置加载';
  }
  if (change.kind === 'folderRelease') {
    return change.after ? '发布文件夹' : '取消发布文件夹';
  }
  return `前置顺序 ${change.after}`;
}

export function lifecycleChangeTransition(change: LifecycleChange): string {
  if (change.kind === 'preloadOrder') {
    return `${change.before} → ${change.after}`;
  }
  const state = (value: boolean): string => value ? '启用' : '停用';
  return `${state(change.before)} → ${state(change.after)}`;
}
