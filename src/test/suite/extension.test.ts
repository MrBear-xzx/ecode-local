import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Ecode Extension Test Suite', () => {
  vscode.window.showInformationMessage('Starting Ecode tests.');

  test('Extension should be present', () => {
    const ext = vscode.extensions.getExtension('ecode-local.ecode-vscode');
    assert.ok(ext);
  });

  test('Extension should activate', async () => {
    const ext = vscode.extensions.getExtension('ecode-local.ecode-vscode');
    if (ext && !ext.isActive) {
      await ext.activate();
    }
    assert.ok(ext?.isActive);
  });

  test('Ecode commands should be registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('ecode.setup'));
    assert.ok(commands.includes('ecode.menuPull'));
    assert.ok(commands.includes('ecode.menuPush'));
    assert.ok(commands.includes('ecode.branchNew'));
  });
});
