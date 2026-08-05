import type * as vscode from 'vscode';
import { assertNoCaseCollisions, normalizeRemotePath } from '../domain/paths';
import { hashText, isSupportedText } from '../domain/text';
import type {
  RemoteFileContent,
  RemoteFileEntry,
  SyncChange,
} from '../domain/types';
import {
  EcodeOperationError,
  SessionExpiredError,
  SyncCancelledError,
  requireSuccess,
} from './EcodeErrors';
import type { FileApi } from './api/FileApi';
import type { ApiResponse, TreeNode, TreePayload } from './api/types';

export interface CancellationLike {
  readonly isCancellationRequested: boolean;
}

export interface RemoteScan {
  files: Map<string, RemoteFileContent>;
  presentPaths: Set<string>;
  presentDirectories: Set<string>;
  ambiguousDirectories: Set<string>;
  unsupported: SyncChange[];
  errors: string[];
}

export interface RemoteDirectoryEntry {
  id: string;
  path: string;
  kind: 'type' | 'folder';
}

export interface RemoteIndex {
  files: Map<string, RemoteFileEntry>;
  directories: Map<string, RemoteDirectoryEntry>;
  ambiguousDirectories: Set<string>;
  pathCollisions: SyncChange[];
  unsupportedPaths: SyncChange[];
  observedFilePaths: Set<string>;
  preloadedFiles: Map<string, RemoteFileContent>;
}

interface RemoteTreeTask extends RemoteDirectoryEntry {}

export class RemoteWorkspaceScanner {
  constructor(private readonly output: vscode.LogOutputChannel) {}

  async scan(
    api: FileApi,
    onProgress: (message: string) => void,
    cancellation?: CancellationLike,
  ): Promise<RemoteScan> {
    const index = await this.listIndex(api, cancellation, onProgress);
    const entries = index.files;
    const unsupported: SyncChange[] = [
      ...index.pathCollisions,
      ...index.unsupportedPaths,
    ];
    const errors: string[] = [];
    const total = entries.size;
    let completed = 0;
    onProgress(`正在读取远端文件 0/${total}`);
    const contents = await mapConcurrent([...entries.values()], 4, async entry => {
      this.throwIfCancelled(cancellation);
      try {
        const preloaded = index.preloadedFiles.get(entry.path);
        return preloaded?.entry.id === entry.id
          ? preloaded
          : await this.readFile(api, entry);
      } catch (error: unknown) {
        if (error instanceof SessionExpiredError) {
          throw error;
        }
        if (error instanceof EcodeOperationError && error.code !== undefined) {
          errors.push(`${entry.path}: ${error.message}`);
          return undefined;
        }
        unsupported.push({
          path: entry.path,
          status: 'unsupported',
          remoteId: entry.id,
          message: errorMessage(error),
        });
        return undefined;
      } finally {
        completed++;
        onProgress(`正在读取远端文件 ${completed}/${total}: ${entry.path}`);
      }
    });

    return {
      files: new Map(
        contents
          .filter((item): item is RemoteFileContent => Boolean(item))
          .map(item => [item.entry.path, item]),
      ),
      presentPaths: new Set([
        ...index.observedFilePaths,
        ...index.pathCollisions.map(change => change.path),
      ]),
      presentDirectories: new Set([
        ...index.directories.keys(),
        ...index.ambiguousDirectories,
      ]),
      ambiguousDirectories: new Set(index.ambiguousDirectories),
      unsupported,
      errors,
    };
  }

