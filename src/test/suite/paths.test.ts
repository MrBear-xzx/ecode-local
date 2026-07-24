import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  assertNoCaseCollisions,
  normalizeRemotePath,
  resolveSafeLocalPath,
  resolveSafeSyncRoot,
} from '../../domain/paths';

suite('Path safety', () => {
  let root: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-paths-'));
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('keeps configured and remote paths inside the workspace', () => {
    const syncRoot = resolveSafeSyncRoot(root, 'ecode');
    assert.strictEqual(syncRoot, path.join(root, 'ecode'));
    assert.strictEqual(
      resolveSafeLocalPath(syncRoot, 'type/folder/a.js'),
      path.join(root, 'ecode', 'type', 'folder', 'a.js'),
    );
  });

  test('rejects absolute and traversing local directories', () => {
    assert.throws(() => resolveSafeSyncRoot(root, path.resolve(root, 'ecode')));
    assert.throws(() => resolveSafeSyncRoot(root, '../outside'));
    assert.throws(() => resolveSafeSyncRoot(root, 'ecode/../outside'));
  });

  test('rejects a configured directory that escapes through a symbolic link', function () {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-outside-'));
    const link = path.join(root, 'linked');
    try {
      try {
        fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') {
          this.skip();
          return;
        }
        throw error;
      }
      assert.throws(() => resolveSafeSyncRoot(root, 'linked/ecode'), /工作区范围/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('rejects unsafe remote paths and Windows reserved names', () => {
    assert.throws(() => normalizeRemotePath('../secret.txt'));
    assert.throws(() => normalizeRemotePath('Type/../secret.txt'));
    assert.throws(() => normalizeRemotePath('Type//secret.txt'));
    assert.throws(() => normalizeRemotePath('/absolute.txt'));
    assert.throws(() => normalizeRemotePath('folder\\file.txt'));
    assert.throws(() => normalizeRemotePath('folder/CON.txt'));
    assert.throws(() => normalizeRemotePath('folder/file:name.txt'));
    assert.throws(() => normalizeRemotePath('folder/trailing.'));
  });

  test('detects case-insensitive path collisions', () => {
    assert.throws(() => assertNoCaseCollisions(['Type/a.js', 'type/A.js']));
    assert.doesNotThrow(() => assertNoCaseCollisions(['Type/a.js', 'Type/b.js']));
  });
});
