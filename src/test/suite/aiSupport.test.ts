import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import * as vscode from 'vscode';
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
    const generated = updateManagedAgentsContent(original);
    const updated = updateManagedAgentsContent(generated);

    assert.match(generated, /^# Existing instructions/m);
    assert.match(generated, /<!-- ecode-local:ai-start -->/);
    assert.match(generated, /泛微 E-cology 9 Ecode 前端扩展项目/);
    assert.match(generated, /不是独立的 Node\.js、React CLI 或普通 Web 项目/);
    assert.match(generated, /运行时全局提供，无须 npm 安装或 import/);
    assert.match(generated, /Babel 7\.5\.5/);
    assert.match(generated, /\.ecode-local\/ecode-ai\/workspace-form-metadata\.md/);
    assert.match(generated, /不要假设业务工作区使用 Git/);
    assert.match(generated, /不要自动执行远端推送、删除或发布操作/);
    assert.strictEqual(updated, generated);
    assert.strictEqual(removeManagedAgentsContent(generated), original);
    assert.throws(
      () => updateManagedAgentsContent(
        `${original}<!-- ecode-local:ai-start -->\nmissing end\n`,
      ),
      /标记残缺/,
    );
  });

  test('documents only the supplied ecode component calls with relative paths', () => {
    const workspaceRoot = path.join('C:', 'workspace', 'business');
    const calls: IndexedEcodeComponentCall[] = [
      call(workspaceRoot, 'definition', 'ecode/components/widget.js', 3),
      call(workspaceRoot, 'reference', 'ecode/pages/home.js', 8),
    ];
    const markdown = generateWorkspaceComponents(workspaceRoot, calls);

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
    }]);

    assert.match(markdown, /ecode\/流程\/A002\/index\.js/);
    assert.match(markdown, /流程表单（formId -133）/);
    assert.match(markdown, /field11408/);
    assert.match(markdown, /出发地点/);
    assert.match(markdown, /cfdd/);
    assert.match(markdown, /detail\\_2/);
    assert.match(markdown, /默认定位主表/);
  });

  test('writes AI support below .ecode-local and cleans legacy managed files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-ai-migration-'));
    const legacy = path.join(root, '.ecode-ai');
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, 'ecode-ai-guide.md'), 'legacy', 'utf8');
    fs.writeFileSync(path.join(legacy, 'custom.md'), 'keep', 'utf8');
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
    );
    try {
      const result = await service.refresh({
        version: 3,
        workspaceFolder: root,
        serverUrl: 'https://example.test',
        username: 'tester',
      });

      assert.strictEqual(
        result.directory,
        path.join(root, '.ecode-local', 'ecode-ai'),
      );
      assert.strictEqual(
        fs.existsSync(path.join(result.directory, 'workspace-form-metadata.md')),
        true,
      );
      assert.strictEqual(
        fs.existsSync(path.join(legacy, 'ecode-ai-guide.md')),
        false,
      );
      assert.strictEqual(fs.readFileSync(path.join(legacy, 'custom.md'), 'utf8'), 'keep');
      assert.match(
        fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
        /\.ecode-local\/ecode-ai/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('filters the workspace component snapshot to the fixed ecode source root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecode-ai-registry-'));
    const sourceRoot = path.join(root, 'ecode');
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