  async listIndex(
    api: FileApi,
    cancellation?: CancellationLike,
    onProgress?: (message: string) => void,
  ): Promise<RemoteIndex> {
    onProgress?.('正在读取远端文件树...');
    const rootResponse = await api.listTree();
    if (
      !rootResponse.status
      && rootResponse.code === undefined
      && !rootResponse.msg
    ) {
      throw new EcodeOperationError(
        '获取远端文件树失败：服务端返回 status=false，且未提供错误码或错误消息；'
        + '请重新配置连接并确认登录账号具有 Ecode 源码读取权限',
      );
    }
    const root = requireSuccess(rootResponse, '获取远端文件树失败');
    const entries: RemoteFileEntry[] = [];
    const directories: RemoteDirectoryEntry[] = [];
    const directoryHasDataByNode = new Map<string, boolean>();
    const traversedPathByNode = new Map<string, string>();
    const aliasedDirectoryPaths = new Set<string>();
    const traversalCollisions: SyncChange[] = [];
    const unsupportedPaths: SyncChange[] = [];
    let pending: RemoteTreeTask[] = [];
    const system = root.system;
    if (system?.id) {
      const remotePath = normalizeRemoteNodePath(system.name, '分类', unsupportedPaths);
      if (remotePath) {
        pending.push({ id: system.id, path: remotePath, kind: 'type' });
      }
    }
    for (const type of root.typeList) {
      const remotePath = normalizeRemoteNodePath(type.name, '分类', unsupportedPaths);
      if (remotePath) {
        pending.push({ id: type.id, path: remotePath, kind: 'type' });
      }
    }

    let completedDirectories = 0;
    while (pending.length > 0) {
      this.throwIfCancelled(cancellation);
      const level: RemoteTreeTask[] = [];
      for (const task of pending) {
        const nodeKey = remoteDirectoryNodeKey(task);
        const traversedPath = traversedPathByNode.get(nodeKey);
        if (traversedPath === undefined) {
          traversedPathByNode.set(nodeKey, task.path);
          level.push(task);
          continue;
        }
        if (traversedPath === task.path) {
          this.output.warn(
            `远端目录节点重复，已安全去重: ${task.path} `
              + `(${formatMaskedRemoteIds([task.id])})`,
          );
          continue;
        }
        if (!aliasedDirectoryPaths.has(task.path)) {
          aliasedDirectoryPaths.add(task.path);
          traversalCollisions.push({
            path: task.path,
            status: 'unsupported',
            conflictReason: 'remotePathCollision',
            message: `远端目录节点同时映射到多个路径，已隔离歧义子树: ${task.path}`,
          });
          this.output.warn(
            `远端目录节点形成重复引用或循环，已隔离: `
              + `${traversedPath} / ${task.path} `
              + `(${formatMaskedRemoteIds([task.id])})`,
          );
        }
      }
      pending = [];
      if (level.length === 0) {
        continue;
      }
      const children = await mapConcurrent(level, 4, async task => {
        this.throwIfCancelled(cancellation);
        const payload = requireSuccess(
          await this.listDirectory(api, task),
          task.kind === 'type'
            ? `读取分类失败: ${task.path}`
            : `读取目录失败: ${task.path}`,
        );
        directories.push(task);
        directoryHasDataByNode.set(
          remoteDirectoryNodeKey(task),
          payload.childFile.length > 0
            || payload.childFolder.length > 0
            || payload.typeList.length > 0,
        );
        this.collectFiles(payload.childFile, task.path, entries, unsupportedPaths);
        completedDirectories++;
        onProgress?.(`正在扫描远端目录：已完成 ${completedDirectories} 个`);
        const childTasks: RemoteTreeTask[] = [];
        for (const folder of payload.childFolder) {
          const remotePath = normalizeRemoteNodePath(
            joinRemote(task.path, folder.name),
            '目录',
            unsupportedPaths,
          );
          if (remotePath) {
            childTasks.push({ id: folder.id, path: remotePath, kind: 'folder' });
          }
        }
        for (const type of payload.typeList) {
          const remotePath = normalizeRemoteNodePath(
            joinRemote(task.path, type.name),
            '分类',
            unsupportedPaths,
          );
          if (remotePath) {
            childTasks.push({ id: type.id, path: remotePath, kind: 'type' });
          }
        }
        return childTasks;
      });
      pending.push(...children.flat());
    }

    const observedFilePaths = new Set(entries.map(item => item.path));
    const ambiguousDirectories = new Set(aliasedDirectoryPaths);
    const pathCollisions: SyncChange[] = [...traversalCollisions];
    const directoryMap = new Map<string, RemoteDirectoryEntry>();
    const directoriesByPath = new Map<
      string,
      Map<string, RemoteDirectoryEntry>
    >();
    for (const directory of directories) {
      const nodes = directoriesByPath.get(directory.path)
        ?? new Map<string, RemoteDirectoryEntry>();
      nodes.set(remoteDirectoryNodeKey(directory), directory);
      directoriesByPath.set(directory.path, nodes);
    }
    for (const [remotePath, nodesById] of directoriesByPath) {
      if (ambiguousDirectories.has(remotePath)) {
        continue;
      }
      const nodes = [...nodesById.values()];
      if (nodes.length === 1) {
        directoryMap.set(remotePath, nodes[0]);
        continue;
      }
      const populated = nodes.filter(node =>
        directoryHasDataByNode.get(remoteDirectoryNodeKey(node)) === true);
      if (populated.length === 1) {
        directoryMap.set(remotePath, populated[0]);
        this.output.warn(
          `远端目录路径重复，已选择唯一有数据节点: ${remotePath} `
            + `(selected=${formatMaskedRemoteIds([populated[0].id])}; `
            + `candidates=${formatMaskedRemoteIds(nodes.map(node => node.id))})`,
        );
        continue;
      }
      ambiguousDirectories.add(remotePath);
      pathCollisions.push({
        path: remotePath,
        status: 'unsupported',
        conflictReason: 'remotePathCollision',
        message: `远端目录路径存在多个节点，且无法唯一确定有数据节点，已隔离子树: ${remotePath}`,
      });
      this.output.warn(
        `远端目录路径存在歧义，已隔离子树: ${remotePath} `
          + `(${formatMaskedRemoteIds(nodes.map(node => node.id))})`,
      );
    }
    for (const directoryPath of [...directoryMap.keys()]) {
      if ([...ambiguousDirectories].some(ambiguousPath =>
        isPathAtOrBelow(directoryPath, ambiguousPath))) {
        directoryMap.delete(directoryPath);
      }
    }

    const candidateEntries = entries.filter(entry =>
      ![...ambiguousDirectories].some(directory =>
        isPathAtOrBelow(entry.path, directory)));
    const entriesByPath = new Map<string, RemoteFileEntry[]>();
    for (const entry of candidateEntries) {
      const matches = entriesByPath.get(entry.path) ?? [];
      matches.push(entry);
      entriesByPath.set(entry.path, matches);
    }
    const resolvedEntries: RemoteFileEntry[] = [];
    const preloadedFiles = new Map<string, RemoteFileContent>();
    for (const [remotePath, matches] of entriesByPath) {
      const entriesById = new Map<string, RemoteFileEntry>();
      for (const entry of matches) {
        entriesById.set(entry.id, entry);
      }
      const uniqueEntries = [...entriesById.values()];
      if (uniqueEntries.length === 1) {
        resolvedEntries.push(uniqueEntries[0]);
        if (matches.length > 1) {
          this.output.warn(
            `远端文件节点重复，已安全去重: ${remotePath} `
              + `(${formatMaskedRemoteIds([uniqueEntries[0].id])})`,
          );
        }
        continue;
      }

      const inspected = await mapConcurrent(uniqueEntries, 4, async entry => {
        this.throwIfCancelled(cancellation);
        try {
          return {
            entry,
            content: await this.readFile(api, entry),
          };
        } catch (error: unknown) {
          if (error instanceof SessionExpiredError) {
            throw error;
          }
          return { entry, content: undefined };
        }
      });
      const readable = inspected.filter(
        (item): item is {
          entry: RemoteFileEntry;
          content: RemoteFileContent;
        } => Boolean(item.content),
      );
      const populated = readable.filter(item => item.content.content.length > 0);
      if (readable.length === uniqueEntries.length && populated.length === 1) {
        const selected = populated[0];
        resolvedEntries.push(selected.entry);
        preloadedFiles.set(remotePath, selected.content);
        this.output.warn(
          `远端文件路径重复，已选择唯一有数据节点: ${remotePath} `
            + `(selected=${formatMaskedRemoteIds([selected.entry.id])}; `
            + `candidates=${formatMaskedRemoteIds(uniqueEntries.map(entry => entry.id))})`,
        );
        continue;
      }
      pathCollisions.push({
        path: remotePath,
        status: 'unsupported',
        conflictReason: 'remotePathCollision',
        message: `远端文件路径存在多个节点，且无法唯一确定有数据节点，已标记为不支持: ${remotePath}`,
      });
      this.output.warn(
        `远端文件路径存在歧义，已标记为不支持: ${remotePath} `
          + `(${formatMaskedRemoteIds(uniqueEntries.map(entry => entry.id))})`,
      );
    }

    const allDirectoryPaths = new Set([
      ...directoryMap.keys(),
      ...ambiguousDirectories,
    ]);
    assertNoCaseCollisions(allDirectoryPaths);
    const directoryPathByKey = new Map<string, string>();
    for (const directoryPath of allDirectoryPaths) {
      directoryPathByKey.set(remotePathKey(directoryPath), directoryPath);
    }
    const collisionKeys = new Set(
      pathCollisions.map(change => remotePathKey(change.path)),
    );
    for (const entry of resolvedEntries) {
      const directoryPath = directoryPathByKey.get(remotePathKey(entry.path));
      if (!directoryPath) {
        continue;
      }
      collisionKeys.add(remotePathKey(entry.path));
      pathCollisions.push({
        path: entry.path,
        status: 'unsupported',
        remoteId: entry.id,
        conflictReason: 'remotePathCollision',
        message: entry.path === directoryPath
          ? `远端同一路径同时存在文件和目录，无法映射到本地: ${entry.path}`
          : `远端文件与目录路径仅大小写不同，无法映射到本地: ${entry.path} / ${directoryPath}`,
      });
      const directory = directoryMap.get(directoryPath);
      this.output.warn(
        `远端文件与目录路径冲突，已标记为不支持: `
          + `${entry.path}${entry.path === directoryPath ? '' : ` / ${directoryPath}`} `
          + `(${formatMaskedRemoteIds([
            entry.id,
            ...(directory ? [directory.id] : []),
          ])})`,
      );
    }
    const safeEntries = resolvedEntries.filter(entry =>
      !collisionKeys.has(remotePathKey(entry.path)));
    const uniquePathCollisions = new Map<string, SyncChange>();
    for (const collision of pathCollisions) {
      uniquePathCollisions.set(remotePathKey(collision.path), collision);
    }
    return {
      files: new Map(safeEntries.map(item => [item.path, item])),
      directories: directoryMap,
      ambiguousDirectories,
      pathCollisions: [...uniquePathCollisions.values()],
      unsupportedPaths,
      observedFilePaths,
      preloadedFiles,
    };
  }

