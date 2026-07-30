import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

export const PROMOTION_DIFF_SCHEME = 'ecode-promotion-diff';

export class PromotionDiffProvider
implements vscode.TextDocumentContentProvider {
  private readonly documents = new Map<string, string>();

  createDiff(
    remotePath: string,
    before: string | undefined,
    after: string | undefined,
  ): { before: vscode.Uri; after: vscode.Uri } {
    const id = randomUUID();
    const beforeUri = this.createUri(id, 'before', remotePath);
    const afterUri = this.createUri(id, 'after', remotePath);
    this.documents.set(beforeUri.toString(), before ?? '');
    this.documents.set(afterUri.toString(), after ?? '');
    return { before: beforeUri, after: afterUri };
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.documents.get(uri.toString()) ?? '';
  }

  private createUri(
    id: string,
    side: 'before' | 'after',
    remotePath: string,
  ): vscode.Uri {
    return vscode.Uri.from({
      scheme: PROMOTION_DIFF_SCHEME,
      authority: id,
      path: `/${remotePath}`,
      query: `side=${side}`,
    });
  }
}
