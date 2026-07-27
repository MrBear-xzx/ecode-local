import * as assert from 'assert';
import type {
  ConnectionProfile,
  LegacyConnectionProfile,
  SyncChange,
} from '../../domain/types';
import type { EcodeSyncService } from '../../sync/EcodeSyncService';
import { EcodeTreeProvider } from '../../ui/EcodeTreeProvider';
import {
  BASELINE_SCHEME,
  REMOTE_SCHEME,
  VirtualDocumentProvider,
  virtualUri,
} from '../../ui/VirtualDocumentProvider';

suite('Ecode UI models', () => {
  test('shows connection, last sync, and categorized change state', () => {
    const provider = new EcodeTreeProvider();
    const profile: ConnectionProfile = {
      version: 3,
      serverUrl: 'http://localhost:8099',
      username: 'tester',
      workspaceFolder: 'D:\\workspace',
    };
    const changes: SyncChange[] = [{
      path: 'Type/a.js',
      status: 'conflict',
      conflictReason: 'bothModified',
    }];

    provider.update(profile, changes, undefined, '2026/7/23 17:00:00');
    const roots = provider.getChildren();
    const labels = roots.map(item => provider.getTreeItem(item).label);
    const connection = roots.find(item => provider.getTreeItem(item).label === '连接');
    const connectionLabels = connection
      ? provider.getChildren(connection).map(item => provider.getTreeItem(item).label)
      : [];
    const sourceDirectory = connection
      ? provider.getChildren(connection)
        .map(item => provider.getTreeItem(item))
        .find(item => item.label === '源码目录（固定）')
      : undefined;

    assert.ok(labels.includes('连接'));
    assert.ok(labels.includes('变更 (1)'));
    assert.ok(connectionLabels.includes('上次同步'));
    assert.strictEqual(sourceDirectory?.description, 'ecode/');
  });

  test('shows a migration command instead of enabling sync for a custom v2 directory', () => {
    const provider = new EcodeTreeProvider();
    const legacy: LegacyConnectionProfile = {
      version: 2,
      serverUrl: 'http://localhost:8099',
      username: 'tester',
      workspaceFolder: 'D:\\workspace',
      localDirectory: 'legacy-source',
    };

    provider.update(undefined, [], undefined, undefined, legacy);
    const item = provider.getTreeItem(provider.getChildren()[0]);

    assert.strictEqual(item.label, '旧源码目录需要迁移');
    assert.strictEqual(item.description, 'legacy-source');
    assert.strictEqual(item.command?.command, 'ecode.confirmSourceDirectoryMigration');
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
});
