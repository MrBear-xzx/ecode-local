import * as assert from 'assert';
import type {
  ChangeSet,
  EnvironmentProfile,
  PushRecord,
  SyncChange,
} from '../../domain/types';
import type { EcodeSyncService } from '../../sync/EcodeSyncService';
import { EcodeTreeProvider } from '../../ui/EcodeTreeProvider';
import { PromotionDiffProvider } from '../../ui/PromotionDiffProvider';
import {
  BASELINE_SCHEME,
  REMOTE_SCHEME,
  VirtualDocumentProvider,
  virtualUri,
} from '../../ui/VirtualDocumentProvider';

suite('Ecode UI models', () => {
  test('groups source, sync state, and changes below each environment', () => {
    const provider = new EcodeTreeProvider();
    const changes: SyncChange[] = [{
      path: 'Type/a.js',
      status: 'conflict',
      conflictReason: 'bothModified',
    }];
    const environment: EnvironmentProfile = {
      version: 2,
      id: 'test',
      name: '集成测试环境',
      directory: 'integration_env',
      serverUrl: 'http://localhost:8099',
      username: 'tester',
      workspaceFolder: 'D:\\workspace',
    };
    const inactiveEnvironment: EnvironmentProfile = {
      version: 2,
      id: 'prod',
      name: '生产环境',
      directory: 'prod_01',
      serverUrl: 'https://prod.example.com',
      username: 'publisher',
      workspaceFolder: 'D:\\workspace',
    };
    const pushRecord: PushRecord = {
      schemaVersion: 1,
      id: 'PUSH-20260730120000-test',
      name: '采购校验推送',
      environmentId: environment.id,
      createdAt: '2026-07-30T12:00:00.000Z',
      status: 'succeeded',
      requestedPaths: ['Type/a.js'],
      files: [{
        path: 'Type/a.js',
        operation: 'modify',
        verifiedAt: '2026-07-30T12:00:00.000Z',
      }],
    };
    const changeSet: ChangeSet = {
      schemaVersion: 1,
      id: 'CS-20260730121000-test',
      name: '采购校验',
      sourceEnvironmentId: environment.id,
      createdAt: '2026-07-30T12:10:00.000Z',
      updatedAt: '2026-07-30T12:10:00.000Z',
      files: {
        'Type/a.js': pushRecord.files[0],
      },
    };

    provider.update([{
      environment,
      active: true,
      lastSync: '2026/7/23 17:00:00',
      changes,
      pushRecords: [pushRecord],
    }, {
      environment: inactiveEnvironment,
      active: false,
      lastSync: '2026/7/22 12:00:00',
    }], [changeSet]);
    const roots = provider.getChildren();
    const labels = roots.map(item => provider.getTreeItem(item).label);
    const activeRoot = roots.find(item =>
      provider.getTreeItem(item).label === '集成测试环境');
    const environmentChildren = activeRoot
      ? provider.getChildren(activeRoot)
      : [];
    const syncGroup = environmentChildren.find(item =>
      provider.getTreeItem(item).label === '连接与同步');
    const changesGroup = environmentChildren.find(item =>
      provider.getTreeItem(item).label === '变更 (1)');
    const syncLabels = syncGroup
      ? provider.getChildren(syncGroup).map(item => provider.getTreeItem(item).label)
      : [];
    const sourceDirectory = environmentChildren
      .map(item => provider.getTreeItem(item))
      .find(item => item.label === '源码目录');
    const conflict = changesGroup
      ? provider.getChildren(changesGroup)[0]
      : undefined;
    const promotion = roots.find(item =>
      provider.getTreeItem(item).label === '跨环境变更集');
    const pushGroup = environmentChildren.find(item =>
      provider.getTreeItem(item).label === '推送记录 (1)');
    const pushNode = pushGroup
      ? provider.getChildren(pushGroup)[0]
      : undefined;
    const pushItem = pushNode ? provider.getTreeItem(pushNode) : undefined;
    const pushFile = pushNode
      ? provider.getTreeItem(provider.getChildren(pushNode)[0])
      : undefined;
    const changeSetNode = promotion
      ? provider.getChildren(promotion).find(item =>
          provider.getTreeItem(item).label === changeSet.name)
      : undefined;
    const changeSetItem = changeSetNode
      ? provider.getTreeItem(changeSetNode)
      : undefined;
    const changeSetFile = changeSetNode
      ? provider.getTreeItem(provider.getChildren(changeSetNode)[0])
      : undefined;

    assert.deepStrictEqual(labels, [
      '集成测试环境',
      '生产环境',
      '跨环境变更集',
    ]);
    assert.ok(syncLabels.includes('上次同步'));
    assert.strictEqual(sourceDirectory?.description, 'integration_env/');
    assert.strictEqual(provider.getTreeItem(activeRoot!).description, '当前环境');
    assert.strictEqual(themeIconId(provider.getTreeItem(activeRoot!)), 'server-environment');
    assert.strictEqual(themeIconId(sourceDirectory!), 'folder');
    assert.strictEqual(themeIconId(provider.getTreeItem(syncGroup!)), 'sync');
    assert.strictEqual(themeIconId(provider.getTreeItem(changesGroup!)), 'source-control');
    assert.strictEqual(themeIconId(provider.getTreeItem(conflict!)), 'warning');
    assert.strictEqual(themeIconId(provider.getTreeItem(promotion!)), 'git-pull-request');
    assert.strictEqual(themeIconId(provider.getTreeItem(pushGroup!)), 'history');
    assert.strictEqual(pushItem?.command, undefined);
    assert.strictEqual(pushItem?.label, pushRecord.name);
    assert.strictEqual(pushItem?.contextValue, 'ecode.pushRecord');
    assert.strictEqual(pushFile?.command?.command, 'ecode.openPromotionDiff');
    assert.strictEqual(pushFile?.contextValue, 'ecode.pushRecordFile');
    assert.strictEqual(changeSetItem?.contextValue, 'ecode.changeSet');
    assert.strictEqual(changeSetFile?.command?.command, 'ecode.openPromotionDiff');
    assert.strictEqual(changeSetFile?.contextValue, 'ecode.changeSetFile');
  });

  test('shows baseline initialization instead of reporting local changes', () => {
    const provider = new EcodeTreeProvider();
    const environment: EnvironmentProfile = {
      version: 2,
      id: 'integration',
      name: '集成环境',
      directory: 'integration_env',
      serverUrl: 'http://localhost:8099',
      username: 'tester',
      workspaceFolder: 'D:\\workspace',
    };

    provider.update([{
      environment,
      active: true,
      changes: [],
    }]);
    const environmentNode = provider.getChildren()[0];
    const syncGroup = provider.getChildren(environmentNode)
      .find(node => provider.getTreeItem(node).label === '连接与同步');
    const item = syncGroup
      ? provider.getChildren(syncGroup).map(node => provider.getTreeItem(node))
        .find(treeItem => treeItem.label === '当前环境尚未建立同步基线')
      : undefined;

    assert.strictEqual(item?.description, '请先执行全量拉取');
    assert.strictEqual(item?.command?.command, 'ecode.pull');
  });

  test('serves baseline and remote content through read-only virtual documents', async () => {
    const service = {
      getBaselineContent: async (remotePath: string) => `baseline:${remotePath}`,
      getLatestRemoteContent: async (remotePath: string) => `remote:${remotePath}`,
    } as EcodeSyncService;
    const remotePath = 'Type/含空格/a.js';
    const baseline = new VirtualDocumentProvider(BASELINE_SCHEME, service);
    const remote = new VirtualDocumentProvider(REMOTE_SCHEME, service);

    assert.strictEqual(
      await baseline.provideTextDocumentContent(virtualUri(BASELINE_SCHEME, remotePath)),
      `baseline:${remotePath}`,
    );
    assert.strictEqual(
      await remote.provideTextDocumentContent(virtualUri(REMOTE_SCHEME, remotePath)),
      `remote:${remotePath}`,
    );
  });

  test('serves immutable push snapshots for file-level diffs', () => {
    const provider = new PromotionDiffProvider();
    const uris = provider.createDiff(
      'Type/a.js',
      'const before = true;\n',
      'const after = true;\n',
    );

    assert.strictEqual(
      provider.provideTextDocumentContent(uris.before),
      'const before = true;\n',
    );
    assert.strictEqual(
      provider.provideTextDocumentContent(uris.after),
      'const after = true;\n',
    );
  });

  test('evicts old promotion diffs after the configured history limit', () => {
    const provider = new PromotionDiffProvider(2);
    const first = provider.createDiff('Type/first.js', 'first-before', 'first-after');
    const second = provider.createDiff('Type/second.js', 'second-before', 'second-after');
    const third = provider.createDiff('Type/third.js', 'third-before', 'third-after');

    assert.strictEqual(provider.provideTextDocumentContent(first.before), '');
    assert.strictEqual(provider.provideTextDocumentContent(first.after), '');
    assert.strictEqual(provider.provideTextDocumentContent(second.before), 'second-before');
    assert.strictEqual(provider.provideTextDocumentContent(third.after), 'third-after');
  });
});

function themeIconId(item: {
  iconPath?: unknown;
}): string | undefined {
  return (item.iconPath as { id?: string } | undefined)?.id;
}
