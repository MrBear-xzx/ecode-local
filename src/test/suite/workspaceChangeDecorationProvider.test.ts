import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SyncChange } from '../../domain/types';
import { WorkspaceChangeDecorationProvider } from '../../ui/WorkspaceChangeDecorationProvider';

const SOURCE_ROOT = path.resolve('D:\\workspace\\ecode-decoration-test');

suite('WorkspaceChangeDecorationProvider', () => {
  test('decorates only recorded changes inside the active Ecode source root', () => {
    const provider = new WorkspaceChangeDecorationProvider();
    provider.update(SOURCE_ROOT, [
      change('Type/added.js', 'localAdded'),
      change('Type/modified.json', 'localModified'),
      change('Type/remote.css', 'remoteModified'),
      change('Type/conflict.js', 'conflict'),
      change('Type/clean.js', 'clean'),
    ]);

    assertDecoration(provider, 'Type/added.js', 'A', 'gitDecoration.addedResourceForeground');
    assertDecoration(
      provider,
      'Type/modified.json',
      'M',
      'gitDecoration.modifiedResourceForeground',
    );
    assertDecoration(provider, 'Type/remote.css', '↓', 'charts.blue');
    assertDecoration(
      provider,
      'Type/conflict.js',
      '!',
      'gitDecoration.conflictingResourceForeground',
    );
    assert.strictEqual(decoration(provider, 'Type/clean.js'), undefined);
    assert.strictEqual(decoration(provider, 'Type/untracked.js'), undefined);
    assert.strictEqual(
      provider.provideFileDecoration(vscode.Uri.file(path.join(SOURCE_ROOT, '..', 'outside.js'))),
      undefined,
    );
    provider.dispose();
  });

  test('replaces stale decorations when the change list is refreshed', () => {
    const provider = new WorkspaceChangeDecorationProvider();
    provider.update(SOURCE_ROOT, [change('Type/app.js', 'localModified')]);
    assert.strictEqual(decoration(provider, 'Type/app.js')?.badge, 'M');

    provider.update(SOURCE_ROOT, []);

    assert.strictEqual(decoration(provider, 'Type/app.js'), undefined);
    provider.dispose();
  });
});

function change(pathValue: string, status: SyncChange['status']): SyncChange {
  return { path: pathValue, status };
}

function decoration(
  provider: WorkspaceChangeDecorationProvider,
  remotePath: string,
): vscode.FileDecoration | undefined {
  return provider.provideFileDecoration(vscode.Uri.file(path.join(
    SOURCE_ROOT,
    ...remotePath.split('/'),
  )));
}

function assertDecoration(
  provider: WorkspaceChangeDecorationProvider,
  remotePath: string,
  badge: string,
  color: string,
): void {
  const value = decoration(provider, remotePath);
  assert.strictEqual(value?.badge, badge);
  assert.strictEqual((value?.color as vscode.ThemeColor | undefined)?.id, color);
  assert.strictEqual(value?.propagate, true);
}