  private collectFiles(
    nodes: TreeNode[],
    parentPath: string,
    entries: RemoteFileEntry[],
    unsupported: SyncChange[],
  ): void {
    for (const node of nodes) {
      const remotePath = normalizeRemoteNodePath(
        joinRemote(parentPath, node.name),
        '文件',
        unsupported,
      );
      if (!remotePath) {
        continue;
      }
      entries.push({
        id: node.id,
        path: remotePath,
        name: node.name,
        kind: 'text',
      });
    }
  }

  listDirectory(
    api: FileApi,
    directory: RemoteDirectoryEntry,
  ): Promise<ApiResponse<TreePayload>> {
    return directory.kind === 'type'
      ? api.listTree('', directory.id)
      : api.listTree(directory.id);
  }

  async readFile(api: FileApi, entry: RemoteFileEntry): Promise<RemoteFileContent> {
    const response = await api.viewFileDetail(entry.id);
    const detail = requireSuccess(response, `读取远端文件失败: ${entry.path}`);
    if (!isSupportedText(detail.content)) {
      throw new Error('当前版本不支持二进制或非 UTF-8 文件');
    }
    return {
      entry,
      content: detail.content,
      hash: hashText(detail.content),
      formMetadataState: detail.formMetadataState,
      formContexts: detail.formContexts,
      formMetadataWarnings: detail.formMetadataWarnings,
    };
  }

