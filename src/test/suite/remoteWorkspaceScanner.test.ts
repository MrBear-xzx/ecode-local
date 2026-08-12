import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { RemoteWorkspaceScanner } from '../../sync/RemoteWorkspaceScanner';

suite('Remote workspace scanner', () => {
  const created: string[] = [];

  teardown(() => {
    for (const directory of created) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    created.length = 0;
  });

  test('cleans expired scan and single-resource staging directories only', async () => {
    const scanner = new RemoteWorkspaceScanner({} as never);
    const expiredScan = createTempDirectory('ecode-resource-scan-');
    const expiredSingle = createTempDirectory('ecode-resource-single-');
    const recentSingle = createTempDirectory('ecode-resource-single-');
    const unrelated = createTempDirectory('ecode-resource-test-');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(expiredScan, old, old);
    fs.utimesSync(expiredSingle, old, old);

    await scanner.cleanupExpiredStaging(30_000);

    assert.strictEqual(fs.existsSync(expiredScan), false);
    assert.strictEqual(fs.existsSync(expiredSingle), false);
    assert.strictEqual(fs.existsSync(recentSingle), true);
    assert.strictEqual(fs.existsSync(unrelated), true);
  });

  test('removes owned single-resource staging when download fails', async () => {
    const scanner = new RemoteWorkspaceScanner({} as never);
    const before = singleResourceStagingNames();

    await assert.rejects(
      scanner.readFile({
        downloadResource: async () => ({
          status: false,
          code: 404,
          msg: 'not found',
        }),
      } as never, {
        id: 'resource-1',
        path: 'App/resources/missing.bin',
        name: 'missing.bin',
        kind: 'resource',
        route: '/resource/missing.bin',
      }),
      /not found/,
    );

    assert.deepStrictEqual(singleResourceStagingNames(), before);
  });

  function createTempDirectory(prefix: string): string {
    const directory = path.join(os.tmpdir(), `${prefix}${randomUUID()}`);
    fs.mkdirSync(directory);
    created.push(directory);
    return directory;
  }

  function singleResourceStagingNames(): string[] {
    return fs.readdirSync(os.tmpdir())
      .filter(name => name.startsWith('ecode-resource-single-'))
      .sort();
  }
});
