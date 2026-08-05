import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { FormMetadataCache } from '../../domain/formMetadata';
import type {
  StoredConflict,
  SyncManifest,
} from '../../domain/types';
import {
  updateGitIgnoreForEcodeLocal,
  WorkspaceStore,
} from '../../storage/WorkspaceStore';

suite('Workspace store', () => {
  let root: string;
  let workspaceFolder: string;
  let store: WorkspaceStore;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-store-'));
    workspaceFolder = path.join(root, 'workspace');
    fs.mkdirSync(workspaceFolder);
    store = new WorkspaceStore(workspaceFolder);
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('persists manifest updates atomically and rejects a different identity', async () => {
    const syncRoot = path.join(workspaceFolder, 'dev_01');
    const manifest = emptyManifest('identity-a', syncRoot);
    await store.loadManifest('identity-a', syncRoot);
    manifest.files['Type/a.js'] = manifestEntry('Type/a.js', 'hash');
    await store.saveManifest(manifest);

    const restored = await store.loadManifest('identity-a', syncRoot);
    const otherIdentity = await store.loadManifest('identity-b', syncRoot);

    assert.ok(restored.files['Type/a.js']);
    assert.deepStrictEqual(otherIdentity.files, {});
    assert.strictEqual(
      fs.existsSync(path.join(environmentRoot('dev_01'), 'sync-manifest.json.tmp')),
      false,
    );
  });

  test('persists environment configuration only in .ecode-local', async () => {
    const saved = await store.saveEnvironment({
      name: '开发环境',
      directory: 'dev_env',
      workspaceFolder,
      serverUrl: 'https://dev.example',
      username: 'developer',
    });

    const configurationFile = path.join(
      workspaceFolder,
      '.ecode-local',
      'environments.json',
    );
    const raw = fs.readFileSync(configurationFile, 'utf8');
    const configuration = JSON.parse(raw) as {
      schemaVersion: number;
      environments: Array<Record<string, unknown>>;
    };

    assert.strictEqual(configuration.schemaVersion, 2);
    assert.strictEqual(configuration.environments[0].directory, 'dev_env');
    assert.strictEqual(configuration.environments[0].workspaceFolder, undefined);
    assert.strictEqual(configuration.environments[0].password, undefined);
    assert.strictEqual((await store.getActiveEnvironment())?.id, saved.id);
    assert.deepStrictEqual(await store.getProfile(), {
      version: 4,
      environmentId: saved.id,
      environmentDirectory: 'dev_env',
      workspaceFolder,
      serverUrl: 'https://dev.example',
      username: 'developer',
    });
  });

  test('keeps source roots and environment data isolated by directory', async () => {
    const development = await store.saveEnvironment({
      name: '开发环境',
      directory: 'dev',
      workspaceFolder,
      serverUrl: 'https://dev.example',
      username: 'developer',
    });
    const devRoot = path.join(workspaceFolder, development.directory);
    const devManifest = emptyManifest('identity-dev', devRoot);
    devManifest.files['Type/dev.js'] = manifestEntry('Type/dev.js', 'dev');
    await store.saveManifest(devManifest);

    const target = await store.saveEnvironment({
      name: '目标环境',
      directory: 'target_env',
      workspaceFolder,
      serverUrl: 'https://target.example',
      username: 'publisher',
    });
    const targetRoot = path.join(workspaceFolder, target.directory);
    const targetManifest = emptyManifest('identity-target', targetRoot);
    targetManifest.files['Type/target.js'] = manifestEntry('Type/target.js', 'target');
    await store.saveManifest(targetManifest);

    assert.ok((await store.loadManifest('identity-dev', devRoot)).files['Type/dev.js']);
    assert.strictEqual(
      (await store.loadManifest('identity-dev', devRoot)).files['Type/target.js'],
      undefined,
    );
    assert.ok(
      (await store.loadManifest('identity-target', targetRoot)).files['Type/target.js'],
    );
    assert.strictEqual(
      fs.existsSync(path.join(environmentRoot('dev'), 'sync-manifest.json')),
      true,
    );
    assert.strictEqual(
      fs.existsSync(path.join(environmentRoot('target_env'), 'sync-manifest.json')),
      true,
    );
    await store.setActiveEnvironment(development.id);
    assert.strictEqual((await store.getActiveEnvironment())?.directory, 'dev');
  });

  test('rejects duplicate, invalid, and mutable environment directories', async () => {
    const saved = await store.saveEnvironment({
      name: '开发环境',
      directory: 'dev_env',
      workspaceFolder,
      serverUrl: 'https://dev.example',
      username: 'developer',
    });
    await assert.rejects(
      store.saveEnvironment({
        name: '另一个环境',
        directory: 'DEV_ENV',
        workspaceFolder,
        serverUrl: 'https://other.example',
        username: 'other',
      }),
      /已由环境/,
    );
    const numericDirectory = await store.saveEnvironment({
      name: '数字目录',
      directory: 'dev2',
      workspaceFolder,
      serverUrl: 'https://numeric.example',
      username: 'numeric',
    });
    assert.strictEqual(numericDirectory.directory, 'dev2');
    await assert.rejects(
      store.saveEnvironment({
        name: '非法目录',
        directory: 'dev-2',
        workspaceFolder,
        serverUrl: 'https://other.example',
        username: 'other',
      }),
      /只能包含/,
    );
    await assert.rejects(
      store.saveEnvironment({
        id: saved.id,
        name: saved.name,
        directory: 'renamed',
        workspaceFolder,
        serverUrl: saved.serverUrl,
        username: saved.username,
      }),
      /不可修改/,
    );
  });

  test('deletes an environment with its source and local data, then switches active environment', async () => {
    const development = await store.saveEnvironment({
      name: '开发环境',
      directory: 'dev',
      workspaceFolder,
      serverUrl: 'https://dev.example',
      username: 'developer',
    });
    const temporary = await store.saveEnvironment({
      name: '临时环境',
      directory: 'temporary',
      workspaceFolder,
      serverUrl: 'https://temporary.example',
      username: 'tester',
    });
    const sourceRoot = path.join(workspaceFolder, temporary.directory);
    const dataRoot = environmentRoot(temporary.directory);
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'local.js'), 'const local = true;\n');
    fs.writeFileSync(path.join(dataRoot, 'state.json'), '{}');

    const result = await store.deleteEnvironment(temporary.id);

    assert.strictEqual(result.deletedEnvironment.id, temporary.id);
    assert.strictEqual(result.activeEnvironment.id, development.id);
    assert.strictEqual((await store.getActiveEnvironment())?.id, development.id);
    assert.deepStrictEqual((await store.getEnvironments()).map(item => item.id), [development.id]);
    assert.strictEqual(fs.existsSync(sourceRoot), false);
    assert.strictEqual(fs.existsSync(dataRoot), false);
  });

  test('refuses to delete the last environment and preserves its files', async () => {
    const environment = await store.saveEnvironment({
      name: '唯一环境',
      directory: 'only',
      workspaceFolder,
      serverUrl: 'https://only.example',
      username: 'tester',
    });
    const sourceRoot = path.join(workspaceFolder, environment.directory);
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'keep.js'), 'const keep = true;\n');

    await assert.rejects(
      store.deleteEnvironment(environment.id),
      /不能删除最后一个/,
    );
    assert.strictEqual(fs.existsSync(path.join(sourceRoot, 'keep.js')), true);
    assert.strictEqual((await store.getActiveEnvironment())?.id, environment.id);
  });

  test('persists form metadata in the matching environment directory', async () => {
    const syncRoot = path.join(workspaceFolder, 'dev');
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

    assert.strictEqual(
      restored.files['Type/form.js'].contexts[0].tables[0].fields[0].label,
      '申请人',
    );
    assert.deepStrictEqual(otherServer.files, {});
    assert.strictEqual(
      fs.existsSync(path.join(environmentRoot('dev'), 'form-metadata.json')),
      true,
    );
  });

  test('adds .ecode-local to git ignore without replacing existing rules', async () => {
    fs.mkdirSync(path.join(workspaceFolder, '.git'));
    fs.writeFileSync(path.join(workspaceFolder, '.gitignore'), 'node_modules/\n', 'utf8');

    await store.loadManifest('identity-a', path.join(workspaceFolder, 'dev'));

    const gitIgnore = fs.readFileSync(path.join(workspaceFolder, '.gitignore'), 'utf8');
    assert.match(gitIgnore, /^node_modules\/$/m);
    assert.strictEqual(gitIgnore.match(/^\/\.ecode-local\/$/gm)?.length, 1);
    assert.strictEqual(updateGitIgnoreForEcodeLocal(gitIgnore), gitIgnore);
  });

  test('does not create .gitignore outside a git repository', async () => {
    await store.loadManifest('identity-a', path.join(workspaceFolder, 'dev'));
    assert.strictEqual(fs.existsSync(path.join(workspaceFolder, '.gitignore')), false);
  });

  test('scopes stored conflicts to each environment directory', async () => {
    const developmentRoot = path.join(workspaceFolder, 'dev');
    const targetRoot = path.join(workspaceFolder, 'target');
    const conflict: StoredConflict = {
      path: 'Type/a.js',
      remoteId: 'file-1',
      remoteContent: 'remote\n',
      remoteHash: 'hash',
      detectedAt: new Date().toISOString(),
      reason: 'bothModified',
    };

    await store.loadManifest('identity-a', developmentRoot);
    await store.saveConflict(developmentRoot, conflict);
    assert.strictEqual((await store.listConflicts(developmentRoot)).length, 1);

    await store.loadManifest('identity-b', targetRoot);
    assert.strictEqual((await store.listConflicts(targetRoot)).length, 0);

    assert.strictEqual(
      (await store.loadConflict(developmentRoot, 'Type/a.js'))?.remoteId,
      'file-1',
    );
  });

  test('keeps distinct recovery copies created for the same file', async () => {
    const syncRoot = path.join(workspaceFolder, 'dev');
    await store.loadManifest('identity-a', syncRoot);

    const first = await store.saveRecovery(syncRoot, 'Type/a.js', 'remote version');
    const second = await store.saveRecovery(syncRoot, 'Type/a.js', 'local version');

    assert.notStrictEqual(first, second);
    assert.strictEqual(fs.readFileSync(first, 'utf8'), 'remote version');
    assert.strictEqual(fs.readFileSync(second, 'utf8'), 'local version');
  });

  function environmentRoot(directory: string): string {
    return path.join(workspaceFolder, '.ecode-local', directory);
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

function manifestEntry(remotePath: string, hash: string): SyncManifest['files'][string] {
  return {
    remoteId: `file-${hash}`,
    path: remotePath,
    kind: 'text',
    baselineHash: hash,
    snapshotKey: hash,
    lastVerifiedAt: new Date(0).toISOString(),
  };
}
