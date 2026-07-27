import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyLegacyProfile } from '../../domain/profileMigration';
import type { LegacyConnectionProfile } from '../../domain/types';

suite('Connection profile migration', () => {
  let root: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-profile-'));
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('migrates an existing v2 ecode directory without confirmation', () => {
    const migration = classifyLegacyProfile(profile('ecode'));

    assert.strictEqual(migration.kind, 'migrated');
    if (migration.kind === 'migrated') {
      assert.deepStrictEqual(migration.profile, {
        version: 3,
        workspaceFolder: root,
        serverUrl: 'https://example.test',
        username: 'sysadmin',
      });
    }
  });

  test('requires confirmation for a legacy custom source directory', () => {
    const migration = classifyLegacyProfile(profile('custom-source'));

    assert.strictEqual(migration.kind, 'confirmationRequired');
  });

  function profile(localDirectory: string): LegacyConnectionProfile {
    return {
      version: 2,
      workspaceFolder: root,
      serverUrl: 'https://example.test',
      username: 'sysadmin',
      localDirectory,
    };
  }
});
