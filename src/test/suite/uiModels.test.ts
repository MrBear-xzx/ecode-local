import * as assert from 'assert';
import type { ConnectionProfile, SyncChange } from '../../domain/types';
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
      version: 2,
      serverUrl: 'http://localhost:8099',
      username: 'tester',
      workspaceFolder: 'D:\\workspace',
      localDirectory: 'ecode',
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

    assert.ok(labels.includes('连接'));
    assert.ok(labels.includes('变更 (1)'));
    assert.ok(connectionLabels.includes('上次同步'));
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
