import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import * as vscode from 'vscode';
import { parseAiRequest, parseAiInvocation } from '../../ai/AiRequest';
import { AiRequestController } from '../../ai/AiRequestController';
import {
  generateComponentDeclarations,
  generateGlobalDeclarations,
  generateWorkspaceComponents,
  generateWorkspaceFormMetadata,
  normalizeType,
} from '../../ai/AiSupportGenerator';
import {
  AiSupportService,
  removeManagedAgentsContent,
  updateManagedAgentsContent,
} from '../../ai/AiSupportService';
import {
  WorkspaceComponentRegistry,
  type IndexedEcodeComponentCall,
} from '../../language/WorkspaceComponentRegistry';

suite('AI coding support', () => {
  test('normalizes documented types conservatively', () => {
    assert.strictEqual(normalizeType('bool'), 'boolean');
    assert.strictEqual(normalizeType('String'), 'string');
    assert.strictEqual(normalizeType('集合'), 'unknown[]');
    assert.strictEqual(
      normalizeType('function(value, record)'),
      '(value: unknown, record: unknown) => unknown',
    );
    assert.strictEqual(normalizeType('React.Element or String'), 'unknown');
    assert.strictEqual(normalizeType('unrecognized platform value'), 'unknown');
  });

  test('generates parseable declarations with parameter and nested documentation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-ai-types-'));
    try {
      const globals = generateGlobalDeclarations();
      const components = generateComponentDeclarations();
      fs.writeFileSync(path.join(root, 'globals.d.ts'), globals, 'utf8');
      fs.writeFileSync(path.join(root, 'components.d.ts'), components, 'utf8');
      const program = ts.createProgram(
        [path.join(root, 'globals.d.ts'), path.join(root, 'components.d.ts')],
        {
          noEmit: true,
          skipLibCheck: true,
          target: ts.ScriptTarget.ES2022,
        },
      );
      const diagnostics = ts.getPreEmitDiagnostics(program);

      assert.deepStrictEqual(
        diagnostics.map(diagnostic =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
        [],
      );
      assert.match(globals, /interface WfFormApi/);
      assert.match(globals, /@param valueInfo/);
      assert.match(globals, /interface WfFormChangeFieldValueValueInfo/);
      assert.match(components, /interface EcComWeaBrowserPropsTabsItem/);
      assert.match(components, /interface EcComWeaTablePropsColumnsItem/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('updates only the managed AGENTS block and rejects malformed markers', () => {
    const original = '# Existing instructions\n\nKeep this.\n';
    const generated = updateManagedAgentsContent(original, 'dev_env');
    const updated = updateManagedAgentsContent(generated, 'dev_env');

    assert.match(generated, /^# Existing instructions/m);
    assert.match(generated, /<!-- ecode-local:ai-start -->/);
    assert.match(generated, /泛微 E-cology 9 Ecode 前端扩展项目/);
    assert.match(generated, /不是独立的 Node\.js、React CLI 或普通 Web 项目/);
    assert.match(generated, /由 Ecode 运行时提供/);
    assert.match(generated, /Babel 7\.5\.5/);
    assert.match(generated, /\.ecode-local\/common\/ecode-ai\/skills\/ecode-local\/SKILL\.md/);
    assert.match(generated, /当前环境项目知识位于 `.ecode-local\/dev_env\/ecode-ai\/`/);
    assert.match(generated, /所有扩展功能统一通过 Skill 提供的 `scripts\/ecode-agent\.cjs` 调用/);
    assert.match(generated, /不直接读写 `.ecode-local\/agent-cli\/`/);
    assert.match(generated, /不自动执行远端推送、删除、冲突处理或变更集应用/);
    assert.match(generated, /推送必须有单独、明确的当前任务授权/);
    assert.strictEqual(updated, generated);
    assert.strictEqual(removeManagedAgentsContent(generated), original);
    assert.throws(
      () => updateManagedAgentsContent(
        `${original}<!-- ecode-local:ai-start -->\nmissing end\n`,
        'dev_env',
      ),
      /标记残缺/,
    );
  });

  test('validates AI requests and binds the id to the file name', () => {
    const request = parseAiRequest(JSON.stringify({
      schemaVersion: 2,
      id: 'push_001',
      action: 'push',
      confirmed: true,
      environmentDirectory: 'dev_01',
      paths: ['Type/a.js', 'Page/b.jsx'],
      createdAt: '2026-07-30T12:00:00.000Z',
      expiresAt: '2026-08-30T12:00:00.000Z',
    }), 'push_001.json');

    assert.deepStrictEqual(request.paths, ['Type/a.js', 'Page/b.jsx']);
    assert.throws(
      () => parseAiRequest(JSON.stringify({
        ...request,
        paths: ['Type/a.js', 'type/A.js'],
      }), 'push_001.json'),
      /重复路径/,
    );
    assert.throws(
      () => parseAiRequest(JSON.stringify(request), 'another.json'),
      /文件名必须/,
    );
    assert.throws(
      () => parseAiRequest(JSON.stringify({
        ...request,
        environmentDirectory: '开发环境',
      }), 'push_001.json'),
      /只能包含英文字母/,
    );
    assert.throws(
      () => parseAiRequest(JSON.stringify({
        ...request,
        schemaVersion: 1,
      }), 'push_001.json'),
      /schemaVersion 必须为 2/,
    );
  });

  test('validates action-specific AI invocation fields', () => {
    assert.deepStrictEqual(parseAiInvocation({
      action: 'resolveConflict',
      confirmed: true,
      path: 'Type/a.js',
      resolution: 'markMerged',
    }), {
      action: 'resolveConflict',
      confirmed: true,
      path: 'Type/a.js',
      resolution: 'markMerged',
    });
    assert.throws(
      () => parseAiInvocation({ action: 'push', confirmed: true, paths: [] }),
      /至少包含一个/,
    );
    assert.throws(
      () => parseAiInvocation({ action: 'switchEnvironment', confirmed: true }),
      /environmentId/,
    );
    assert.deepStrictEqual(parseAiInvocation({
      action: 'deleteEnvironment',
      environmentId: 'env_test',
      confirmed: true,
    }), {
      action: 'deleteEnvironment',
      environmentId: 'env_test',
      confirmed: true,
    });
    assert.deepStrictEqual(parseAiInvocation({ action: 'enableAiSupport' }), {
      action: 'enableAiSupport',
    });
    assert.throws(
      () => parseAiInvocation({ action: 'push', paths: ['Type/a.js'] }),
      /明确授权/,
    );
    assert.throws(
      () => parseAiInvocation({ action: 'pull', confirmed: true }),
      /不接受 confirmed/,
    );
  });

  test('invalidates a pending AI request when the workspace context changes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-ai-generation-'));
    const workspaceA = path.join(root, 'workspace-a');
    const workspaceB = path.join(root, 'workspace-b');
    const requestDirectory = path.join(workspaceA, '.ecode-local', 'agent-cli', 'requests');
    fs.mkdirSync(requestDirectory, { recursive: true });
    fs.mkdirSync(workspaceB, { recursive: true });
    fs.writeFileSync(path.join(requestDirectory, 'pending.json'), JSON.stringify({
      schemaVersion: 2,
      id: 'pending',
      action: 'push',
      confirmed: true,
      environmentDirectory: 'dev',
      paths: ['Type/a.js'],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }), 'utf8');
    let executions = 0;
    const controller = new AiRequestController(
      { warn: () => undefined } as unknown as vscode.LogOutputChannel,
      async () => {
        executions++;
        return { status: 'succeeded' };
      },
    );

    try {
      controller.configure(workspaceA);
      await delay(20);
      controller.configure(workspaceB);
      await delay(400);

      assert.strictEqual(executions, 0);
      assert.strictEqual(
        fs.existsSync(path.join(
          workspaceA,
          '.ecode-local',
          'agent-cli',
          'results',
          'pending.json',
        )),
        false,
      );
    } finally {
      controller.dispose();
      await delay(100);
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  test('processes a generic file request and writes a v2 result', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-ai-request-'));
    const requestDirectory = path.join(root, '.ecode-local', 'agent-cli', 'requests');
    const controller = new AiRequestController(
      { warn: () => undefined } as unknown as vscode.LogOutputChannel,
      async invocation => ({
        status: 'succeeded',
        environmentDirectory: 'active_after_action',
        data: { action: invocation.action },
      }),
    );
    try {
      controller.configure(root);
      fs.mkdirSync(requestDirectory, { recursive: true });
      fs.writeFileSync(path.join(requestDirectory, 'state_001.json'), JSON.stringify({
        schemaVersion: 2,
        id: 'state_001',
        action: 'getState',
        environmentDirectory: 'dev',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }), 'utf8');
      await delay(1_200);
      const result = JSON.parse(fs.readFileSync(path.join(
        root,
        '.ecode-local',
        'agent-cli',
        'results',
        'state_001.json',
      ), 'utf8')) as Record<string, unknown>;
      assert.strictEqual(result.schemaVersion, 2);
      assert.strictEqual(result.action, 'getState');
      assert.strictEqual(result.status, 'succeeded');
      assert.strictEqual(result.environmentDirectory, 'active_after_action');
    } finally {
      controller.dispose();
      await delay(100);
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  test('rejects an expired file request without executing it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-ai-expired-'));
    const requestDirectory = path.join(root, '.ecode-local', 'agent-cli', 'requests');
    let executions = 0;
    const controller = new AiRequestController(
      { warn: () => undefined } as unknown as vscode.LogOutputChannel,
      async () => {
        executions++;
        return { status: 'succeeded' };
      },
    );
    try {
      controller.configure(root);
      fs.mkdirSync(requestDirectory, { recursive: true });
      fs.writeFileSync(path.join(requestDirectory, 'expired_001.json'), JSON.stringify({
        schemaVersion: 2,
        id: 'expired_001',
        action: 'getState',
        environmentDirectory: 'workspace',
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      }), 'utf8');
      await delay(1_200);
      const result = JSON.parse(fs.readFileSync(path.join(
        root,
        '.ecode-local',
        'agent-cli',
        'results',
        'expired_001.json',
      ), 'utf8')) as Record<string, unknown>;
      assert.strictEqual(executions, 0);
      assert.strictEqual(result.status, 'rejected');
      assert.match(String(result.message), /已过期/);
    } finally {
      controller.dispose();
      await delay(100);
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  test('prunes the oldest AI request and result pairs beyond the history limit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-ai-history-'));
    const requestDirectory = path.join(root, '.ecode-local', 'agent-cli', 'requests');
    const resultDirectory = path.join(root, '.ecode-local', 'agent-cli', 'results');
    fs.mkdirSync(requestDirectory, { recursive: true });
    fs.mkdirSync(resultDirectory, { recursive: true });
    for (let index = 1; index <= 3; index++) {
      const id = `history_00${index}`;
      const requestFile = path.join(requestDirectory, `${id}.json`);
      const resultFile = path.join(resultDirectory, `${id}.json`);
      fs.writeFileSync(requestFile, JSON.stringify({
        schemaVersion: 2,
        id,
        action: 'getState',
        environmentDirectory: 'workspace',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }), 'utf8');
      fs.writeFileSync(resultFile, JSON.stringify({
        schemaVersion: 2,
        id,
        action: 'getState',
        processedAt: new Date().toISOString(),
        status: 'succeeded',
      }), 'utf8');
      const modifiedAt = new Date(Date.now() - (4 - index) * 1_000);
      fs.utimesSync(requestFile, modifiedAt, modifiedAt);
      fs.utimesSync(resultFile, modifiedAt, modifiedAt);
    }
    let executions = 0;
    const controller = new AiRequestController(
      { warn: () => undefined } as unknown as vscode.LogOutputChannel,
      async () => {
        executions++;
        return { status: 'succeeded' };
      },
      2,
      60_000,
    );
    try {
      controller.configure(root);
      await delay(1_200);

      assert.strictEqual(executions, 0);
      assert.strictEqual(fs.existsSync(path.join(requestDirectory, 'history_001.json')), false);
      assert.strictEqual(fs.existsSync(path.join(resultDirectory, 'history_001.json')), false);
      assert.strictEqual(fs.existsSync(path.join(requestDirectory, 'history_002.json')), true);
      assert.strictEqual(fs.existsSync(path.join(resultDirectory, 'history_003.json')), true);
    } finally {
      controller.dispose();
      await delay(100);
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  test('does not prune pending AI requests when history is over the limit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-ai-pending-history-'));
    const requestDirectory = path.join(root, '.ecode-local', 'agent-cli', 'requests');
    fs.mkdirSync(requestDirectory, { recursive: true });
    for (let index = 1; index <= 3; index++) {
      const id = `pending_00${index}`;
      fs.writeFileSync(path.join(requestDirectory, `${id}.json`), JSON.stringify({
        schemaVersion: 2,
        id,
        action: 'getState',
        environmentDirectory: 'workspace',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }), 'utf8');
    }
    let executions = 0;
    const controller = new AiRequestController(
      { warn: () => undefined } as unknown as vscode.LogOutputChannel,
      async () => {
        executions++;
        return { status: 'succeeded' };
      },
      1,
      60_000,
    );
    try {
      controller.configure(root);
      await delay(1_500);

      assert.strictEqual(executions, 3);
    } finally {
      controller.dispose();
      await delay(100);
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  test('documents only the supplied ecode component calls with relative paths', () => {
    const workspaceRoot = path.join('C:', 'workspace', 'business');
    const calls: IndexedEcodeComponentCall[] = [
      call(workspaceRoot, 'definition', 'ecode/components/widget.js', 3),
      call(workspaceRoot, 'reference', 'ecode/pages/home.js', 8),
    ];
    const markdown = generateWorkspaceComponents(workspaceRoot, calls, 'ecode');

    assert.match(markdown, /app-test/);
    assert.match(markdown, /Widget/);
    assert.match(markdown, /ecode\/components\/widget\.js:4/);
    assert.match(markdown, /ecode\/pages\/home\.js:9/);
    assert.ok(!markdown.includes(`${workspaceRoot}/`));
  });

  test('generates AI-readable form fields grouped by source context', () => {
    const markdown = generateWorkspaceFormMetadata([{
      remoteId: 'file-1',
      path: '流程/A002/index.js',
      updatedAt: new Date(0).toISOString(),
      contexts: [{
        kind: 'workflow',
        formId: '-133',
        tables: [{
          mark: 'main',
          tableName: 'formtable_main_133',
          fields: [{
            id: '11408',
            label: '出发地点',
            name: 'cfdd',
            dbType: 'varchar(4000)',
            isView: true,
          }],
        }, {
          mark: 'detail_2',
          title: '用车明细',
          fields: [{
            id: '11420',
            label: '存货编码',
            name: 'chbm',
          }],
        }],
      }],
    }], 'dev_env');

    assert.match(markdown, /dev_env\/流程\/A002\/index\.js/);
    assert.match(markdown, /流程表单（formId -133）/);
    assert.match(markdown, /field11408/);
    assert.match(markdown, /出发地点/);
    assert.match(markdown, /cfdd/);
    assert.match(markdown, /detail\\_2/);
    assert.match(markdown, /默认定位主表/);
  });

  test('separates common knowledge from environment project knowledge', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-ai-layout-'));
    const service = new AiSupportService(
      {
        refreshSourceRoot: async () => undefined,
        getSnapshot: async () => [],
      } as unknown as WorkspaceComponentRegistry,
      {
        getSnapshot: () => [],
      } as never,
      'test',
      {
        info: () => undefined,
      } as never,
      path.resolve(__dirname, '..', '..', '..'),
    );
    try {
      const result = await service.refresh({
        version: 4,
        environmentId: 'dev',
        environmentDirectory: 'dev_env',
        workspaceFolder: root,
        serverUrl: 'https://example.test',
        username: 'tester',
      });

      assert.strictEqual(
        result.directory,
        path.join(root, '.ecode-local', 'dev_env', 'ecode-ai'),
      );
      assert.strictEqual(
        fs.existsSync(path.join(result.directory, 'workspace-form-metadata.md')),
        true,
      );
      assert.strictEqual(
        fs.existsSync(path.join(
          result.commonDirectory,
          'skills',
          'ecode-local',
          'scripts',
          'ecode-agent.cjs',
        )),
        true,
      );
      assert.strictEqual(
        result.commonDirectory,
        path.join(root, '.ecode-local', 'common', 'ecode-ai'),
      );
      assert.strictEqual(
        fs.existsSync(path.join(result.commonDirectory, 'ecode-globals.d.ts')),
        true,
      );
      assert.strictEqual(
        fs.existsSync(path.join(
          result.commonDirectory,
          'skills',
          'ecode-local',
          'SKILL.md',
        )),
        true,
      );
      const generatedSkill = fs.readFileSync(path.join(
        result.commonDirectory,
        'skills',
        'ecode-local',
        'SKILL.md',
      ), 'utf8');
      assert.match(generatedSkill, /仅通过以下 CLI 调用扩展/);
      assert.match(generatedSkill, /不直接读写 `.ecode-local` 内部状态或请求\/结果文件/);
      assert.match(
        fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
        /\.ecode-local\/dev_env\/ecode-ai/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('filters the workspace component snapshot to one environment source root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-ai-registry-'));
    const sourceRoot = path.join(root, 'dev_env');
    fs.mkdirSync(sourceRoot);
    const inside = path.join(sourceRoot, 'inside.js');
    const outside = path.join(root, 'outside.js');
    fs.writeFileSync(
      inside,
      'ecodeSDK.setCom("app-test", "InsideWidget", InsideWidget);',
      'utf8',
    );
    fs.writeFileSync(
      outside,
      'ecodeSDK.setCom("app-test", "OutsideWidget", OutsideWidget);',
      'utf8',
    );
    const registry = new WorkspaceComponentRegistry();
    try {
      await vscode.workspace.openTextDocument(inside);
      await vscode.workspace.openTextDocument(outside);
      const snapshot = await registry.getSnapshot(sourceRoot);

      assert.deepStrictEqual(snapshot.map(item => item.name), ['InsideWidget']);

      fs.rmSync(sourceRoot, { recursive: true, force: true });
      await registry.refreshSourceRoot(sourceRoot);
      assert.deepStrictEqual(await registry.getSnapshot(sourceRoot), []);
    } finally {
      registry.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('limits component definitions and references to the source environment', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-ai-navigation-'));
    const developmentRoot = path.join(root, 'development');
    const productionRoot = path.join(root, 'production');
    const files = [
      path.join(developmentRoot, 'registration.js'),
      path.join(developmentRoot, 'usage.js'),
      path.join(productionRoot, 'registration.js'),
      path.join(productionRoot, 'usage.js'),
    ];
    fs.mkdirSync(developmentRoot, { recursive: true });
    fs.mkdirSync(productionRoot, { recursive: true });
    for (const file of files) {
      fs.writeFileSync(
        file,
        file.endsWith('registration.js')
          ? 'ecodeSDK.setCom("app-test", "Widget", Widget);'
          : 'ecodeSDK.getCom("app-test", "Widget");',
        'utf8',
      );
    }
    const registry = new WorkspaceComponentRegistry();
    try {
      registry.setSourceRoots([developmentRoot, productionRoot]);
      await registry.refreshSourceRoot(developmentRoot);
      await registry.refreshSourceRoot(productionRoot);
      const sourceUri = vscode.Uri.file(path.join(developmentRoot, 'usage.js'));
      const componentCall = call(
        developmentRoot,
        'reference',
        'usage.js',
        0,
      );

      const definitions = await registry.getDefinitions(
        componentCall,
        sourceUri,
      );
      const references = await registry.getReferences(
        componentCall,
        true,
        sourceUri,
      );

      assert.deepStrictEqual(
        definitions.map(location => pathKey(location.uri.fsPath)),
        [pathKey(path.join(developmentRoot, 'registration.js'))],
      );
      assert.deepStrictEqual(
        references.map(location => pathKey(location.uri.fsPath)).sort(),
        [
          pathKey(path.join(developmentRoot, 'registration.js')),
          pathKey(path.join(developmentRoot, 'usage.js')),
        ].sort(),
      );
    } finally {
      registry.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function call(
  workspaceRoot: string,
  kind: 'definition' | 'reference',
  relativePath: string,
  line: number,
): IndexedEcodeComponentCall {
  return {
    kind,
    method: kind === 'definition' ? 'setCom' : 'getCom',
    appId: 'app-test',
    name: 'Widget',
    appIdRange: { start: 0, end: 8 },
    nameRange: { start: 10, end: 16 },
    uri: vscode.Uri.file(path.join(workspaceRoot, relativePath)),
    range: new vscode.Range(line, 2, line, 8),
  };
}

function pathKey(filePath: string): string {
  return process.platform === 'win32'
    ? path.resolve(filePath).toLowerCase()
    : path.resolve(filePath);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
