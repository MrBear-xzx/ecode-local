import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { StoredConflict, SyncManifest } from '../../domain/types';
import { WorkspaceStore } from '../../storage/WorkspaceStore';

suite('Workspace store', () => {
  let root: string;
  let state: Map<string, unknown>;
  let store: WorkspaceStore;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-store-'));
    state = new Map<string, unknown>();
    store = new WorkspaceStore({
      storageUri: { fsPath: root },
      workspaceState: {
        get: <T>(key: string): T | undefined => state.get(key) as T | undefined,
        update: async (key: string, value: unknown): Promise<void> => {
          state.set(key, value);
        },
      },
    } as never);
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('persists manifest updates atomically and rejects a different identity', async () => {
    const syncRoot = path.join(root, 'workspace', 'ecode');
    const manifest = emptyManifest('identity-a', syncRoot);
    await store.loadManifest('identity-a', syncRoot);
    await store.saveManifest(manifest);
    manifest.files['Type/a.js'] = {
      remoteId: 'file-1',
      path: 'Type/a.js',
      kind: 'text',
      baselineHash: 'hash',
      snapshotKey: 'snapshot',
      lastVerifiedAt: new Date().toISOString(),
    };
    await store.saveManifest(manifest);

    const restored = await store.loadManifest('identity-a', syncRoot);
    const otherIdentity = await store.loadManifest('identity-b', syncRoot);

    assert.ok(restored.files['Type/a.js']);
    assert.deepStrictEqual(otherIdentity.files, {});
  });

  test('scopes stored conflicts to the active connection identity', async () => {
    const syncRoot = path.join(root, 'workspace', 'ecode');
    const conflict: StoredConflict = {
      path: 'Type/a.js',
      remoteId: 'file-1',
      remoteContent: 'remote\n',
      remoteHash: 'hash',
      detectedAt: new Date().toISOString(),
      reason: 'bothModified',
    };

    await store.loadManifest('identity-a', syncRoot);
    await store.saveConflict(conflict);
    assert.strictEqual((await store.listConflicts()).length, 1);

    await store.loadManifest('identity-b', syncRoot);
    assert.strictEqual((await store.listConflicts()).length, 0);

    await store.loadManifest('identity-a', syncRoot);
    assert.strictEqual((await store.loadConflict('Type/a.js'))?.remoteId, 'file-1');
  });
});

function emptyManifest(serverFingerprint: string, syncRoot: string): SyncManifest {
  return {
    schemaVersion: 1,
    serverFingerprint,
    syncRoot,
    updatedAt: new Date(0).toISOString(),
    files: {},
  };
}
