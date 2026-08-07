import * as path from 'path';
import * as vscode from 'vscode';
import type { SyncChange, SyncChangeStatus } from '../domain/types';

const CHANGE_DECORATIONS: Partial<Record<SyncChangeStatus, {
  badge: string;
  tooltip: string;
  color: string;
}>> = {
  localAdded: {
    badge: 'A',
    tooltip: 'Ecode：本地新增',
    color: 'gitDecoration.addedResourceForeground',
  },
  localModified: {
    badge: 'M',
    tooltip: 'Ecode：本地修改',
    color: 'gitDecoration.modifiedResourceForeground',
  },
  localDeleted: {
    badge: 'D',
    tooltip: 'Ecode：本地删除',
    color: 'gitDecoration.deletedResourceForeground',
  },
  remoteAdded: remoteDecoration('远端新增，等待拉取'),
  remoteModified: remoteDecoration('远端修改，等待拉取'),
  remoteDeleted: remoteDecoration('远端删除，等待拉取'),
  conflict: {
    badge: '!',
    tooltip: 'Ecode：同步冲突',
    color: 'gitDecoration.conflictingResourceForeground',
  },
  unsupported: {
    badge: '!',
    tooltip: 'Ecode：不支持同步',
    color: 'list.warningForeground',
  },
};

export class WorkspaceChangeDecorationProvider implements vscode.FileDecorationProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;

  private sourceRoot: string | undefined;
  private changes = new Map<string, SyncChangeStatus>();

  update(sourceRoot: string | undefined, changes: SyncChange[]): void {
    this.sourceRoot = sourceRoot ? path.resolve(sourceRoot) : undefined;
    this.changes = new Map(changes
      .filter(change => change.status !== 'clean')
      .map(change => [remotePathKey(change.path), change.status]));
    this.changed.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const remotePath = this.remotePath(uri);
    if (!remotePath) {
      return undefined;
    }
    const status = this.changes.get(remotePathKey(remotePath));
    return status ? changeDecoration(status) : undefined;
  }

  dispose(): void {
    this.changed.dispose();
  }

  private remotePath(uri: vscode.Uri): string | undefined {
    if (!this.sourceRoot || uri.scheme !== 'file') {
      return undefined;
    }
    const relative = path.relative(this.sourceRoot, uri.fsPath);
    if (
      !relative
      || relative === '..'
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
    ) {
      return undefined;
    }
    return relative.split(path.sep).join('/');
  }
}

function changeDecoration(status: SyncChangeStatus): vscode.FileDecoration | undefined {
  const decoration = CHANGE_DECORATIONS[status];
  return decoration
    ? {
        badge: decoration.badge,
        tooltip: decoration.tooltip,
        color: new vscode.ThemeColor(decoration.color),
        propagate: true,
      }
    : undefined;
}

function remoteDecoration(tooltip: string): {
  badge: string;
  tooltip: string;
  color: string;
} {
  return { badge: '↓', tooltip: `Ecode：${tooltip}`, color: 'charts.blue' };
}

function remotePathKey(value: string): string {
  return value.toLocaleLowerCase('en-US');
}
