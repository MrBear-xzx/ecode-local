import * as vscode from 'vscode';
import type { ConnectionProfile, SyncChange } from '../domain/types';

type EcodeTreeNode =
  | { type: 'message'; label: string; description?: string; command?: vscode.Command }
  | { type: 'group'; label: string; children: EcodeTreeNode[] }
  | { type: 'change'; change: SyncChange };

export class EcodeTreeProvider implements vscode.TreeDataProvider<EcodeTreeNode> {
  private readonly changed = new vscode.EventEmitter<EcodeTreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private profile: ConnectionProfile | undefined;
  private changes: SyncChange[] = [];
  private busyMessage: string | undefined;
  private lastSync: string | undefined;

  update(
    profile: ConnectionProfile | undefined,
    changes: SyncChange[],
    busyMessage?: string,
    lastSync?: string,
  ): void {
    this.profile = profile;
    this.changes = changes;
    this.busyMessage = busyMessage;
    this.lastSync = lastSync;
    this.changed.fire(undefined);
  }

  getTreeItem(element: EcodeTreeNode): vscode.TreeItem {
    if (element.type === 'group') {
      const item = new vscode.TreeItem(
        element.label,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.contextValue = 'ecode.group';
      return item;
    }

    if (element.type === 'message') {
      const item = new vscode.TreeItem(element.label);
      item.description = element.description;
      item.command = element.command;
      item.iconPath = new vscode.ThemeIcon(
        element.command?.command === 'ecode.configure' ? 'plug' : 'info',
      );
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
      : ['localAdded', 'localModified'].includes(change.status)
        ? 'ecode.change.pushable'
        : 'ecode.change';
    item.iconPath = new vscode.ThemeIcon(statusIcon(change.status));
    item.command = {
      command: 'ecode.openDiff',
      title: '查看差异',
      arguments: [change],
    };
    return item;
  }

  getChildren(element?: EcodeTreeNode): EcodeTreeNode[] {
    if (element?.type === 'group') {
      return element.children;
    }
    if (element) {
      return [];
    }

    if (!this.profile) {
      return [{
        type: 'message',
        label: '尚未配置 Ecode 连接',
        command: { command: 'ecode.configure', title: '配置连接' },
      }];
    }

    const roots: EcodeTreeNode[] = [
      {
        type: 'group',
        label: '连接',
        children: [
          {
            type: 'message',
            label: this.profile.serverUrl,
            description: this.profile.username,
          },
          {
            type: 'message',
            label: '本地目录',
            description: this.profile.localDirectory,
          },
          {
            type: 'message',
            label: '上次同步',
            description: this.lastSync ?? '尚未同步',
          },
        ],
      },
    ];

    if (this.busyMessage) {
      roots.push({
        type: 'message',
        label: this.busyMessage,
      });
    }

    const visible = this.changes.filter(change => change.status !== 'clean');
    roots.push({
      type: 'group',
      label: `变更 (${visible.length})`,
      children: visible.length > 0
        ? visible.map(change => ({ type: 'change', change }))
        : [{ type: 'message', label: '没有本地变更' }],
    });
    return roots;
  }
}

function statusLabel(status: SyncChange['status']): string {
  const labels: Record<SyncChange['status'], string> = {
    clean: '已同步',
    localAdded: '本地新增',
    localModified: '本地修改',
    localDeleted: '本地删除（未同步）',
    remoteAdded: '远端新增',
    remoteModified: '远端修改',
    remoteDeleted: '远端删除（未同步）',
    conflict: '冲突',
    unsupported: '不支持',
  };
  return labels[status];
}

function statusIcon(status: SyncChange['status']): string {
  const icons: Record<SyncChange['status'], string> = {
    clean: 'check',
    localAdded: 'diff-added',
    localModified: 'diff-modified',
    localDeleted: 'diff-removed',
    remoteAdded: 'cloud-download',
    remoteModified: 'cloud-download',
    remoteDeleted: 'warning',
    conflict: 'warning',
    unsupported: 'circle-slash',
  };
  return icons[status];
}
