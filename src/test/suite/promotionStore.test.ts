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
    }], ['Type/a.js', 'Type/failed.js']);

    assert.strictEqual(record.status, 'partial');
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
