import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  ConnectionProfile,
  LegacyConnectionProfile,
  StoredConflict,
  SyncManifest,
} from '../../domain/types';
import type { FormMetadataCache } from '../../domain/formMetadata';
import {
  updateGitIgnoreForEcodeLocal,
  WorkspaceStore,
} from '../../storage/WorkspaceStore';

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

  test('reads and clears a legacy v2 connection profile separately', async () => {
    const legacy: LegacyConnectionProfile = {
      version: 2,
      workspaceFolder: path.join(root, 'workspace'),
      serverUrl: 'https://example.test',
      username: 'sysadmin',
      localDirectory: 'custom-source',
    };
    state.set('ecode.v2.profile', legacy);

    assert.deepStrictEqual(await store.getLegacyProfile(), legacy);
    assert.strictEqual(await store.getProfile(), undefined);
    await store.clearLegacyProfile();
    assert.strictEqual(await store.getLegacyProfile(), undefined);

    const current: ConnectionProfile = {
      version: 3,
      workspaceFolder: legacy.workspaceFolder,
      serverUrl: legacy.serverUrl,
      username: legacy.username,
    };
    await store.saveProfile(current);
    assert.deepStrictEqual(await store.getProfile(), current);
  });

  test('persists form metadata separately for the active server and sync root', async () => {
    const syncRoot = path.join(root, 'workspace', 'ecode');
    const cache: FormMetadataCache = {
      schemaVersion: 1,
      serverFingerprint: 'identity-a',
      syncRoot,
      updatedAt: new Date(0).toISOString(),
      files: {
        'Type/form.js': {
          remoteId: 'file-1',
          path: 'Type/form.js',
          updatedAt: new Date(0).toISOString(),
          contexts: [{
            kind: 'workflow',
            workflowId: '77',
            tables: [{
              mark: 'main',
              fields: [{ id: '110', label: '申请人', name: 'applicant' }],
            }],
          }],
        },
      },
    };

    await store.saveFormMetadataCache(cache);
    const restored = await store.loadFormMetadataCache('identity-a', syncRoot);
    const otherServer = await store.loadFormMetadataCache('identity-b', syncRoot);
    const otherRoot = await store.loadFormMetadataCache(
      'identity-a',
      path.join(root, 'other', 'ecode'),
    );

    assert.strictEqual(
      restored.files['Type/form.js'].contexts[0].tables[0].fields[0].label,
      '申请人',
    );
    assert.deepStrictEqual(otherServer.files, {});
    assert.deepStrictEqual(otherRoot.files, {});
    assert.strictEqual(
      fs.existsSync(path.join(workspaceStorageRoot(), 'form-metadata.json.tmp')),
      false,
    );
    assert.strictEqual(
      fs.existsSync(path.join(workspaceStorageRoot(), 'form-metadata.json')),
      true,
    );
  });

  test('copies legacy extension storage into the workspace-local directory', async () => {
    const syncRoot = path.join(root, 'workspace', 'ecode');
    const legacyManifest = emptyManifest('identity-a', syncRoot);
    legacyManifest.files['Type/a.js'] = {
      remoteId: 'file-1',
      path: 'Type/a.js',
      kind: 'text',
      baselineHash: 'hash',
      snapshotKey: 'snapshot',
      lastVerifiedAt: new Date(0).toISOString(),
    };
    fs.writeFileSync(
      path.join(root, 'sync-manifest.json'),
      `${JSON.stringify(legacyManifest)}\n`,
      'utf8',
    );
    fs.mkdirSync(path.join(root, 'snapshots'));
    fs.writeFileSync(path.join(root, 'snapshots', 'snapshot.txt'), 'source', 'utf8');

    const restored = await store.loadManifest('identity-a', syncRoot);

    assert.ok(restored.files['Type/a.js']);
    assert.strictEqual(await store.readSnapshot('snapshot'), 'source');
    assert.strictEqual(
      fs.existsSync(path.join(workspaceStorageRoot(), 'sync-manifest.json')),
      true,
    );
    assert.strictEqual(
      fs.existsSync(path.join(root, 'sync-manifest.json')),
      true,
      '旧扩展存储应保留作为迁移兜底',
    );
  });

  test('adds .ecode-local to git ignore without replacing existing rules', async () => {
    const workspaceRoot = path.join(root, 'workspace');
    const syncRoot = path.join(workspaceRoot, 'ecode');
    fs.mkdirSync(path.join(workspaceRoot, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceRoot, '.gitignore'),
      'node_modules/\n',
      'utf8',
    );

    await store.loadManifest('identity-a', syncRoot);
    await store.loadFormMetadataCache('identity-a', syncRoot);

    const gitIgnore = fs.readFileSync(
      path.join(workspaceRoot, '.gitignore'),
      'utf8',
    );
    assert.match(gitIgnore, /^node_modules\/$/m);
    assert.strictEqual(
      gitIgnore.match(/^\/\.ecode-local\/$/gm)?.length,
      1,
    );
    assert.strictEqual(
      updateGitIgnoreForEcodeLocal(gitIgnore),
      gitIgnore,
    );
  });

  test('does not create .gitignore outside a git repository', async () => {
    const workspaceRoot = path.join(root, 'workspace');
    await store.loadManifest(
      'identity-a',
      path.join(workspaceRoot, 'ecode'),
    );
    assert.strictEqual(
      fs.existsSync(path.join(workspaceRoot, '.gitignore')),
      false,
    );
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

  function workspaceStorageRoot(): string {
    return path.join(root, 'workspace', '.ecode-local', 'storage');
  }
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
