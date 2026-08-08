import type {
  DeploymentLifecycleResult,
  LifecycleChange,
} from '../domain/types';
import { lifecycleChangeLabel } from '../domain/lifecycle';

interface VerifiedResult {
  verified?: boolean;
  changed?: boolean;
  previous?: boolean;
  previousPreStateOrder?: string;
}

export interface LifecycleChangeExecutor {
  setFilePreloadedByPath(path: string, enabled: boolean): Promise<VerifiedResult>;
  setPreStateOrderByPath(path: string, order: string): Promise<VerifiedResult>;
  setFolderReleasedByPath(path: string, enabled: boolean): Promise<VerifiedResult>;
}

export async function deployLifecycleChanges(
  changes: LifecycleChange[],
  executor: LifecycleChangeExecutor,
  reportProgress: (message: string) => void,
  isCancellationRequested: () => boolean,
): Promise<DeploymentLifecycleResult[]> {
  const unpublish = changes.filter(change =>
    change.kind === 'folderRelease' && !change.after);
  const filePreload = changes.filter(change => change.kind === 'filePreload');
  const preloadOrder = changes.filter(change => change.kind === 'preloadOrder');
  const publish = changes.filter(change =>
    change.kind === 'folderRelease' && change.after);
  const results: DeploymentLifecycleResult[] = [];

  const apply = async (change: LifecycleChange): Promise<void> => {
    if (isCancellationRequested()) {
      results.push({
        kind: change.kind,
        path: change.path,
        status: 'skipped',
        message: '用户取消应用，留待重试',
      });
      return;
    }
    reportProgress(`应用生命周期配置: ${lifecycleChangeLabel(change)} · ${change.path}`);
    try {
      const result = change.kind === 'filePreload'
        ? await executor.setFilePreloadedByPath(change.path, change.after)
        : change.kind === 'preloadOrder'
          ? await executor.setPreStateOrderByPath(change.path, change.after)
          : await executor.setFolderReleasedByPath(change.path, change.after);
      requireVerified(result.verified, lifecycleChangeLabel(change));
      results.push({
        kind: change.kind,
        path: change.path,
        status: 'succeeded',
        changed: result.changed,
        previous: change.kind === 'preloadOrder'
          ? result.previousPreStateOrder
          : result.previous,
      });
    } catch (error: unknown) {
      results.push({
        kind: change.kind,
        path: change.path,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  for (const change of [...unpublish, ...filePreload, ...preloadOrder]) {
    await apply(change);
  }
  const prerequisitesSucceeded = results.every(result => result.status === 'succeeded');
  for (const change of publish) {
    if (!prerequisitesSucceeded) {
      results.push({
        kind: change.kind,
        path: change.path,
        status: 'skipped',
        message: '前置状态或加载顺序未全部成功，已阻止发布',
      });
    } else {
      await apply(change);
    }
  }
  return results;
}

function requireVerified(verified: boolean | undefined, operation: string): void {
  if (verified !== true) {
    throw new Error(
      verified === false
        ? `${operation}接口返回成功，但远端状态复核未通过`
        : `${operation}接口可能已写入，但当前服务端无法回读确认`,
    );
  }
}
