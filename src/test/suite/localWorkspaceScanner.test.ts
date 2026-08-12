import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MAX_RESOURCE_BYTES } from '../../domain/text';
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

    assert.strictEqual(current?.kind, 'text');
    assert.strictEqual(current?.kind === 'text' ? current.content : undefined, 'const value = 1;\n');
    assert.strictEqual(missing, undefined);
  });

  test('treats every file below a known resource root as raw bytes', async () => {
    const resourceDirectory = path.join(root, 'App', 'resources');
    fs.mkdirSync(resourceDirectory, { recursive: true });
    fs.writeFileSync(path.join(resourceDirectory, 'test.png'), '仍按资源处理\n', 'utf8');
    fs.writeFileSync(path.join(resourceDirectory, 'raw.bin'), Buffer.from([0, 255, 128]));

    const result = await new LocalWorkspaceScanner().scan(
      root,
      new Set(['App/resources']),
    );

    assert.strictEqual(result.files.get('App/resources/test.png')?.kind, 'resource');
    assert.strictEqual(result.files.get('App/resources/raw.bin')?.kind, 'resource');
    assert.strictEqual(result.files.get('App/resources/raw.bin')?.size, 3);
    assert.ok(!result.unsupported.some(item => item.path === 'App/resources/raw.bin'));
  });

  test('marks a resource larger than 100MB as unsupported before reading it', async () => {
    const resourceDirectory = path.join(root, 'App', 'resources');
    fs.mkdirSync(resourceDirectory, { recursive: true });
    const oversized = path.join(resourceDirectory, 'large.bin');
    fs.writeFileSync(oversized, '');
    fs.truncateSync(oversized, MAX_RESOURCE_BYTES + 1);

    const result = await new LocalWorkspaceScanner().scan(
      root,
      new Set(['App/resources']),
    );

    assert.strictEqual(result.files.has('App/resources/large.bin'), false);
    assert.match(result.unsupported[0]?.message ?? '', /100\s?MB/);
  });

  test('accepts a resource exactly at the 100MB limit', async () => {
    const resourceDirectory = path.join(root, 'App', 'resources');
    fs.mkdirSync(resourceDirectory, { recursive: true });
    const boundary = path.join(resourceDirectory, 'boundary.bin');
    fs.writeFileSync(boundary, '');
    fs.truncateSync(boundary, MAX_RESOURCE_BYTES);

    const result = await new LocalWorkspaceScanner().scan(
      root,
      new Set(['App/resources']),
    );

    const file = result.files.get('App/resources/boundary.bin');
    assert.strictEqual(file?.kind, 'resource');
    assert.strictEqual(file?.size, MAX_RESOURCE_BYTES);
    assert.ok(!result.unsupported.some(item => item.path === 'App/resources/boundary.bin'));
  });
});
