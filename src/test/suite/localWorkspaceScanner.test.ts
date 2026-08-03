import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LocalWorkspaceScanner } from '../../sync/LocalWorkspaceScanner';

suite('Local workspace scanner', () => {
  let root: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-local-scan-'));
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('reads supported files concurrently while isolating invalid UTF-8', async () => {
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'a.js'), 'const a = 1;\n', 'utf8');
    fs.writeFileSync(path.join(root, 'nested', 'b.ts'), 'const b = 2;\n', 'utf8');
    fs.writeFileSync(path.join(root, 'invalid.bin'), Buffer.from([0xff, 0xfe]));

    const scanner = new LocalWorkspaceScanner(2);
    const result = await scanner.scan(root);

    assert.deepStrictEqual([...result.files.keys()].sort(), ['a.js', 'nested/b.ts']);
    assert.ok(result.directories.has('nested'));
    assert.strictEqual(result.unsupported[0]?.path, 'invalid.bin');
    assert.match(result.unsupported[0]?.message ?? '', /UTF-8/);
  });

  test('rechecks one file without rescanning the complete workspace', async () => {
    const file = path.join(root, 'a.js');
    fs.writeFileSync(file, 'const value = 1;\n', 'utf8');
    const scanner = new LocalWorkspaceScanner();

    const current = await scanner.readFileIfExists(file, 'a.js');
    const missing = await scanner.readFileIfExists(path.join(root, 'missing.js'), 'missing.js');

    assert.strictEqual(current?.content, 'const value = 1;\n');
    assert.strictEqual(missing, undefined);
  });
});
