import * as assert from 'assert';
import { ManifestCheckpoint } from '../../sync/ManifestCheckpoint';

suite('Manifest checkpoint', () => {
  test('batches repeated changes and flushes the remainder', async () => {
    let saves = 0;
    const checkpoint = new ManifestCheckpoint(async () => {
      saves++;
    }, 3);

    await checkpoint.markDirty();
    await checkpoint.markDirty();
    assert.strictEqual(saves, 0);
    await checkpoint.markDirty();
    assert.strictEqual(saves, 1);
    await checkpoint.markDirty();
    await checkpoint.flush();
    assert.strictEqual(saves, 2);
    await checkpoint.flush();
    assert.strictEqual(saves, 2);
  });
});