  private throwIfCancelled(cancellation?: CancellationLike): void {
    if (cancellation?.isCancellationRequested) {
      throw new SyncCancelledError();
    }
  }
}

function joinRemote(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function normalizeRemoteNodePath(
  candidate: string,
  kind: '分类' | '目录' | '文件',
  unsupported: SyncChange[],
): string | undefined {
  try {
    return normalizeRemotePath(candidate);
  } catch (error: unknown) {
    unsupported.push({
      path: candidate || '(空名称)',
      status: 'unsupported',
      message: `远端${kind}名称无法安全映射到本地: ${errorMessage(error)}`,
    });
    return undefined;
  }
}

function remoteDirectoryNodeKey(directory: RemoteDirectoryEntry): string {
  return `${directory.kind}:${directory.id}`;
}

function formatMaskedRemoteIds(ids: Iterable<string>): string {
  return [...new Set(ids)]
    .sort()
    .map(maskRemoteId)
    .join(', ');
}

function maskRemoteId(id: string): string {
  if (id.length <= 2) {
    return `${id.slice(0, 1)}***`;
  }
  return `${id.slice(0, 2)}***${id.slice(-2)}`;
}

export function remotePathKey(value: string): string {
  return value.toLocaleLowerCase('en-US');
}

export function isPathAtOrBelow(remotePath: string, directoryPath: string): boolean {
  return remotePath === directoryPath
    || remotePath.startsWith(`${directoryPath}/`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) {
        return;
      }
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
