import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectLegacyProjects } from '../../storage/LegacyProjectGuard';

suite('Legacy project guard', () => {
  let root: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-legacy-guard-'));
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('blocks a 0.5 project instead of migrating it', async () => {
    fs.mkdirSync(path.join(root, '.ecode-local', 'storage'), { recursive: true });
    fs.mkdirSync(path.join(root, 'ecode'));
    const detections = await detectLegacyProjects(context(), [root]);

    assert.strictEqual(detections.length, 1);
    assert.ok(detections[0].reasons.some(reason => reason.includes('storage')));
    assert.ok(detections[0].reasons.some(reason => reason.includes('ecode')));
  });

  test('allows a 0.6 project with the new file configuration', async () => {
    fs.mkdirSync(path.join(root, '.ecode-local'), { recursive: true });
    fs.mkdirSync(path.join(root, 'ecode'));
    fs.writeFileSync(
      path.join(root, '.ecode-local', 'environments.json'),
      JSON.stringify({ schemaVersion: 2 }),
      'utf8',
    );

    assert.deepStrictEqual(await detectLegacyProjects(context(), [root]), []);
  });

  test('allows a cleaned workspace even when VS Code retains inaccessible old state', async () => {
    const detections = await detectLegacyProjects(
      context(new Map([['ecode.v4.environments', {}]])),
      [root],
    );

    assert.deepStrictEqual(detections, []);
  });

  test('detects a legacy custom source directory referenced by old state', async () => {
    fs.mkdirSync(path.join(root, 'custom_source'));
    const detections = await detectLegacyProjects(
      context(new Map([['ecode.v2.profile', {
        workspaceFolder: root,
        localDirectory: 'custom_source',
      }]])),
      [root],
    );

    assert.strictEqual(detections.length, 1);
    assert.ok(detections[0].reasons.some(reason => reason.includes('custom_source')));
  });

  function context(state = new Map<string, unknown>()): never {
    return {
      workspaceState: {
        get: (key: string) => state.get(key),
      },
    } as never;
  }
});
