import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

export const PROMOTION_DIFF_SCHEME = 'ecode-promotion-diff';

export class PromotionDiffProvider
implements vscode.TextDocumentContentProvider {
  private readonly documents = new Map<string, string>();
  private readonly diffKeys: string[][] = [];

  constructor(private readonly maxDiffs = 20) {
    if (!Number.isInteger(maxDiffs) || maxDiffs < 1) {
      throw new Error('差异文档保留数量必须是正整数');
    }
  }

  createDiff(
    remotePath: string,
    before: string | undefined,
    after: string | undefined,
  ): { before: vscode.Uri; after: vscode.Uri } {
    const id = randomUUID();
    const beforeUri = this.createUri(id, 'before', remotePath);
    const afterUri = this.createUri(id, 'after', remotePath);
    const keys = [beforeUri.toString(), afterUri.toString()];
    this.documents.set(keys[0], before ?? '');
    this.documents.set(keys[1], after ?? '');
    this.diffKeys.push(keys);
    while (this.diffKeys.length > this.maxDiffs) {
      for (const key of this.diffKeys.shift() ?? []) {
        this.documents.delete(key);
      }
    }
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
