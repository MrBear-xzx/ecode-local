import * as path from 'path';
import * as vscode from 'vscode';
import { resolveSafeLocalPath } from '../domain/paths';
import type {
  ChangeSet,
  ChangeSetFile,
  DeploymentRecord,
  EnvironmentProfile,
  PushRecord,
  SyncChange,
} from '../domain/types';
import type {
  LifecycleSnapshot,
  PreloadState,
} from '../sync/EcodeLifecycleService';
import { LIFECYCLE_TREE_SCHEME } from './LifecycleTreeDecorationProvider';

interface TreeIcon {
  id: string;
  color?: string;
}

export interface EnvironmentTreeState {
  environment: EnvironmentProfile;
  active: boolean;
  lastSync?: string;
  changes?: SyncChange[];
  pushRecords?: PushRecord[];
  busyMessage?: string;
  lifecycle?: LifecycleSnapshot;
  lifecycleFresh?: boolean;
}

interface LifecycleSourceTreeNode {
  type: 'lifecycleSource';
  kind: 'category' | 'folder' | 'file';
  remotePath: string;
  resourceUri: vscode.Uri;
  localResourceUri: vscode.Uri;
  children: LifecycleSourceTreeNode[];
  rootFolder?: boolean;
  released?: boolean;
  preStateOrder?: string;
  containsReleasedFolder?: boolean;
  containsUnknownReleaseState?: boolean;
  preloadState?: PreloadState;
  canPreload?: boolean;
}

interface SourceDirectoryTreeNode {
  type: 'sourceDirectory';
  directory: string;
  resourceUri: vscode.Uri;
  active: boolean;
  lifecycleLoaded: boolean;
  children: EcodeTreeNode[];
}

type EcodeTreeNode =
  | { type: 'environment'; state: EnvironmentTreeState }
  | SourceDirectoryTreeNode
  | {
      type: 'message';
      label: string;
      description?: string;
      tooltip?: string;
      command?: vscode.Command;
      icon: TreeIcon;
    }
  | {
      type: 'group';
      label: string;
      children: EcodeTreeNode[];
      icon: TreeIcon;
      expanded?: boolean;
    }
  | { type: 'pushRecord'; record: PushRecord }
  | { type: 'pushRecordFile'; record: PushRecord; file: ChangeSetFile }
  | { type: 'changeSet'; changeSet: ChangeSet }
  | { type: 'changeSetFile'; changeSet: ChangeSet; file: ChangeSetFile }
  | LifecycleSourceTreeNode
  | { type: 'change'; change: SyncChange };

export class EcodeTreeProvider implements vscode.TreeDataProvider<EcodeTreeNode> {
  private readonly changed = new vscode.EventEmitter<EcodeTreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private environments: EnvironmentTreeState[] = [];
  private changeSets: ChangeSet[] = [];
  private deployments: DeploymentRecord[] = [];
  private lifecycleRefreshHandler: (() => void) | undefined;
  private lifecycleLoading = false;

  setLifecycleRefreshHandler(handler: () => void): void {
    this.lifecycleRefreshHandler = handler;
  }

