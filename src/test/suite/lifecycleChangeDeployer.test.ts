import * as assert from 'assert';
import type { LifecycleChange } from '../../domain/types';
import {
  deployLifecycleChanges,
  type LifecycleChangeExecutor,
} from '../../sync/LifecycleChangeDeployer';

suite('Lifecycle change deployer', () => {
  test('orders unpublish, file preload, preload order, and publish operations', async () => {
    const calls: string[] = [];
    const executor = createExecutor(calls);
    const changes: LifecycleChange[] = [
      release('Type/published', true),
      order('Type/app', '10'),
      preload('Type/app/a.js', true),
      release('Type/disabled', false),
    ];

    const results = await deployLifecycleChanges(changes, executor, () => undefined, () => false);

    assert.deepStrictEqual(calls, [
      'release:Type/disabled:false',
      'preload:Type/app/a.js:true',
      'order:Type/app:10',
      'release:Type/published:true',
    ]);
    assert.ok(results.every(result => result.status === 'succeeded'));
    assert.ok(results.every(result => result.changed === true));
  });

  test('continues independent configuration but blocks publish after a failure', async () => {
    const calls: string[] = [];
    const executor = createExecutor(calls, 'Type/app/a.js');
    const results = await deployLifecycleChanges([
      preload('Type/app/a.js', true),
      order('Type/app', '10'),
      release('Type/app', true),
    ], executor, () => undefined, () => false);

    assert.deepStrictEqual(calls, [
      'preload:Type/app/a.js:true',
      'order:Type/app:10',
    ]);
    assert.deepStrictEqual(results.map(result => result.status), [
      'failed',
      'succeeded',
      'skipped',
    ]);
    assert.match(results[2].message ?? '', /已阻止发布/);
  });

  test('treats an unverified write as failed', async () => {
    const executor = {
      ...createExecutor([]),
      setFolderReleasedByPath: async () => ({ verified: undefined }),
    };
    const results = await deployLifecycleChanges(
      [release('Type/app', false)],
      executor,
      () => undefined,
      () => false,
    );

    assert.strictEqual(results[0].status, 'failed');
    assert.match(results[0].message ?? '', /无法回读确认/);
  });
});

function createExecutor(
  calls: string[],
  failedPreloadPath?: string,
): LifecycleChangeExecutor {
  return {
    setFilePreloadedByPath: async (path, enabled) => {
      calls.push(`preload:${path}:${enabled}`);
      if (path === failedPreloadPath) {
        throw new Error('前置失败');
      }
      return { verified: true, changed: true, previous: !enabled };
    },
    setPreStateOrderByPath: async (path, value) => {
      calls.push(`order:${path}:${value}`);
      return {
        verified: true,
        changed: true,
        previousPreStateOrder: '10000',
      };
    },
    setFolderReleasedByPath: async (path, enabled) => {
      calls.push(`release:${path}:${enabled}`);
      return { verified: true, changed: true, previous: !enabled };
    },
  };
}

function preload(path: string, after: boolean): LifecycleChange {
  return {
    kind: 'filePreload',
    path,
    before: !after,
    after,
    verifiedAt: new Date(0).toISOString(),
  };
}

function release(path: string, after: boolean): LifecycleChange {
  return {
    kind: 'folderRelease',
    path,
    before: !after,
    after,
    verifiedAt: new Date(0).toISOString(),
  };
}

function order(path: string, after: string): LifecycleChange {
  return {
    kind: 'preloadOrder',
    path,
    before: '10000',
    after,
    verifiedAt: new Date(0).toISOString(),
  };
}
