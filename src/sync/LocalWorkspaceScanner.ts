import * as fs from 'fs/promises';
import * as path from 'path';
import { assertNoCaseCollisions } from '../domain/paths';
import {
  formatResourceLimit,
  hashFileBytes,
  hashText,
  isSupportedText,
  MAX_RESOURCE_BYTES,
  textByteSize,
} from '../domain/text';
import type { FileKind, LocalFileState, SyncChange } from '../domain/types';

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

  async scan(
    syncRoot: string,
    resourceRoots: ReadonlySet<string> = new Set(),
  ): Promise<LocalScan> {
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
      entry => this.readDiscoveredFile(
        entry,
        unsupported,
        isResourcePath(entry.relative, resourceRoots),
      ),
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
    kind: FileKind = 'text',
  ): Promise<LocalFileState | undefined> {
    try {
      const stat = await fs.lstat(localPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`同步路径包含符号链接: ${localPath}`);
      }
      if (kind === 'resource') {
        const stat = await fs.stat(localPath);
        if (stat.size > MAX_RESOURCE_BYTES) {
          throw new Error(`资源文件超过 ${formatResourceLimit()} 上限: ${remotePath}`);
        }
        const result = await hashFileBytes(localPath);
        return {
          path: remotePath,
          kind: 'resource',
          sourcePath: localPath,
          hash: result.hash,
          size: result.size,
        };
      }
      const buffer = await fs.readFile(localPath);
      const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      if (!isSupportedText(content)) {
        throw new Error(`当前版本不支持非文本本地文件: ${remotePath}`);
      }
      return {
        path: remotePath,
        kind: 'text',
        content,
        hash: hashText(content),
        size: textByteSize(content),
      };
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
    resource: boolean,
  ): Promise<LocalFileState | undefined> {
    if (resource) {
      const stat = await fs.stat(entry.absolute);
      if (stat.size > MAX_RESOURCE_BYTES) {
        unsupported.push({
          path: entry.relative,
          status: 'unsupported',
          kind: 'resource',
          localSize: stat.size,
          message: `资源文件超过 ${formatResourceLimit()} 上限`,
        });
        return undefined;
      }
      const result = await hashFileBytes(entry.absolute);
      return {
        path: entry.relative,
        kind: 'resource',
        sourcePath: entry.absolute,
        hash: result.hash,
        size: result.size,
      };
    }
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
      kind: 'text',
      content,
      hash: hashText(content),
      size: textByteSize(content),
    };
  }
}

function isResourcePath(
  remotePath: string,
  resourceRoots: ReadonlySet<string>,
): boolean {
  for (const root of resourceRoots) {
    if (remotePath === root || remotePath.startsWith(`${root}/`)) {
      return true;
    }
  }
  return false;
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
