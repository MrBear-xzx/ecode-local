import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { assertNoCaseCollisions, normalizeRemotePath } from '../domain/paths';
import { hashText, isSupportedText, textByteSize } from '../domain/text';
import type {
  EcodeAppMetadata,
  RemoteFileContent,
  RemoteFileEntry,
  RemoteTreeNode,
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
  resourceRoots: Set<string>;
  tree: RemoteTreeNode[];
  apps: EcodeAppMetadata[];
  stagingRoot: string;
}

export interface RemoteDirectoryEntry {
  id: string;
  path: string;
  kind: 'type' | 'folder';
  attribute?: string;
  appId?: string;
  treeNode?: RemoteTreeNode;
}

export interface RemoteIndex {
  files: Map<string, RemoteFileEntry>;
  directories: Map<string, RemoteDirectoryEntry>;
  ambiguousDirectories: Set<string>;
  pathCollisions: SyncChange[];
  unsupportedPaths: SyncChange[];
  observedFilePaths: Set<string>;
  preloadedFiles: Map<string, RemoteFileContent>;
  resourceRoots: Set<string>;
  tree: RemoteTreeNode[];
  apps: EcodeAppMetadata[];
}

interface RemoteTreeTask extends RemoteDirectoryEntry {
  sourceNode: TreeNode;
  treeNode: RemoteTreeNode;
}

export class RemoteWorkspaceScanner {
  constructor(private readonly output: vscode.LogOutputChannel) {}