  setLifecycleLoading(loading: boolean): void {
    if (this.lifecycleLoading === loading) {
      return;
    }
    this.lifecycleLoading = loading;
    this.changed.fire(undefined);
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  update(
    environments: EnvironmentTreeState[],
    changeSets: ChangeSet[] = [],
    deployments: DeploymentRecord[] = [],
  ): void {
    this.environments = [...environments].sort((left, right) =>
      Number(right.active) - Number(left.active));
    this.changeSets = changeSets;
    this.deployments = deployments;
    this.changed.fire(undefined);
  }

  getTreeItem(element: EcodeTreeNode): vscode.TreeItem {
    if (element.type === 'environment') {
      const { environment, active } = element.state;
      const item = new vscode.TreeItem(
        environment.name,
        active
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = active ? '当前环境' : `${environment.directory}/`;
      item.tooltip = [
        environment.name,
        `源码目录: ${environment.directory}/`,
        `服务器: ${environment.serverUrl}`,
        `登录名: ${environment.username}`,
      ].join('\n');
      item.contextValue = active
        ? 'ecode.environment.active'
        : 'ecode.environment.inactive';
      item.iconPath = themeIcon(
        active ? 'server-environment' : 'server',
        active ? 'charts.green' : undefined,
      );
      return item;
    }

    if (element.type === 'group') {
      const item = new vscode.TreeItem(
        element.label,
        element.expanded === false
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.contextValue = 'ecode.group';
      item.iconPath = themeIcon(element.icon.id, element.icon.color);
      return item;
    }

    if (element.type === 'sourceDirectory') {
      const item = new vscode.TreeItem(
        '源码目录',
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = `${element.directory}/`;
      item.tooltip = element.resourceUri.fsPath;
      item.resourceUri = element.resourceUri;
      item.contextValue = 'ecode.sourceDirectory';
      if (element.active && this.lifecycleLoading) {
        item.iconPath = themeIcon('sync~spin', 'charts.blue');
        item.tooltip = `${element.resourceUri.fsPath}\n正在刷新 Ecode 源码结构与生命周期状态`;
      } else {
        item.iconPath = themeIcon('root-folder');
      }
      return item;
    }

    if (element.type === 'pushRecord') {
      const item = new vscode.TreeItem(
        element.record.name,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = `${new Date(element.record.createdAt).toLocaleString()} · `
        + `${element.record.files.length} 个文件`;
      item.tooltip = `${element.record.name}\n${element.record.id}\n`
        + '展开查看推送文件和具体变更；右侧按钮可重命名或删除记录';
      item.contextValue = 'ecode.pushRecord';
      item.iconPath = element.record.status === 'partial'
        ? themeIcon('warning', 'charts.yellow')
        : themeIcon('cloud-upload', 'charts.green');
      return item;
    }

    if (element.type === 'changeSet') {
      const appliedHere = this.deployments.some(deployment =>
        deployment.changeSetId === element.changeSet.id
        && deployment.targetEnvironmentId === this.activeEnvironmentId()
        && deployment.status === 'succeeded');
      const item = new vscode.TreeItem(
        element.changeSet.name,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = appliedHere
        ? `已应用到当前环境 · ${Object.keys(element.changeSet.files).length} 个文件`
        : `${Object.keys(element.changeSet.files).length} 个文件`;
      item.tooltip = `${element.changeSet.id}\n来源环境：${
        this.environmentName(element.changeSet.sourceEnvironmentId)
      }\n展开查看文件；右侧按钮可应用到当前环境或删除变更集`;
      item.contextValue = 'ecode.changeSet';
      item.iconPath = appliedHere
        ? themeIcon('pass-filled', 'charts.green')
        : themeIcon('git-pull-request', 'charts.blue');
      return item;
    }

    if (
      element.type === 'pushRecordFile'
      || element.type === 'changeSetFile'
    ) {
      const item = new vscode.TreeItem(element.file.path);
      item.description = operationLabel(element.file.operation);
      item.tooltip = `${element.file.path}\n${operationLabel(element.file.operation)}`
        + '\n点击查看推送前后差异';
      item.contextValue = element.type === 'pushRecordFile'
        ? 'ecode.pushRecordFile'
        : 'ecode.changeSetFile';
      const icon = operationIcon(element.file.operation);
      item.iconPath = themeIcon(icon.id, icon.color);
      item.command = {
        command: 'ecode.openPromotionDiff',
        title: '查看推送前后差异',
        arguments: [
          element.type === 'pushRecordFile'
            ? element.record
            : element.changeSet,
          element.file.path,
        ],
      };
      return item;
    }

    if (element.type === 'message') {
      const item = new vscode.TreeItem(element.label);
      item.description = element.description;
      item.tooltip = element.tooltip;
      item.command = element.command;
      item.iconPath = themeIcon(element.icon.id, element.icon.color);
      return item;
    }

    if (element.type === 'lifecycleSource') {
      const collapsible = element.kind === 'file'
        ? vscode.TreeItemCollapsibleState.None
        : element.children.length > 0
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None;
      const item = new vscode.TreeItem(
        path.posix.basename(element.remotePath),
        collapsible,
      );
      item.resourceUri = element.resourceUri;
      item.tooltip = lifecycleSourceTooltip(element);
      if (element.kind === 'category') {
        item.contextValue = 'ecode.lifecycle.category';
        item.iconPath = themeIcon(
          'folder-library',
          element.containsReleasedFolder ? 'charts.blue' : 'disabledForeground',
        );
      } else if (element.kind === 'folder') {
        item.description = element.rootFolder
          ? [releaseStateLabel(element.released), element.preStateOrder]
              .filter(value => value !== undefined)
              .join(' · ')
          : undefined;
        item.contextValue = element.rootFolder
          ? element.released === true
            ? 'ecode.lifecycle.folder.released'
            : element.released === false
              ? 'ecode.lifecycle.folder.unreleased'
              : 'ecode.lifecycle.folder.unknown'
          : 'ecode.lifecycle.folder';
        if (element.rootFolder) {
          item.iconPath = themeIcon(
            'package',
            element.released ? 'charts.green' : 'disabledForeground',
          );
        } else {
          item.iconPath = themeIcon('folder-opened');
        }
      } else {
        item.description = element.preloadState === 'preloaded'
          ? '前置加载'
          : undefined;
        item.contextValue = element.canPreload && element.preloadState === 'preloaded'
          ? 'ecode.lifecycle.file.preloaded'
          : element.canPreload && element.preloadState === 'normal'
            ? 'ecode.lifecycle.file.preloadable'
            : 'ecode.lifecycle.file';
        item.command = {
          command: 'vscode.open',
          title: '打开文件',
          arguments: [element.localResourceUri],
        };
      }
      return item;
    }

    const { change } = element;
    const item = new vscode.TreeItem(change.path);
    item.description = statusLabel(change.status);
    item.tooltip = change.message
      ? `${change.path}\n${change.message}`
      : `${change.path}\n${statusLabel(change.status)}`;
    item.contextValue = change.status === 'conflict'
      ? 'ecode.change.conflict'
      : ['localAdded', 'localModified', 'localDeleted'].includes(change.status)
        ? 'ecode.change.revertible'
        : 'ecode.change';
    const icon = statusIcon(change.status);
    item.iconPath = themeIcon(icon.id, icon.color);
    item.command = {
      command: 'ecode.openDiff',
      title: '查看差异',
      arguments: [change],
    };
    return item;
  }

  getChildren(element?: EcodeTreeNode): EcodeTreeNode[] {
    if (element?.type === 'environment') {
      return this.environmentChildren(element.state);
    }
    if (element?.type === 'group') {
      return element.children;
    }
    if (element?.type === 'sourceDirectory') {
      if (element.active && !element.lifecycleLoaded) {
        this.lifecycleRefreshHandler?.();
      }
      return element.children;
    }
    if (element?.type === 'pushRecord') {
      return element.record.files.map(file => ({
        type: 'pushRecordFile',
        record: element.record,
        file,
      }));
    }
    if (element?.type === 'changeSet') {
      return Object.values(element.changeSet.files)
        .sort((left, right) => left.path.localeCompare(right.path))
        .map(file => ({
          type: 'changeSetFile',
          changeSet: element.changeSet,
          file,
        }));
    }
    if (element?.type === 'lifecycleSource') {
      return element.children;
    }
    if (element) {
      return [];
    }

    if (this.environments.length === 0) {
      return [{
        type: 'message',
        label: '尚未配置 Ecode 环境',
        command: { command: 'ecode.configure', title: '配置环境' },
        icon: { id: 'plug', color: 'charts.yellow' },
      }];
    }

    return [
      ...this.environments.map(state => ({
        type: 'environment' as const,
        state,
      })),
      {
        type: 'group',
        label: '跨环境变更集',
        icon: { id: 'git-pull-request' },
        children: this.promotionChildren(),
      },
    ];
  }

  private environmentChildren(state: EnvironmentTreeState): EcodeTreeNode[] {
    const { environment, active, lastSync, busyMessage } = state;
    const visibleChanges = state.changes?.filter(change => change.status !== 'clean');
    const syncChildren: EcodeTreeNode[] = [
      {
        type: 'message',
        label: '服务器',
        description: environment.serverUrl,
        tooltip: environment.serverUrl,
        icon: { id: 'globe', color: 'charts.blue' },
      },
      {
        type: 'message',
        label: '登录名',
        description: environment.username,
        icon: { id: 'account' },
      },
    ];
    if (lastSync) {
      syncChildren.push({
        type: 'message',
        label: '上次同步',
        description: lastSync,
        icon: { id: 'history', color: 'charts.green' },
      });
    } else {
      syncChildren.push({
        type: 'message',
        label: active ? '当前环境尚未建立同步基线' : '尚未建立同步基线',
        description: active ? '请先执行全量拉取' : '切换后执行全量拉取',
        command: active
          ? { command: 'ecode.pull', title: '全量拉取' }
          : undefined,
        icon: { id: 'cloud-download', color: 'charts.yellow' },
      });
    }
    if (busyMessage) {
      syncChildren.push({
        type: 'message',
        label: busyMessage,
        icon: { id: 'sync~spin', color: 'charts.blue' },
      });
    }

    const changeChildren: EcodeTreeNode[] = active
      ? visibleChanges && visibleChanges.length > 0
        ? visibleChanges.map(change => ({ type: 'change', change }))
        : [{
            type: 'message',
            label: '没有本地变更',
            icon: { id: 'pass-filled', color: 'charts.green' },
          }]
      : [{
          type: 'message',
          label: '切换到此环境后查看变更',
          command: {
            command: 'ecode.switchEnvironment',
            title: '切换环境',
          },
          icon: { id: 'arrow-both' },
        }];

    const pushRecords = state.pushRecords ?? [];
    const pushRecordChildren: EcodeTreeNode[] = pushRecords.length > 0
      ? pushRecords.map(record => ({
          type: 'pushRecord',
          record,
        }))
      : [{
          type: 'message',
          label: '暂无推送记录',
          icon: { id: 'history', color: 'disabledForeground' },
      }];

    const sourceChildren: EcodeTreeNode[] = active
      ? state.lifecycle
        ? buildLifecycleSourceTree(
            state.lifecycle,
            path.resolve(environment.workspaceFolder, environment.directory),
          )
        : [{
            type: 'message',
            label: '读取 Ecode 源码结构',
            command: {
              command: 'ecode.refreshLifecycleDecorations',
              title: '读取 Ecode 源码结构',
            },
            icon: { id: 'refresh', color: 'charts.blue' },
          }]
      : [{
          type: 'message',
          label: '切换到此环境后查看源码结构',
          icon: { id: 'arrow-both' },
        }];

    return [
      {
        type: 'sourceDirectory',
        directory: environment.directory,
        resourceUri: vscode.Uri.file(path.resolve(
          environment.workspaceFolder,
          environment.directory,
        )),
        active,
        lifecycleLoaded: Boolean(state.lifecycle && state.lifecycleFresh),
        children: sourceChildren,
      },
      {
        type: 'group',
        label: '连接与同步',
        icon: { id: 'sync' },
        children: syncChildren,
      },
      {
        type: 'group',
        label: active
          ? `变更 (${visibleChanges?.length ?? 0})`
          : '变更',
        icon: { id: 'source-control' },
        children: changeChildren,
      },
      {
        type: 'group',
        label: `推送记录 (${pushRecords.length})`,
        icon: { id: 'history' },
        children: pushRecordChildren,
        expanded: false,
      },
    ];
  }

  private promotionChildren(): EcodeTreeNode[] {
    return [{
      type: 'message',
      label: '创建变更集',
      command: {
        command: 'ecode.createChangeSet',
        title: '创建变更集',
      },
      icon: { id: 'add', color: 'gitDecoration.addedResourceForeground' },
    }, ...this.changeSets.map(changeSet => ({
      type: 'changeSet' as const,
      changeSet,
    }))];
  }

  private environmentName(id: string): string {
    return this.environments.find(state =>
      state.environment.id === id)?.environment.name ?? id;
  }

  private activeEnvironmentId(): string | undefined {
    return this.environments.find(state => state.active)?.environment.id;
  }
}

function buildLifecycleSourceTree(
  snapshot: LifecycleSnapshot,
  sourceRoot: string,
): LifecycleSourceTreeNode[] {
  const nodes = new Map<string, LifecycleSourceTreeNode>();
  for (const category of snapshot.categories) {
    nodes.set(sourcePathKey(category.path), lifecycleSourceNode(
      'category',
      category.path,
      sourceRoot,
    ));
  }
  for (const folder of snapshot.folders) {
    nodes.set(sourcePathKey(folder.path), {
      ...lifecycleSourceNode('folder', folder.path, sourceRoot),
      rootFolder: folder.rootFolder,
      released: folder.released,
      preStateOrder: folder.preStateOrder,
    });
  }
  for (const file of snapshot.files) {
    nodes.set(sourcePathKey(file.path), {
      ...lifecycleSourceNode('file', file.path, sourceRoot),
      preloadState: file.preloadState,
      canPreload: file.canPreload,
    });
  }

  const roots: LifecycleSourceTreeNode[] = [];
  for (const node of nodes.values()) {
    const parentPath = path.posix.dirname(node.remotePath);
    const parent = parentPath === '.'
      ? undefined
      : nodes.get(sourcePathKey(parentPath));
    if (parent && parent.kind !== 'file') {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  sortLifecycleSourceNodes(roots);
  for (const root of roots) {
    markReleaseDescendants(root);
  }
  return roots;
}

function lifecycleSourceNode(
  kind: LifecycleSourceTreeNode['kind'],
  remotePath: string,
  sourceRoot: string,
): LifecycleSourceTreeNode {
  const localResourceUri = vscode.Uri.file(resolveSafeLocalPath(sourceRoot, remotePath));
  return {
    type: 'lifecycleSource',
    kind,
    remotePath,
    resourceUri: lifecycleTreeUri(localResourceUri, 'native'),
    localResourceUri,
    children: [],
  };
}

function lifecycleTreeUri(
  localResourceUri: vscode.Uri,
  kind: 'category' | 'publishable' | 'preload' | 'native',
  state?: 'active' | 'inactive' | 'unknown' | 'released' | 'unreleased' | 'preloaded',
): vscode.Uri {
  const query = new URLSearchParams({ kind });
  if (state) {
    query.set('state', state);
  }
  return localResourceUri.with({
    scheme: LIFECYCLE_TREE_SCHEME,
    query: query.toString(),
  });
}

function sortLifecycleSourceNodes(nodes: LifecycleSourceTreeNode[]): void {
  nodes.sort((left, right) => {
    const kindOrder = lifecycleKindOrder(left.kind) - lifecycleKindOrder(right.kind);
    return kindOrder || left.remotePath.localeCompare(right.remotePath);
  });
  for (const node of nodes) {
    sortLifecycleSourceNodes(node.children);
  }
}

function lifecycleKindOrder(kind: LifecycleSourceTreeNode['kind']): number {
  return kind === 'category' ? 0 : kind === 'folder' ? 1 : 2;
}

function sourcePathKey(value: string): string {
  return value.toLocaleLowerCase('en-US');
}

function markReleaseDescendants(
  node: LifecycleSourceTreeNode,
): { released: boolean; unknown: boolean } {
  let childReleased = false;
  let childUnknown = false;
  for (const child of node.children) {
    const childState = markReleaseDescendants(child);
    childReleased = childState.released || childReleased;
    childUnknown = childState.unknown || childUnknown;
  }
  const publishable = node.kind === 'folder' && node.rootFolder;
  const released = publishable && node.released === true;
  const unknown = publishable && node.released === undefined;
  node.containsReleasedFolder = childReleased;
  node.containsUnknownReleaseState = childUnknown;
  node.resourceUri = node.kind === 'category'
    ? lifecycleTreeUri(
        node.localResourceUri,
        'category',
        childReleased ? 'active' : childUnknown ? 'unknown' : 'inactive',
      )
    : node.kind === 'folder' && node.rootFolder
      ? lifecycleTreeUri(
          node.localResourceUri,
          'publishable',
          node.released === true
            ? 'released'
            : node.released === false
              ? 'unreleased'
              : 'unknown',
        )
      : node.kind === 'file' && node.preloadState === 'preloaded'
        ? lifecycleTreeUri(node.localResourceUri, 'preload', 'preloaded')
        : lifecycleTreeUri(node.localResourceUri, 'native');
  return {
    released: released || childReleased,
    unknown: unknown || childUnknown,
  };
}

function lifecycleSourceTooltip(node: LifecycleSourceTreeNode): string {
  if (node.kind === 'category') {
    return `${node.remotePath}\nEcode 项目分类\n${
      node.containsReleasedFolder
        ? '包含已发布文件夹'
        : node.containsUnknownReleaseState
          ? '发布状态未完全读取'
          : '不包含已发布文件夹'
    }`;
  }
  if (node.kind === 'folder') {
    if (!node.rootFolder) {
      return `${node.remotePath}\nEcode 内部文件夹`;
    }
    return `${node.remotePath}\n${releaseStateTooltip(node.released)}${
      node.preStateOrder !== undefined
      ? `\n前置加载顺序: ${node.preStateOrder}`
      : ''}`;
  }
  return `${node.remotePath}\n${
    node.preloadState === 'preloaded' ? 'Ecode 前置加载文件' : 'Ecode 源码文件'
  }`;
}

function releaseStateLabel(released: boolean | undefined): string {
  return released === true
    ? '已发布'
    : released === false
      ? '未发布'
      : '发布状态未知';
}

function releaseStateTooltip(released: boolean | undefined): string {
  return released === true
    ? 'Ecode 已发布文件夹'
    : released === false
      ? 'Ecode 可发布文件夹（未发布）'
      : 'Ecode 发布状态未知';
}

function statusLabel(status: SyncChange['status']): string {
  const labels: Record<SyncChange['status'], string> = {
    clean: '已同步',
    localAdded: '本地新增',
    localModified: '本地修改',
    localDeleted: '本地删除（可推送）',
    remoteAdded: '远端新增',
    remoteModified: '远端修改',
    remoteDeleted: '远端删除（待拉取）',
    conflict: '冲突',
    unsupported: '不支持',
  };
  return labels[status];
}

function statusIcon(status: SyncChange['status']): TreeIcon {
  const icons: Record<SyncChange['status'], TreeIcon> = {
    clean: { id: 'check', color: 'gitDecoration.addedResourceForeground' },
    localAdded: { id: 'diff-added', color: 'gitDecoration.addedResourceForeground' },
    localModified: {
      id: 'diff-modified',
      color: 'gitDecoration.modifiedResourceForeground',
    },
    localDeleted: {
      id: 'diff-removed',
      color: 'gitDecoration.deletedResourceForeground',
    },
    remoteAdded: { id: 'cloud-download', color: 'gitDecoration.addedResourceForeground' },
    remoteModified: {
      id: 'cloud-download',
      color: 'gitDecoration.modifiedResourceForeground',
    },
    remoteDeleted: {
      id: 'cloud-download',
      color: 'gitDecoration.deletedResourceForeground',
    },
    conflict: { id: 'warning', color: 'gitDecoration.conflictingResourceForeground' },
    unsupported: { id: 'circle-slash', color: 'disabledForeground' },
  };
  return icons[status];
}

function operationLabel(operation: ChangeSetFile['operation']): string {
  return operation === 'add'
    ? '新增'
    : operation === 'delete' ? '删除' : '修改';
}

function operationIcon(operation: ChangeSetFile['operation']): TreeIcon {
  return operation === 'add'
    ? { id: 'diff-added', color: 'gitDecoration.addedResourceForeground' }
    : operation === 'delete'
      ? { id: 'diff-removed', color: 'gitDecoration.deletedResourceForeground' }
      : { id: 'diff-modified', color: 'gitDecoration.modifiedResourceForeground' };
}

function themeIcon(id: string, color?: string): vscode.ThemeIcon {
  return new vscode.ThemeIcon(
    id,
    color ? new vscode.ThemeColor(color) : undefined,
  );
}
