import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  countChanges,
  isPushableChange,
  lifecycleMutationInvocationResult,
  switchEnvironmentCandidates,
  validateEnvironmentDirectoryInput,
  validateEnvironmentName,
  visibleAiChanges,
} from '../../extension';
import type { EnvironmentProfile, SyncChange } from '../../domain/types';

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

  test('does not create Ecode files in an unconfigured workspace', () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceFolder);
    assert.strictEqual(
      fs.existsSync(path.join(workspaceFolder, '.ecode-local')),
      false,
    );
    assert.strictEqual(fs.existsSync(path.join(workspaceFolder, 'AGENTS.md')), false);
  });

  test('Ecode commands should be registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('ecode.setup'));
    assert.ok(commands.includes('ecode.configure'));
    assert.ok(commands.includes('ecode.addEnvironment'));
    assert.ok(commands.includes('ecode.switchEnvironment'));
    assert.ok(commands.includes('ecode.deleteEnvironment'));
    assert.ok(commands.includes('ecode.pull'));
    assert.ok(commands.includes('ecode.refreshChanges'));
    assert.ok(commands.includes('ecode.pushSelected'));
    assert.ok(!commands.includes('ecode.managePreload'));
    assert.ok(!commands.includes('ecode.manageRelease'));
    assert.ok(commands.includes('ecode.setResourcePreloadOrder'));
    assert.ok(commands.includes('ecode.publishResourceFolder'));
    assert.ok(commands.includes('ecode.unpublishResourceFolder'));
    assert.ok(commands.includes('ecode.enableResourcePreload'));
    assert.ok(commands.includes('ecode.disableResourcePreload'));
    assert.ok(commands.includes('ecode.refreshLifecycleDecorations'));
    assert.ok(commands.includes('ecode.renamePushRecord'));
    assert.ok(commands.includes('ecode.deletePushRecord'));
    assert.ok(commands.includes('ecode.deleteLifecycleRecord'));
    assert.ok(commands.includes('ecode.deleteLifecycleRecords'));
    assert.ok(commands.includes('ecode.rollbackPushFile'));
    assert.ok(commands.includes('ecode.openPromotionDiff'));
    assert.ok(commands.includes('ecode.openDiff'));
    assert.ok(commands.includes('ecode.revertChange'));
    assert.ok(commands.includes('ecode.resolveConflict'));
    assert.ok(commands.includes('ecode.createChangeSet'));
    assert.ok(commands.includes('ecode.applyChangeSet'));
    assert.ok(commands.includes('ecode.deleteChangeSet'));
    assert.ok(!commands.includes('ecode.cancelChangeSet'));
    assert.ok(!commands.includes('ecode.freezeRelease'));
    assert.ok(!commands.includes('ecode.abandonChangeSet'));
    assert.ok(!commands.includes('ecode.deployRelease'));
    assert.ok(commands.includes('ecode.searchApiDocumentation'));
    assert.ok(commands.includes('ecode.openOnlineDocumentation'));
    assert.ok(commands.includes('ecode.refreshAiSupport'));
    assert.ok(commands.includes('ecode.enableAiSupport'));
    assert.ok(commands.includes('ecode.openAiGuide'));
    assert.ok(commands.includes('ecode.removeAiSupport'));
    assert.ok(!commands.includes('ecode.ai.inspect'));
    assert.ok(!commands.includes('ecode.ai.execute'));
    assert.ok(!commands.includes('ecode.confirmSourceDirectoryMigration'));
    assert.ok(!commands.includes('ecode.branchNew'));
  });

  test('allows an already applied conflict to be confirmed as a push', () => {
    const converged: SyncChange = {
      path: 'Type/applied.js',
      status: 'conflict',
      localHash: 'same',
      remoteHash: 'same',
      conflictReason: 'bothModified',
    };
    const divergent: SyncChange = {
      ...converged,
      remoteHash: 'different',
    };

    assert.strictEqual(isPushableChange(converged), true);
    assert.strictEqual(isPushableChange(divergent), false);
  });

  test('omits clean pull entries from Agent state while retaining counts', () => {
    const changes: SyncChange[] = Array.from({ length: 20_000 }, (_, index) => ({
      path: `Type/clean-${index}.js`,
      status: 'clean',
    }));
    changes.push({
      path: 'Type/conflict.js',
      status: 'conflict',
      conflictReason: 'bothModified',
    });

    assert.deepStrictEqual(visibleAiChanges(changes), [changes[changes.length - 1]]);
    assert.deepStrictEqual(countChanges(changes), {
      total: 20_001,
      clean: 20_000,
      conflict: 1,
    });
    assert.ok(Buffer.byteLength(JSON.stringify({
      changeCounts: countChanges(changes),
      changes: visibleAiChanges(changes),
    })) < 1024 * 1024);
  });

  test('reports an uncertain lifecycle mutation instead of succeeding without data', () => {
    assert.deepStrictEqual(
      lifecycleMutationInvocationResult('设置前置加载顺序', undefined),
      {
        status: 'failed',
        message: '设置前置加载顺序未完成，远端状态可能不确定，请重新查询生命周期状态确认',
      },
    );
    assert.deepStrictEqual(
      lifecycleMutationInvocationResult('设置前置加载顺序', {
        changed: false,
        verified: true,
      }),
      {
        status: 'succeeded',
        data: { changed: false, verified: true },
      },
    );
  });

  test('environment name validation rejects duplicates while typing', () => {
    const environments: EnvironmentProfile[] = [{
      version: 2,
      id: 'test',
      name: '测试环境',
      directory: 'test_env',
      workspaceFolder: 'D:\\workspace\\project',
      serverUrl: 'https://test.example.com',
      username: 'tester',
    }];

    assert.match(
      validateEnvironmentName(
        ' 测试环境 ',
        environments,
        'd:\\workspace\\project',
      ) ?? '',
      /已存在/,
    );
    assert.strictEqual(
      validateEnvironmentName(
        '测试环境',
        environments,
        'D:\\workspace\\project',
        'test',
      ),
      undefined,
    );
  });

  test('environment directory validation rejects invalid and duplicate values while typing', () => {
    const environments: EnvironmentProfile[] = [{
      version: 2,
      id: 'dev',
      name: '开发环境',
      directory: 'dev_env',
      workspaceFolder: 'D:\\workspace\\project',
      serverUrl: 'https://dev.example.com',
      username: 'developer',
    }];

    assert.strictEqual(
      validateEnvironmentDirectoryInput('dev2', environments),
      undefined,
    );
    assert.match(
      validateEnvironmentDirectoryInput('开发环境', environments) ?? '',
      /只能包含/,
    );
    assert.match(
      validateEnvironmentDirectoryInput('DEV_ENV', environments) ?? '',
      /已由环境/,
    );
    assert.strictEqual(
      validateEnvironmentDirectoryInput('dev_env', environments, environments[0]),
      undefined,
    );
  });

  test('switch environment falls back to add when no alternative exists', () => {
    const current: EnvironmentProfile = {
      version: 2,
      id: 'current',
      name: '当前环境',
      directory: 'current_env',
      workspaceFolder: 'D:\\workspace\\project',
      serverUrl: 'https://current.example.com',
      username: 'current',
    };
    const other: EnvironmentProfile = {
      ...current,
      id: 'other',
      name: '其他环境',
      directory: 'other_env',
    };

    assert.deepStrictEqual(switchEnvironmentCandidates(undefined, []), []);
    assert.deepStrictEqual(switchEnvironmentCandidates(current.id, [current]), []);
    assert.deepStrictEqual(
      switchEnvironmentCandidates(current.id, [current, other]),
      [other],
    );
  });

  test('Ecode view title keeps only primary sync actions visible', () => {
    const ext = vscode.extensions.getExtension('ecode-local.ecode-vscode');
    const menus = ext?.packageJSON.contributes?.menus?.['view/title'] as
      | Array<{ command: string; group?: string }>
      | undefined;
    assert.ok(menus);
    const visible = menus
      .filter(item => item.group?.startsWith('navigation'))
      .map(item => item.command);
    const overflow = menus
      .filter(item => !item.group?.startsWith('navigation'))
      .map(item => item.command);

    assert.deepStrictEqual(visible, [
      'ecode.pull',
      'ecode.refreshChanges',
      'ecode.pushSelected',
    ]);
    assert.ok(overflow.includes('ecode.configure'));
    assert.ok(overflow.includes('ecode.addEnvironment'));
    assert.ok(overflow.includes('ecode.switchEnvironment'));
    assert.ok(overflow.includes('ecode.enableAiSupport'));
    assert.ok(overflow.includes('ecode.createChangeSet'));
    assert.ok(overflow.includes('ecode.applyChangeSet'));
    assert.ok(overflow.includes('ecode.searchApiDocumentation'));
    assert.ok(overflow.includes('ecode.openOnlineDocumentation'));
    assert.ok(overflow.includes('ecode.openAiGuide'));
    assert.ok(!overflow.includes('ecode.refreshAiSupport'));
    assert.ok(overflow.includes('ecode.removeAiSupport'));
  });

  test('Ecode Explorer menu does not expose lifecycle actions', () => {
    const ext = vscode.extensions.getExtension('ecode-local.ecode-vscode');
    const menus = ext?.packageJSON.contributes?.menus?.['explorer/context'];
    assert.strictEqual(menus, undefined);
  });

  test('Ecode command palette hides commands that require a tree or file argument', () => {
    const ext = vscode.extensions.getExtension('ecode-local.ecode-vscode');
    const menus = ext?.packageJSON.contributes?.menus?.commandPalette as
      | Array<{ command: string; when?: string }>
      | undefined;
    assert.ok(menus);
    const hidden = new Map(menus.map(item => [item.command, item.when]));
    for (const command of [
      'ecode.openDiff',
      'ecode.deleteLifecycleRecord',
      'ecode.publishResourceFolder',
      'ecode.unpublishResourceFolder',
      'ecode.setResourcePreloadOrder',
      'ecode.enableResourcePreload',
      'ecode.disableResourcePreload',
    ]) {
      assert.strictEqual(hidden.get(command), 'false');
    }
  });

  test('Ecode source tree exposes only state-appropriate lifecycle actions', () => {
    const ext = vscode.extensions.getExtension('ecode-local.ecode-vscode');
    const menus = ext?.packageJSON.contributes?.menus?.['view/item/context'] as
      | Array<{ command: string; when?: string }>
      | undefined;
    assert.ok(menus);
    const lifecycleMenus = menus.filter(item =>
      item.when?.includes('ecode.lifecycle.'));

    assert.deepStrictEqual(
      lifecycleMenus.map(item => [item.command, item.when]),
      [
        [
          'ecode.publishResourceFolder',
          'view == ecode.workspace && viewItem == ecode.lifecycle.folder.unreleased',
        ],
        [
          'ecode.unpublishResourceFolder',
          'view == ecode.workspace && viewItem == ecode.lifecycle.folder.released',
        ],
        [
          'ecode.setResourcePreloadOrder',
          'view == ecode.workspace && viewItem == ecode.lifecycle.folder.released',
        ],
        [
          'ecode.setResourcePreloadOrder',
          'view == ecode.workspace && viewItem == ecode.lifecycle.folder.unreleased',
        ],
        [
          'ecode.setResourcePreloadOrder',
          'view == ecode.workspace && viewItem == ecode.lifecycle.folder.unknown',
        ],
        [
          'ecode.enableResourcePreload',
          'view == ecode.workspace && viewItem == ecode.lifecycle.file.preloadable',
        ],
        [
          'ecode.disableResourcePreload',
          'view == ecode.workspace && viewItem == ecode.lifecycle.file.preloaded',
        ],
      ],
    );
    assert.strictEqual(
      menus.find(item => item.command === 'ecode.deleteLifecycleRecords')?.when,
      'view == ecode.workspace && viewItem == ecode.lifecycleRecordsGroup.active',
    );
  });

  test('Ecode language intelligence provides completion, hover, and definition', async () => {
    const ext = vscode.extensions.getExtension('ecode-local.ecode-vscode');
    if (ext && !ext.isActive) {
      await ext.activate();
    }
    const document = await vscode.workspace.openTextDocument({
      language: 'javascript',
      content: [
        'const value = WfForm.getFieldValue("field110");',
        'WfForm.',
        'WfForm.changeFieldValue("field110", ',
      ].join('\n'),
    });
    const completionPosition = new vscode.Position(1, 'WfForm.'.length);
    const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      document.uri,
      completionPosition,
      '.',
    );
    const labels = completions.items.map(item =>
      typeof item.label === 'string' ? item.label : item.label.label);
    assert.ok(labels.includes('getFieldValue'));

    const methodPosition = new vscode.Position(0, 'const value = WfForm.getF'.length);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      methodPosition,
    );
    assert.ok(hovers.length > 0);

    const definitions = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
      'vscode.executeDefinitionProvider',
      document.uri,
      methodPosition,
    );
    assert.ok(definitions.length > 0);
    const target = definitions[0] instanceof vscode.Location
      ? definitions[0].uri
      : definitions[0].targetUri;
    assert.strictEqual(target.scheme, 'ecode-doc');

    const objectPosition = new vscode.Position(0, 'const value = Wf'.length);
    const objectHovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      objectPosition,
    );
    assert.ok(objectHovers.length > 0);
    assert.match(
      objectHovers.flatMap(hover => hover.contents)
        .map(content => typeof content === 'string' ? content : content.value)
        .join('\n'),
      /流程表单前端 API/,
    );

    const objectDefinitions =
      await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
        'vscode.executeDefinitionProvider',
        document.uri,
        objectPosition,
      );
    assert.ok(objectDefinitions.length > 0);
    const objectTarget = objectDefinitions[0] instanceof vscode.Location
      ? objectDefinitions[0].uri
      : objectDefinitions[0].targetUri;
    assert.strictEqual(objectTarget.toString(), 'ecode-doc:/WfForm/index.md');

    const objectDocument = await vscode.workspace.openTextDocument(objectTarget);
    assert.match(objectDocument.getText(), /^# WfForm/m);
    assert.match(objectDocument.getText(), /convertFieldNameToId/);
    assert.match(objectDocument.getText(), /## 属性与常量/);

    const signaturePosition = new vscode.Position(
      2,
      'WfForm.changeFieldValue("field110", '.length,
    );
    const signatureHelp = await vscode.commands.executeCommand<vscode.SignatureHelp>(
      'vscode.executeSignatureHelpProvider',
      document.uri,
      signaturePosition,
      ',',
    );
    assert.strictEqual(signatureHelp?.activeParameter, 1);
    assert.match(
      String(signatureHelp?.signatures[0].parameters[1].documentation),
      /specialobj/,
    );

    const apiDocument = await vscode.workspace.openTextDocument(
      vscode.Uri.parse('ecode-doc:/WfForm/changeFieldValue.md'),
    );
    assert.match(apiDocument.getText(), /\| `valueInfo` \| `object` \| 是 \|/);
    assert.match(apiDocument.getText(), /specialobj/);
  });

  test('setCom and getCom support workspace completion, definition, and references', async () => {
    const ext = vscode.extensions.getExtension('ecode-local.ecode-vscode');
    if (ext && !ext.isActive) {
      await ext.activate();
    }
    const registration = await vscode.workspace.openTextDocument({
      language: 'javascript',
      content: [
        'const CrossFileWidget = () => null;',
        'ecodeSDK.setCom("app-cross-file-test", "CrossFileWidget", CrossFileWidget);',
      ].join('\n'),
    });
    const usage = await vscode.workspace.openTextDocument({
      language: 'javascript',
      content: [
        'const Widget = ecodeSDK.getCom("app-cross-file-test", "CrossFileWidget");',
        'const Partial = ecodeSDK.getCom("app-cross-file-test", "Cross',
      ].join('\n'),
    });

    const completionPosition = new vscode.Position(
      1,
      'const Partial = ecodeSDK.getCom("app-cross-file-test", "Cross'.length,
    );
    const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      usage.uri,
      completionPosition,
      '"',
    );
    const labels = completions.items.map(item =>
      typeof item.label === 'string' ? item.label : item.label.label);
    assert.ok(labels.includes('CrossFileWidget'));

    const usagePosition = new vscode.Position(
      0,
      'const Widget = ecodeSDK.getCom("app-cross-file-test", "Cross'.length,
    );
    const definitions =
      await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
        'vscode.executeDefinitionProvider',
        usage.uri,
        usagePosition,
      );
    assert.ok(definitions.length > 0);
    const definitionUri = definitions[0] instanceof vscode.Location
      ? definitions[0].uri
      : definitions[0].targetUri;
    assert.strictEqual(definitionUri.toString(), registration.uri.toString());

    const references = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeReferenceProvider',
      usage.uri,
      usagePosition,
    );
    assert.ok(references.some(location =>
      location.uri.toString() === registration.uri.toString()));
    assert.ok(references.some(location =>
      location.uri.toString() === usage.uri.toString()));

    const incrementalEdit = new vscode.WorkspaceEdit();
    const registrationNameOffset = registration.lineAt(1).text
      .indexOf('CrossFileWidget');
    incrementalEdit.replace(
      registration.uri,
      new vscode.Range(
        1,
        registrationNameOffset,
        1,
        registrationNameOffset + 'CrossFileWidget'.length,
      ),
      'IncrementalWidget',
    );
    const usageNameOffset = usage.lineAt(0).text.indexOf('CrossFileWidget');
    incrementalEdit.replace(
      usage.uri,
      new vscode.Range(
        0,
        usageNameOffset,
        0,
        usageNameOffset + 'CrossFileWidget'.length,
      ),
      'IncrementalWidget',
    );
    assert.strictEqual(await vscode.workspace.applyEdit(incrementalEdit), true);

    const updatedDefinitions =
      await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
        'vscode.executeDefinitionProvider',
        usage.uri,
        new vscode.Position(0, usageNameOffset + 'Incremental'.length),
      );
    assert.ok(updatedDefinitions.length > 0);
    const updatedDefinitionUri = updatedDefinitions[0] instanceof vscode.Location
      ? updatedDefinitions[0].uri
      : updatedDefinitions[0].targetUri;
    assert.strictEqual(updatedDefinitionUri.toString(), registration.uri.toString());
  });

  test('PC component intelligence provides components, props, hover, and docs', async () => {
    const ext = vscode.extensions.getExtension('ecode-local.ecode-vscode');
    if (ext && !ext.isActive) {
      await ext.activate();
    }
    const document = await vscode.workspace.openTextDocument({
      language: 'javascriptreact',
      content: [
        'import { WeaInput } from "ecCom";',
        'const DirectInput = ecCom.WeaInput;',
        'ecCom.',
        '<WeaInput ',
        'const { WeaBrowser } = window.ecCom;',
        '<WeaBrowser tabs={[{ key: "1", na',
        '<window.ecCom.WeaTable columns={[{ title: "名称", data',
        'WfForm.changeFieldValue("field110", { value: "1", spe',
        'window.ecodeSDK.load({ id: "appId", no',
        'window.ecCom.',
      ].join('\n'),
    });

    const componentPosition = new vscode.Position(2, 'ecCom.'.length);
    const components = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      document.uri,
      componentPosition,
      '.',
    );
    const componentLabels = components.items.map(item =>
      typeof item.label === 'string' ? item.label : item.label.label);
    assert.ok(componentLabels.includes('WeaInput'));
    assert.ok(componentLabels.includes('WeaTable'));

    const propPosition = new vscode.Position(3, '<WeaInput '.length);
    const props = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      document.uri,
      propPosition,
      ' ',
    );
    const propLabels = props.items.map(item =>
      typeof item.label === 'string' ? item.label : item.label.label);
    assert.ok(propLabels.includes('value'));
    assert.ok(propLabels.includes('viewAttr'));
    assert.ok(propLabels.includes('onChange'));

    const browserTabPosition = new vscode.Position(
      5,
      '<WeaBrowser tabs={[{ key: "1", na'.length,
    );
    const browserTabProps = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      document.uri,
      browserTabPosition,
    );
    const browserTabLabels = browserTabProps.items.map(item =>
      typeof item.label === 'string' ? item.label : item.label.label);
    assert.ok(browserTabLabels.includes('name'));

    const tableColumnPosition = new vscode.Position(
      6,
      '<window.ecCom.WeaTable columns={[{ title: "名称", data'.length,
    );
    const tableColumnProps = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      document.uri,
      tableColumnPosition,
    );
    const tableColumnLabels = tableColumnProps.items.map(item =>
      typeof item.label === 'string' ? item.label : item.label.label);
    assert.ok(tableColumnLabels.includes('dataIndex'));

    const wfNestedPosition = new vscode.Position(
      7,
      'WfForm.changeFieldValue("field110", { value: "1", spe'.length,
    );
    const wfNestedProps = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      document.uri,
      wfNestedPosition,
    );
    const wfNestedLabels = wfNestedProps.items.map(item =>
      typeof item.label === 'string' ? item.label : item.label.label);
    assert.ok(wfNestedLabels.includes('specialobj'));

    const sdkNestedPosition = new vscode.Position(
      8,
      'window.ecodeSDK.load({ id: "appId", no'.length,
    );
    const sdkNestedProps = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      document.uri,
      sdkNestedPosition,
    );
    const sdkNestedLabels = sdkNestedProps.items.map(item =>
      typeof item.label === 'string' ? item.label : item.label.label);
    assert.ok(sdkNestedLabels.includes('noCss'));

    const windowComponentPosition = new vscode.Position(
      9,
      'window.ecCom.'.length,
    );
    const windowComponents = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      document.uri,
      windowComponentPosition,
      '.',
    );
    const windowComponentLabels = windowComponents.items.map(item =>
      typeof item.label === 'string' ? item.label : item.label.label);
    assert.ok(windowComponentLabels.includes('WeaBrowser'));

    const componentWordPosition = new vscode.Position(
      1,
      'const DirectInput = ecCom.Wea'.length,
    );
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      componentWordPosition,
    );
    assert.ok(hovers.length > 0);

    const definitions = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
      'vscode.executeDefinitionProvider',
      document.uri,
      componentWordPosition,
    );
    assert.ok(definitions.length > 0);
    const target = definitions[0] instanceof vscode.Location
      ? definitions[0].uri
      : definitions[0].targetUri;
    assert.strictEqual(target.scheme, 'ecode-doc');
    assert.match(target.path, /component\/ecCom\/WeaInput/);

    const componentDocument = await vscode.workspace.openTextDocument(
      vscode.Uri.parse('ecode-doc:/component/ecCom/WeaInput.md'),
    );
    assert.match(componentDocument.getText(), /Props 参数说明/);
    assert.match(componentDocument.getText(), /\| `viewAttr` \|/);
    assert.match(componentDocument.getText(), /泛微 PC 组件库/);

    const browserDocument = await vscode.workspace.openTextDocument(
      vscode.Uri.parse('ecode-doc:/component/ecCom/WeaBrowser.md'),
    );
    assert.match(browserDocument.getText(), /`tabs` 二级参数/);
    assert.match(browserDocument.getText(), /\| `browserProps` \|/);

    const nestedApiDocument = await vscode.workspace.openTextDocument(
      vscode.Uri.parse('ecode-doc:/WfForm/changeFieldValue.md'),
    );
    assert.match(nestedApiDocument.getText(), /`valueInfo` 二级参数/);
    assert.match(nestedApiDocument.getText(), /\| `specialobj` \|/);
  });
});
