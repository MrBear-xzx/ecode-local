import * as vscode from 'vscode';
import { EcodeSyncService } from '../sync/EcodeSyncService';

export const BASELINE_SCHEME = 'ecode-baseline';
export const REMOTE_SCHEME = 'ecode-remote';
export const EMPTY_SCHEME = 'ecode-empty';

export class VirtualDocumentProvider implements vscode.TextDocumentContentProvider {
  constructor(
    private readonly scheme:
      | typeof BASELINE_SCHEME
      | typeof REMOTE_SCHEME
      | typeof EMPTY_SCHEME,
    private readonly service: EcodeSyncService,
  ) {}

  provideTextDocumentContent(uri: vscode.Uri): Thenable<string> {
    const remotePath = new URLSearchParams(uri.query).get('path') ?? '';
    if (this.scheme === EMPTY_SCHEME) {
      return Promise.resolve('');
    }
    return this.scheme === BASELINE_SCHEME
      ? this.service.getBaselineContent(remotePath)
      : this.service.getLatestRemoteContent(remotePath);
  }
}

export function virtualUri(
  scheme: typeof BASELINE_SCHEME | typeof REMOTE_SCHEME | typeof EMPTY_SCHEME,
  remotePath: string,
): vscode.Uri {
  return vscode.Uri.from({
    scheme,
    path: `/${remotePath}`,
    query: `path=${encodeURIComponent(remotePath)}`,
  });
}
