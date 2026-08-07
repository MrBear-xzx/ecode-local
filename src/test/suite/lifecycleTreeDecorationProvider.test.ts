import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  LIFECYCLE_TREE_SCHEME,
  LifecycleTreeDecorationProvider,
} from '../../ui/LifecycleTreeDecorationProvider';

suite('LifecycleTreeDecorationProvider', () => {
  test('colors lifecycle labels and badges preloaded files without recoloring names', () => {
    const provider = new LifecycleTreeDecorationProvider();

    assert.strictEqual(color(provider, 'category', 'active'), 'charts.blue');
    assert.strictEqual(color(provider, 'category', 'inactive'), 'disabledForeground');
    assert.strictEqual(color(provider, 'category', 'unknown'), 'disabledForeground');
    assert.strictEqual(color(provider, 'publishable', 'released'), 'charts.green');
    assert.strictEqual(color(provider, 'publishable', 'unreleased'), 'disabledForeground');
    assert.strictEqual(color(provider, 'publishable', 'unknown'), 'disabledForeground');
    assert.strictEqual(color(provider, 'preload', 'preloaded'), undefined);
    assert.strictEqual(badge(provider, 'preload', 'preloaded'), 'P');
    assert.strictEqual(color(provider, 'native'), undefined);
    assert.strictEqual(
      provider.provideFileDecoration(vscode.Uri.file('D:\\workspace\\app.js')),
      undefined,
    );
  });
});

function color(
  provider: LifecycleTreeDecorationProvider,
  kind: string,
  state?: string,
): string | undefined {
  const query = new URLSearchParams({ kind });
  if (state) {
    query.set('state', state);
  }
  const decoration = provider.provideFileDecoration(vscode.Uri.from({
    scheme: LIFECYCLE_TREE_SCHEME,
    path: '/D:/workspace/app.js',
    query: query.toString(),
  }));
  return (decoration?.color as vscode.ThemeColor | undefined)?.id;
}

function badge(
  provider: LifecycleTreeDecorationProvider,
  kind: string,
  state?: string,
): string | undefined {
  const query = new URLSearchParams({ kind });
  if (state) {
    query.set('state', state);
  }
  return provider.provideFileDecoration(vscode.Uri.from({
    scheme: LIFECYCLE_TREE_SCHEME,
    path: '/D:/workspace/app.js',
    query: query.toString(),
  }))?.badge;
}