  async scan(
    api: FileApi,
    onProgress: (message: string) => void,
    cancellation?: CancellationLike,
  ): Promise<RemoteScan> {
    const index = await this.listIndex(api, cancellation, onProgress);
    const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ecode-resource-scan-'));
    const entries = index.files;
    const unsupported: SyncChange[] = [
      ...index.pathCollisions,
      ...index.unsupportedPaths,
    ];
    const errors: string[] = [];
    const total = entries.size;
    let completed = 0;
    onProgress(`正在读取远端文件 0/${total}`);
    let contents: Array<RemoteFileContent | undefined>;
    try {
      contents = await mapConcurrent([...entries.values()], 4, async entry => {
        this.throwIfCancelled(cancellation);
        try {
          const preloaded = index.preloadedFiles.get(entry.path);
          return preloaded?.entry.id === entry.id
            ? preloaded
            : await this.readFile(api, entry, stagingRoot);
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
            kind: entry.kind === 'resource' ? 'resource' : 'text',
            remoteId: entry.id,
            message: errorMessage(error),
          });
          return undefined;
        } finally {
          completed++;
          onProgress(`正在读取远端文件 ${completed}/${total}: ${entry.path}`);
        }
      });
    } catch (error: unknown) {
      await this.cleanupStaging(stagingRoot);
      throw error;
    }

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
      resourceRoots: index.resourceRoots,
      tree: index.tree,
      apps: index.apps,
      stagingRoot,
    };
  }

  async cleanupStaging(stagingRoot: string): Promise<void> {
    const resolved = path.resolve(stagingRoot);
    if (!isResourceStagingPath(resolved)) {
      throw new Error(`拒绝清理未知资源暂存目录: ${stagingRoot}`);
    }
    await fs.rm(resolved, { recursive: true, force: true });
  }

  async cleanupExpiredStaging(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
    const tempRoot = path.resolve(os.tmpdir());
    let names: string[];
    try {
      names = await fs.readdir(tempRoot);
    } catch {
      return;
    }
    const cutoff = Date.now() - maxAgeMs;
    await Promise.all(names
      .filter(isResourceStagingName)
      .map(async name => {
        const candidate = path.join(tempRoot, name);
        try {
          const stats = await fs.stat(candidate);
          if (stats.isDirectory() && stats.mtimeMs < cutoff) {
            await this.cleanupStaging(candidate);
          }
        } catch {
          // 激活清理是尽力而为，单个目录失败不影响扩展启动。
        }
      }));
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
    const tree: RemoteTreeNode[] = [];
    const resourceRoots = new Set<string>();
    let pending: RemoteTreeTask[] = [];
    const system = root.system;
    if (system?.id) {
      const remotePath = normalizeRemoteNodePath(system.name, '分类', unsupportedPaths);
      if (remotePath) {
        const treeNode = createRemoteTreeNode(system, remotePath);
        tree.push(treeNode);
        pending.push({
          id: system.id,
          path: remotePath,
          kind: 'type',
          attribute: system.attribute,
          appId: system.appId ?? system.initialAppId,
          sourceNode: system,
          treeNode,
        });
      }
    }
    for (const type of root.typeList) {
      const remotePath = normalizeRemoteNodePath(type.name, '分类', unsupportedPaths);
      if (remotePath) {
        const treeNode = createRemoteTreeNode(type, remotePath);
        tree.push(treeNode);
        pending.push({
          id: type.id,
          path: remotePath,
          kind: 'type',
          attribute: type.attribute,
          appId: type.appId ?? type.initialAppId,
          sourceNode: type,
          treeNode,
        });
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
            || payload.typeList.length > 0
            || payload.resources.length > 0,
        );
        this.collectFiles(
          payload.childFile,
          task.path,
          entries,
          unsupportedPaths,
          'text',
          task.treeNode,
        );
        this.collectFiles(
          payload.resources,
          task.path,
          entries,
          unsupportedPaths,
          'resource',
          task.treeNode,
        );
        if (task.attribute === 'resource' || payload.resources.length > 0) {
          resourceRoots.add(task.path);
        }
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
            const treeNode = createRemoteTreeNode(folder, remotePath);
            task.treeNode.children.push(treeNode);
            childTasks.push({
              id: folder.id,
              path: remotePath,
              kind: 'folder',
              attribute: folder.attribute,
              appId: folder.appId ?? folder.initialAppId,
              sourceNode: folder,
              treeNode,
            });
          }
        }
        for (const type of payload.typeList) {
          const remotePath = normalizeRemoteNodePath(
            joinRemote(task.path, type.name),
            '分类',
            unsupportedPaths,
          );
          if (remotePath) {
            const treeNode = createRemoteTreeNode(type, remotePath);
            task.treeNode.children.push(treeNode);
            childTasks.push({
              id: type.id,
              path: remotePath,
              kind: 'type',
              attribute: type.attribute,
              appId: type.appId ?? type.initialAppId,
              sourceNode: type,
              treeNode,
            });
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

      if (uniqueEntries.some(entry => entry.kind === 'resource')) {
        pathCollisions.push({
          path: remotePath,
          status: 'unsupported',
          kind: 'resource',
          conflictReason: 'remotePathCollision',
          message: `远端资源路径存在多个节点，无法安全选择: ${remotePath}`,
        });
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
      const populated = readable.filter(item =>
        item.content.entry.kind === 'text'
        && 'content' in item.content
        && item.content.content.length > 0);
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
      resourceRoots,
      tree,
      apps: collectAppMetadata(tree, resourceRoots),
    };
  }

  private collectFiles(
    nodes: TreeNode[],
    parentPath: string,
    entries: RemoteFileEntry[],
    unsupported: SyncChange[],
    kind: 'text' | 'resource',
    parentTreeNode: RemoteTreeNode,
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
        kind,
        route: node.route,
        parentId: node.parentId,
      });
      parentTreeNode.children.push(createRemoteTreeNode(node, remotePath));
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

  async readFile(
    api: FileApi,
    entry: RemoteFileEntry,
    stagingRoot?: string,
  ): Promise<RemoteFileContent> {
    if (entry.kind === 'resource') {
      if (!entry.route) {
        throw new Error('远端资源缺少下载地址');
      }
      const ownedStagingRoot = stagingRoot
        ?? await fs.mkdtemp(path.join(os.tmpdir(), 'ecode-resource-single-'));
      const targetPath = path.join(ownedStagingRoot, `${randomUUID()}.bin`);
      try {
        const detail = requireSuccess(
          await api.downloadResource(entry.route, targetPath),
          `读取远端资源失败: ${entry.path}`,
        );
        return {
          entry: { ...entry, kind: 'resource' },
          sourcePath: detail.sourcePath,
          stagingRoot: ownedStagingRoot,
          hash: detail.hash,
          size: detail.size,
          formMetadataState: 'absent',
          formContexts: [],
          formMetadataWarnings: [],
        };
      } catch (error: unknown) {
        if (!stagingRoot) {
          await this.cleanupStaging(ownedStagingRoot);
        }
        throw error;
      }
    }
    const response = await api.viewFileDetail(entry.id);
    const detail = requireSuccess(response, `读取远端文件失败: ${entry.path}`);
    if (!isSupportedText(detail.content)) {
      throw new Error('当前版本不支持二进制或非 UTF-8 文件');
    }
    return {
      entry: { ...entry, kind: 'text' },
      content: detail.content,
      hash: hashText(detail.content),
      size: textByteSize(detail.content),
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

function isResourceStagingName(name: string): boolean {
  return name.startsWith('ecode-resource-scan-')
    || name.startsWith('ecode-resource-single-');
}

function isResourceStagingPath(candidate: string): boolean {
  const relative = path.relative(path.resolve(os.tmpdir()), candidate);
  return Boolean(relative)
    && !path.isAbsolute(relative)
    && !relative.startsWith(`..${path.sep}`)
    && !relative.includes(path.sep)
    && isResourceStagingName(relative);
}

function createRemoteTreeNode(node: TreeNode, remotePath: string): RemoteTreeNode {
  return {
    id: node.id,
    name: node.name,
    path: remotePath,
    treeType: node.treeType,
    businessType: node.businessType,
    attribute: node.attribute,
    parentId: node.parentId,
    appId: node.appId,
    initialAppId: node.initialAppId,
    route: node.route,
    status: node.status,
    state: node.state ?? node.preloadState,
    preStateOrder: node.preStateOrder,
    debugMode: node.debugMode,
    hasChild: node.hasChild,
    children: [],
  };
}

function collectAppMetadata(
  roots: RemoteTreeNode[],
  resourceRoots: ReadonlySet<string>,
): EcodeAppMetadata[] {
  const apps: EcodeAppMetadata[] = [];
  const visit = (node: RemoteTreeNode): void => {
    const appId = node.initialAppId ?? node.appId
      ?? (node.attribute === 'system' ? node.id : undefined);
    if (appId) {
      const descendants = flattenTree(node.children);
      apps.push({
        appId,
        nodeId: node.id,
        path: node.path,
        status: node.attribute === 'system' ? 'released' : node.status ?? '',
        preStateOrder: node.preStateOrder ?? '10000',
        preloadFiles: descendants
          .filter(item => item.state === 'pre-state' || item.attribute === 'system')
          .map(item => item.path)
          .sort(),
        resourceRoots: [...resourceRoots]
          .filter(root => root === node.path || root.startsWith(`${node.path}/`))
          .sort(),
        resources: descendants
          .filter(item => Boolean(item.route))
          .map(item => item.path)
          .sort(),
        configs: descendants
          .filter(item => item.attribute === 'config' || item.attribute === 'non-code')
          .map(item => item.path)
          .sort(),
        debugMode: node.debugMode ?? 'n',
      });
    }
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return apps.sort((left, right) => left.path.localeCompare(right.path));
}

function flattenTree(nodes: RemoteTreeNode[]): RemoteTreeNode[] {
  const result: RemoteTreeNode[] = [];
  const pending = [...nodes];
  while (pending.length > 0) {
    const node = pending.shift()!;
    result.push(node);
    pending.unshift(...node.children);
  }
  return result;
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
