import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeJsonAtomic } from '../../storage/AtomicFileStore';

suite('Atomic file store', () => {
  let root: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-atomic-store-'));
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('keeps concurrent writes valid and removes unique temporary files', async () => {
    const file = path.join(root, 'state.json');
    const values = Array.from({ length: 20 }, (_, value) => ({ value }));

    await Promise.all(values.map(value => writeJsonAtomic(file, value)));

    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { value: number };
    assert.ok(values.some(value => value.value === stored.value));
    assert.deepStrictEqual(
      fs.readdirSync(root).filter(name => name.endsWith('.tmp')),
      [],
    );
  });
});
