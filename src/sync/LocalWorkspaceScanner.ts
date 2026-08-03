import * as fs from 'fs/promises';
import * as path from 'path';
import { assertNoCaseCollisions } from '../domain/paths';
import { hashText, isSupportedText } from '../domain/text';
import type { LocalFileState, SyncChange } from '../domain/types';

export interface LocalScan {
  files: Map<string, LocalFileState>;
  directories: Set<string>;
  unsupported: SyncChange[];
}

interface LocalFileEntry {
  absolute: string;
  relative: string;
}

export class LocalWorkspaceScanner {
  constructor(private readonly readConcurrency = 8) {}

  async scan(syncRoot: string): Promise<LocalScan> {
    const files = new Map<string, LocalFileState>();
    const directories = new Set<string>();
    const unsupported: SyncChange[] = [];
    try {
      await fs.access(syncRoot);
    } catch {
      return { files, directories, unsupported };
    }

    const discoveredFiles: LocalFileEntry[] = [];
    const pendingDirectories = [syncRoot];
    for (let index = 0; index < pendingDirectories.length; index++) {
      const directory = pendingDirectories[index];
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(syncRoot, absolute).split(path.sep).join('/');
        if (entry.isSymbolicLink()) {
          unsupported.push({
            path: relative,
            status: 'unsupported',
            message: '不跟随符号链接',
          });
        } else if (entry.isDirectory()) {
          directories.add(relative);
          pendingDirectories.push(absolute);
        } else if (entry.isFile()) {
          discoveredFiles.push({ absolute, relative });
        }
      }
    }

    const scanned = await mapConcurrent(
      discoveredFiles,
      this.readConcurrency,
      entry => this.readDiscoveredFile(entry, unsupported),
    );
    for (const file of scanned) {
      if (file) {
        files.set(file.path, file);
      }
    }
    assertNoCaseCollisions(files.keys());
    assertNoCaseCollisions(directories);
    unsupported.sort((left, right) => left.path.localeCompare(right.path));
    return { files, directories, unsupported };
  }

  async readFileIfExists(
    localPath: string,
    remotePath: string,
  ): Promise<LocalFileState | undefined> {
    try {
      const stat = await fs.lstat(localPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`同步路径包含符号链接: ${localPath}`);
      }
      const buffer = await fs.readFile(localPath);
      const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      if (!isSupportedText(content)) {
        throw new Error(`当前版本不支持非文本本地文件: ${remotePath}`);
      }
      return { path: remotePath, content, hash: hashText(content) };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  private async readDiscoveredFile(
    entry: LocalFileEntry,
    unsupported: SyncChange[],
  ): Promise<LocalFileState | undefined> {
    const buffer = await fs.readFile(entry.absolute);
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      unsupported.push({
        path: entry.relative,
        status: 'unsupported',
        message: '当前版本仅支持 UTF-8 文本',
      });
      return undefined;
    }
    if (!isSupportedText(content)) {
      unsupported.push({
        path: entry.relative,
        status: 'unsupported',
        message: '当前版本不支持二进制文件',
      });
      return undefined;
    }
    return {
      path: entry.relative,
      content,
      hash: hashText(content),
    };
  }
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= values.length) {
          return;
        }
        results[index] = await operation(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
