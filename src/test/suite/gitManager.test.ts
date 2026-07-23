import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { DIFF_MAX_LINES_PER_FILE } from '../../constants';
import { GitManager } from '../../sync/GitManager';

suite('GitManager', () => {
  let root: string;
  let git: SimpleGit;
  let manager: GitManager;

  setup(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-git-manager-'));
    manager = new GitManager(root);
    await manager.initRepo();

    git = simpleGit(root);
    await git.addConfig('user.name', 'Ecode Test');
    await git.addConfig('user.email', 'ecode-test@example.invalid');

    const ecodeDir = path.join(root, 'ecode');
    fs.mkdirSync(ecodeDir, { recursive: true });
    fs.writeFileSync(path.join(ecodeDir, 'tracked.txt'), 'line 1\nline 2\n');
    fs.writeFileSync(path.join(ecodeDir, 'deleted.txt'), 'delete me\n');
    fs.writeFileSync(path.join(ecodeDir, '中文.txt'), '旧内容\n');
    fs.writeFileSync(
      path.join(ecodeDir, 'large.txt'),
      Array.from({ length: 50 }, (_, index) => `old ${index}`).join('\n'),
    );
    fs.writeFileSync(path.join(root, 'outside.txt'), 'outside\n');
    await git.add(['.gitignore', 'ecode/']);
    await git.commit('baseline');
    await git.checkoutLocalBranch('feature/test');
  });

  teardown(() => {
    if (root?.startsWith(os.tmpdir())) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('tracks branch and working-tree changes with ecode-relative paths', async () => {
    const ecodeDir = path.join(root, 'ecode');
    fs.writeFileSync(path.join(ecodeDir, 'tracked.txt'), 'line 1\nline 2 changed\n');
    fs.rmSync(path.join(ecodeDir, 'deleted.txt'));
    fs.writeFileSync(path.join(ecodeDir, '中文.txt'), '新内容\n');
    fs.writeFileSync(path.join(ecodeDir, 'untracked.txt'), 'new file\n');
    fs.writeFileSync(path.join(root, 'outside-untracked.txt'), 'outside\n');

    await git.add('ecode/tracked.txt');
    fs.appendFileSync(path.join(ecodeDir, 'tracked.txt'), 'working tree line\n');

    assert.deepStrictEqual(
      (await manager.getChangedFiles()).sort(),
      ['deleted.txt', 'tracked.txt', '中文.txt'].sort(),
    );
    assert.deepStrictEqual(await manager.getUntrackedFiles(), ['untracked.txt']);

    const summary = await manager.getDiffSummary();
    assert.deepStrictEqual(
      summary.map(change => [change.path, change.status]).sort(),
      [
        ['deleted.txt', 'deleted'],
        ['tracked.txt', 'modified'],
        ['中文.txt', 'modified'],
      ].sort(),
    );
  });

  test('reports whether pull changes produced a commit', async () => {
    fs.writeFileSync(path.join(root, 'ecode', 'untracked.txt'), 'new file\n');

    assert.strictEqual(await manager.commit('sync: test pull'), true);
    assert.strictEqual(await manager.commit('sync: test pull'), false);
  });

  test('truncates displayed diff lines without undercounting totals', async () => {
    fs.writeFileSync(
      path.join(root, 'ecode', 'large.txt'),
      Array.from({ length: 50 }, (_, index) => `new ${index}`).join('\n'),
    );

    const summary = await manager.getDiffSummary();
    const change = summary.find(item => item.path === 'large.txt');

    assert.ok(change);
    assert.strictEqual(change.additions, 50);
    assert.strictEqual(change.deletions, 50);
    assert.strictEqual(change.truncated, true);
    assert.ok(
      change.hunks.reduce((count, hunk) => count + hunk.lines.length, 0)
        <= DIFF_MAX_LINES_PER_FILE,
    );
  });
});
