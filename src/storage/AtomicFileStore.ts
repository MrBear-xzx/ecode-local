import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

const writeQueues = new Map<string, Promise<void>>();

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomic(file: string, content: string): Promise<void> {
  const target = path.resolve(file);
  const previous = writeQueues.get(target) ?? Promise.resolve();
  const current = previous.then(
    () => writeTextAtomicNow(target, content),
    () => writeTextAtomicNow(target, content),
  );
  writeQueues.set(target, current);
  try {
    await current;
  } finally {
    if (writeQueues.get(target) === current) {
      writeQueues.delete(target);
    }
  }
}

async function writeTextAtomicNow(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}-${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  let writeError: unknown;
  try {
    await fs.writeFile(temporary, content, 'utf8');
    await fs.rename(temporary, file);
  } catch (error: unknown) {
    writeError = error;
    throw error;
  } finally {
    try {
      await fs.unlink(temporary);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !writeError) {
        throw error;
      }
    }
  }
}
