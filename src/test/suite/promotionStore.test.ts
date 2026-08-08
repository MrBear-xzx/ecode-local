import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hashText } from '../../domain/text';
import type { DeploymentRecord } from '../../domain/types';
import { PromotionStore } from '../../storage/PromotionStore';

suite('Promotion store', () => {
  let root: string;
  let store: PromotionStore;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-promotion-'));
    store = new PromotionStore(root);
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('folds repeated source-environment pushes into one net change', async () => {
    const changeSet = await store.createChangeSet(
      '采购申请校验',
      'environment-a',
    );
    await store.recordVerifiedCandidates(changeSet.id, [{
      path: 'Type/a.js',
      operation: 'modify',
      baseHash: hashText('base'),
      baseContent: 'base',
      resultHash: hashText('first'),
      resultContent: 'first',
    }]);
    const updated = await store.recordVerifiedCandidates(changeSet.id, [{
      path: 'Type/a.js',
      operation: 'modify',
      baseHash: hashText('first'),
      baseContent: 'first',
      resultHash: hashText('final'),
      resultContent: 'final',
    }]);

    assert.strictEqual(updated.files['Type/a.js'].operation, 'modify');
    assert.strictEqual(updated.files['Type/a.js'].baseHash, hashText('base'));
    assert.strictEqual(updated.files['Type/a.js'].resultHash, hashText('final'));

    const artifacts = await store.materializeChangeSet(updated);
    assert.strictEqual(artifacts.length, 1);
    assert.strictEqual(artifacts[0].resultContent, 'final');
  });

  test('removes a file added and deleted within the same change set', async () => {
    const changeSet = await store.createChangeSet('临时文件', 'environment-a');
    await store.recordVerifiedCandidates(changeSet.id, [{
      path: 'Type/temp.js',
      operation: 'add',
      resultHash: hashText('temporary'),
      resultContent: 'temporary',
    }]);
    const updated = await store.recordVerifiedCandidates(changeSet.id, [{
      path: 'Type/temp.js',
      operation: 'delete',
      baseHash: hashText('temporary'),
      baseContent: 'temporary',
    }]);

    assert.deepStrictEqual(updated.files, {});
    assert.deepStrictEqual(await store.materializeChangeSet(updated), []);
  });

  test('persists deployment records', async () => {
    const record: DeploymentRecord = {
      schemaVersion: 1,
      id: 'DEP-1',
      changeSetId: 'CS-1',
      targetEnvironmentId: 'environment-b',
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(1).toISOString(),
      status: 'succeeded',
      files: [{
        path: 'Type/a.js',
        operation: 'modify',
        status: 'succeeded',
      }],
    };

    await store.saveDeployment(record);

    assert.deepStrictEqual(await store.listDeployments(), [record]);
  });

  test('records and filters verified lifecycle changes', async () => {
    const record = await store.recordLifecycleChange('environment-a', {
      kind: 'filePreload',
      path: 'Type/app/a.js',
      before: false,
      after: true,
      verifiedAt: new Date(0).toISOString(),
    });

    assert.strictEqual(record.change.verifiedAt, record.createdAt);
    assert.deepStrictEqual(
      (await store.listLifecycleRecords('environment-a')).map(item => item.id),
      [record.id],
    );
    assert.deepStrictEqual(await store.listLifecycleRecords('environment-b'), []);

    await store.deleteLifecycleRecord(record.id);
    assert.deepStrictEqual(await store.listLifecycleRecords(), []);
  });

  test('folds lifecycle records to a final net state', async () => {
    const changeSet = await store.createChangeSet('生命周期', 'environment-a');
    await store.recordLifecycleChanges(changeSet.id, [{
      kind: 'folderRelease',
      path: 'Type/app',
      before: false,
      after: true,
      verifiedAt: new Date(0).toISOString(),
    }]);
    const reverted = await store.recordLifecycleChanges(changeSet.id, [{
      kind: 'folderRelease',
      path: 'type/APP',
      before: true,
      after: false,
      verifiedAt: new Date(1).toISOString(),
    }]);

    assert.deepStrictEqual(reverted.lifecycleChanges, {});
  });

  test('rejects a preload state for a file deleted by the same change set', async () => {
    const changeSet = await store.createChangeSet('非法组合', 'environment-a');
    await store.recordVerifiedCandidates(changeSet.id, [{
      path: 'Type/app/a.js',
      operation: 'delete',
      baseHash: hashText('old'),
      baseContent: 'old',
    }]);

    await assert.rejects(
      store.recordLifecycleChanges(changeSet.id, [{
        kind: 'filePreload',
        path: 'Type/app/a.js',
        before: true,
        after: false,
        verifiedAt: new Date(0).toISOString(),
      }]),
      /将被删除的文件不能设置前置状态/,
    );
  });

  test('loads legacy change sets as code-only records', async () => {
    const directory = path.join(root, '.ecode-local', 'promotion', 'change-sets');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'CS-legacy.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'CS-legacy',
      name: '旧记录',
      sourceEnvironmentId: 'environment-a',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      files: {},
    }));

    assert.deepStrictEqual((await store.getChangeSet('CS-legacy'))?.lifecycleChanges, {});
  });

  test('persists immutable successful push snapshots for later promotion', async () => {
    const before = 'const value = 1;\n';
    const after = 'const value = 2;\n';
    const record = await store.recordPush('environment-a', [{
      path: 'Type/a.js',
      operation: 'modify',
      baseHash: hashText(before),
      baseContent: before,
      resultHash: hashText(after),
      resultContent: after,
    }], ['Type/a.js', 'Type/failed.js'], '采购校验推送');

    assert.strictEqual(record.status, 'partial');
    assert.strictEqual(record.name, '采购校验推送');
    assert.deepStrictEqual(
      (await store.listPushRecords('environment-a')).map(item => item.id),
      [record.id],
    );
    assert.deepStrictEqual(await store.listPushRecords('environment-b'), []);
    assert.deepStrictEqual(await store.materializePushRecord(record), [{
      path: 'Type/a.js',
      operation: 'modify',
      baseHash: hashText(before),
      baseContent: before,
      resultHash: hashText(after),
      resultContent: after,
    }]);
  });

  test('defaults, renames, and deletes push record names', async () => {
    const record = await store.recordPush('environment-a', [{
      path: 'Type/a.js',
      operation: 'add',
      resultHash: hashText('source'),
      resultContent: 'source',
    }], ['Type/a.js'], '   ');

    assert.strictEqual(record.name, new Date(record.createdAt).toLocaleString());
    const renamed = await store.renamePushRecord(record.id, '  发布采购校验  ');
    assert.strictEqual(renamed.name, '发布采购校验');
    assert.strictEqual((await store.listPushRecords())[0].name, '发布采购校验');

    await store.deletePushRecord(record.id);
    assert.deepStrictEqual(await store.listPushRecords(), []);
    await assert.rejects(
      store.deletePushRecord(record.id),
      /不存在或已删除/,
    );
  });

  test('uses the original timestamp label for legacy unnamed push records', async () => {
    const createdAt = '2026-07-30T12:00:00.000Z';
    const recordDirectory = path.join(
      root,
      '.ecode-local',
      'promotion',
      'push-records',
    );
    fs.mkdirSync(recordDirectory, { recursive: true });
    fs.writeFileSync(path.join(recordDirectory, 'PUSH-legacy.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'PUSH-legacy',
      environmentId: 'environment-a',
      createdAt,
      status: 'succeeded',
      requestedPaths: [],
      files: [],
    }));

    const records = await store.listPushRecords();

    assert.strictEqual(records[0].name, new Date(createdAt).toLocaleString());
  });

  test('can compose a change set from an earlier push record', async () => {
    const record = await store.recordPush('environment-a', [{
      path: 'Type/a.js',
      operation: 'add',
      resultHash: hashText('source'),
      resultContent: 'source',
    }], ['Type/a.js']);
    const changeSet = await store.createChangeSet(
      '事后整理',
      'environment-a',
    );

    const updated = await store.recordVerifiedCandidates(
      changeSet.id,
      await store.materializePushRecord(record),
    );

    assert.strictEqual(updated.files['Type/a.js'].resultHash, hashText('source'));
  });

  test('keeps multiple directly applicable change sets', async () => {
    const first = await store.createChangeSet('第一批', 'environment-a');
    const second = await store.createChangeSet('第二批', 'environment-a');

    assert.deepStrictEqual(
      (await store.listChangeSets()).map(item => item.id).sort(),
      [first.id, second.id].sort(),
    );
  });

  test('cancels only the selected change set record', async () => {
    const cancelled = await store.createChangeSet('取消此项', 'environment-a');
    const retained = await store.createChangeSet('保留此项', 'environment-a');

    await store.deleteChangeSet(cancelled.id);

    assert.deepStrictEqual(
      (await store.listChangeSets()).map(item => item.id),
      [retained.id],
    );
    await assert.rejects(
      store.deleteChangeSet(cancelled.id),
      /不存在或已取消/,
    );
  });

  test('rejects a corrupted change-set source object', async () => {
    const content = 'const safe = true;\n';
    const changeSet = await store.createChangeSet(
      '快照校验',
      'environment-a',
    );
    await store.recordVerifiedCandidates(changeSet.id, [{
      path: 'Type/safe.js',
      operation: 'add',
      resultHash: hashText(content),
      resultContent: content,
    }]);
    const updated = await store.getChangeSet(changeSet.id);
    fs.writeFileSync(
      path.join(
        root,
        '.ecode-local',
        'promotion',
        'objects',
        `${hashText(content)}.txt`,
      ),
      'tampered',
      'utf8',
    );

    await assert.rejects(
      store.materializeChangeSet(updated!),
      /对象存储校验失败/,
    );
  });
});
