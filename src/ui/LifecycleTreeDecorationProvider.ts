import * as vscode from 'vscode';

export const LIFECYCLE_TREE_SCHEME = 'ecode-lifecycle-tree';

export class LifecycleTreeDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== LIFECYCLE_TREE_SCHEME) {
      return undefined;
    }
    const parameters = new URLSearchParams(uri.query);
    const kind = parameters.get('kind');
    const state = parameters.get('state');
    if (kind === 'preload' && state === 'preloaded') {
      return {
        badge: 'P',
        tooltip: 'Ecode 已前置加载',
        propagate: false,
      };
    }
    const color = kind === 'category'
      ? state === 'active' ? 'charts.blue' : 'disabledForeground'
      : kind === 'publishable'
        ? state === 'released' ? 'charts.green' : 'disabledForeground'
        : undefined;
    return color
      ? {
          color: new vscode.ThemeColor(color),
          propagate: false,
        }
      : undefined;
  }
}
