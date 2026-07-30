import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  assertNoCaseCollisions,
  normalizeRemotePath,
  resolveEnvironmentDataRoot,
  resolveEnvironmentSourceRoot,
  resolveSafeLocalPath,
  validateEnvironmentDirectory,
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
    const syncRoot = resolveEnvironmentSourceRoot(root, 'dev_01');
    assert.strictEqual(syncRoot, path.join(root, 'dev_01'));
    assert.strictEqual(
      resolveEnvironmentDataRoot(root, 'dev_01'),
      path.join(root, '.ecode-local', 'dev_01'),
    );
    assert.strictEqual(
      resolveSafeLocalPath(syncRoot, 'type/folder/a.js'),
      path.join(root, 'dev_01', 'type', 'folder', 'a.js'),
    );
  });

  test('accepts only English letters, digits, and underscores for environment directories', () => {
    assert.strictEqual(validateEnvironmentDirectory('dev_env'), undefined);
    assert.strictEqual(validateEnvironmentDirectory('dev2'), undefined);
    assert.strictEqual(validateEnvironmentDirectory('2026'), undefined);
    assert.match(validateEnvironmentDirectory('生产_环境') ?? '', /只能包含/);
    assert.match(validateEnvironmentDirectory('dev-2') ?? '', /只能包含/);
    assert.match(validateEnvironmentDirectory('../outside') ?? '', /只能包含/);
    assert.match(validateEnvironmentDirectory('___') ?? '', /至少包含/);
    assert.match(validateEnvironmentDirectory('.ecode-local') ?? '', /只能包含/);
    assert.match(validateEnvironmentDirectory('common') ?? '', /保留名称/);
    assert.match(validateEnvironmentDirectory('promotion') ?? '', /保留名称/);
    assert.match(validateEnvironmentDirectory('CON') ?? '', /Windows 保留名称/);
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
