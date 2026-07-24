import * as assert from 'assert';
import { buildLocalChanges, buildSyncPlan } from '../../domain/syncPlanner';
import { hashText } from '../../domain/text';
import type {
  LocalFileState,
  RemoteFileContent,
  SyncManifest,
} from '../../domain/types';

suite('Sync planner', () => {
  test('plans an initial remote pull and adopts identical local content', () => {
    const remote = remoteFile('type/a.js', 'remote-1', 'const a = 1;\n');
    const plan = buildSyncPlan(
      manifest(),
      new Map([['type/a.js', localFile('type/a.js', 'const a = 1;\r\n')]]),
      new Map([['type/a.js', remote]]),
    );

    assert.strictEqual(plan.changes[0].status, 'remoteAdded');
    assert.strictEqual(plan.executable.length, 1);
  });

  test('blocks an initial collision instead of overwriting local content', () => {
    const plan = buildSyncPlan(
      manifest(),
      new Map([['type/a.js', localFile('type/a.js', 'local')]]),
      new Map([['type/a.js', remoteFile('type/a.js', 'remote-1', 'remote')]]),
    );

    assert.strictEqual(plan.changes[0].status, 'conflict');
    assert.strictEqual(plan.changes[0].conflictReason, 'initialCollision');
    assert.strictEqual(plan.executable.length, 0);
  });

  test('distinguishes local, remote, and concurrent modifications', () => {
    const base = 'base\n';
    const state = manifest({
      'local.js': entry('local.js', base),
      'remote.js': entry('remote.js', base),
      'both.js': entry('both.js', base),
    });
    const local = new Map<string, LocalFileState>([
      ['local.js', localFile('local.js', 'local\n')],
      ['remote.js', localFile('remote.js', base)],
      ['both.js', localFile('both.js', 'local\n')],
    ]);
    const remote = new Map<string, RemoteFileContent>([
      ['local.js', remoteFile('local.js', '1', base)],
      ['remote.js', remoteFile('remote.js', '2', 'remote\n')],
      ['both.js', remoteFile('both.js', '3', 'remote\n')],
    ]);

    const statuses = new Map(
      buildSyncPlan(state, local, remote).changes.map(change => [change.path, change.status]),
    );
    assert.strictEqual(statuses.get('local.js'), 'localModified');
    assert.strictEqual(statuses.get('remote.js'), 'remoteModified');
    assert.strictEqual(statuses.get('both.js'), 'conflict');
  });

  test('detects local and remote deletions without making them executable', () => {
    const state = manifest({
      'local-deleted.js': entry('local-deleted.js', 'base'),
      'remote-deleted.js': entry('remote-deleted.js', 'base'),
    });
    const local = new Map([
      ['remote-deleted.js', localFile('remote-deleted.js', 'base')],
    ]);
    const remote = new Map([
      ['local-deleted.js', remoteFile('local-deleted.js', '1', 'base')],
    ]);
    const plan = buildSyncPlan(state, local, remote);
    const statuses = new Map(plan.changes.map(change => [change.path, change.status]));

    assert.strictEqual(statuses.get('local-deleted.js'), 'localDeleted');
    assert.strictEqual(statuses.get('remote-deleted.js'), 'remoteDeleted');
    assert.strictEqual(plan.executable.length, 0);
  });

  test('reports new, modified, and deleted local files from a manifest', () => {
    const state = manifest({
      'modified.js': entry('modified.js', 'base'),
      'deleted.js': entry('deleted.js', 'base'),
    });
    const local = new Map([
      ['modified.js', localFile('modified.js', 'changed')],
      ['added.js', localFile('added.js', 'new')],
    ]);
    const statuses = new Map(
      buildLocalChanges(state, local).map(change => [change.path, change.status]),
    );

    assert.strictEqual(statuses.get('modified.js'), 'localModified');
    assert.strictEqual(statuses.get('deleted.js'), 'localDeleted');
    assert.strictEqual(statuses.get('added.js'), 'localAdded');
  });
});

function manifest(
  files: SyncManifest['files'] = {},
): SyncManifest {
  return {
    schemaVersion: 1,
    serverFingerprint: 'test',
    syncRoot: 'C:\\test',
    updatedAt: new Date(0).toISOString(),
    files,
  };
}

function entry(path: string, content: string): SyncManifest['files'][string] {
  return {
    remoteId: path,
    path,
    kind: 'text',
    baselineHash: hashText(content),
    snapshotKey: hashText(content),
    lastVerifiedAt: new Date(0).toISOString(),
  };
}

function localFile(path: string, content: string): LocalFileState {
  return { path, content, hash: hashText(content) };
}

function remoteFile(path: string, id: string, content: string): RemoteFileContent {
  return {
    entry: { id, path, name: path.split('/').at(-1) ?? path, kind: 'text' },
    content,
    hash: hashText(content),
  };
}
