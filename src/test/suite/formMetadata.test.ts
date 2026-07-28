import * as assert from 'assert';
import * as vscode from 'vscode';
import type {
  CachedFileFormMetadata,
  FormContext,
} from '../../domain/formMetadata';
import {
  formCompletionItems,
  formDefinitions,
  formHover,
} from '../../language/FormMetadataLanguage';
import {
  findFormReferenceAt,
  findFormVariableReferenceAt,
  parseFormReferenceContext,
} from '../../language/formKnowledge';
import type { WorkspaceFormMetadataRegistry } from '../../language/WorkspaceFormMetadataRegistry';
import { extractFormMetadata } from '../../sync/api/FormMetadataParser';

suite('Form metadata intelligence', () => {
  test('extracts workflow tables from nested and stringified metadata', () => {
    const result = extractFormMetadata({
      data: {
        content: 'const ignored = true;',
        metadata: JSON.stringify({
          workflowId: 77,
          formId: -12,
          tableInfo: {
            MAIN: {
              TABLEName: 'formtable_main_12',
              FIELDINFOMAP: {
                110: {
                  FIELDID: 110,
                  FIELDLABEL: '申请人',
                  FIELDNAME: 'applicant',
                  HTMLTYPE: 3,
                  DETAILTYPE: 1,
                  FIELDDBTYPE: 'varchar(4000)',
                  ISVIEW: 1,
                  ISEDIT: 0,
                  ISMAND: '1',
                },
              },
            },
            DETAIL_1: {
              detailTableAttr: {
                detailTitle: '费用明细',
                detailTable: 'formtable_main_12_dt1',
              },
              fieldInfoMap: {
                205: {
                  fieldId: 205,
                  fieldLabel: '金额',
                  fieldName: 'amount',
                },
              },
            },
          },
        }),
      },
    });

    assert.strictEqual(result.state, 'present');
    assert.strictEqual(result.contexts.length, 1);
    assert.strictEqual(result.contexts[0].kind, 'workflow');
    assert.strictEqual(result.contexts[0].workflowId, '77');
    assert.strictEqual(result.contexts[0].tables[0].mark, 'main');
    assert.strictEqual(result.contexts[0].tables[0].fields[0].label, '申请人');
    assert.strictEqual(result.contexts[0].tables[0].fields[0].isMandatory, true);
    assert.strictEqual(result.contexts[0].tables[1].mark, 'detail_1');
    assert.strictEqual(result.contexts[0].tables[1].title, '费用明细');
  });

  test('does not parse JSON source content as metadata', () => {
    const result = extractFormMetadata({
      data: {
        content: JSON.stringify({
          main: {
            fieldInfoMap: {
              1: { fieldId: 1, fieldLabel: '不应读取' },
            },
          },
        }),
      },
    });

    assert.strictEqual(result.state, 'absent');
    assert.deepStrictEqual(result.contexts, []);
  });

  test('marks a malformed metadata JSON payload as invalid', () => {
    const result = extractFormMetadata({
      data: {
        content: 'const value = true;',
        metadata: '{"tableInfo":',
      },
    });

    assert.strictEqual(result.state, 'invalid');
    assert.match(result.warnings.join('\n'), /不是有效 JSON/);
  });

  test('rejects multiple untyped field tables instead of guessing', () => {
    const result = extractFormMetadata({
      first: {
        main: {
          fieldInfoMap: {
            1: { fieldId: 1, fieldLabel: '字段一' },
          },
        },
      },
      second: {
        main: {
          fieldInfoMap: {
            2: { fieldId: 2, fieldLabel: '字段二' },
          },
        },
      },
    });

    assert.strictEqual(result.state, 'invalid');
    assert.deepStrictEqual(result.contexts, []);
    assert.match(result.warnings.join('\n'), /无法区分/);
  });

  test('recognizes only form API semantic positions', () => {
    const field = 'WfForm.getFieldValue("field11';
    const detail = 'window.ModeForm.addDetailRow("detail_';
    const objectKey = 'WfForm.changeMoreField({ field11';
    const detailObjectKey = 'ModeForm.addDetailRow("detail_1", { field2';

    assert.deepStrictEqual(
      pickContext(parseFormReferenceContext(field, field.length)),
      { object: 'WfForm', role: 'fieldMark', prefix: 'field11' },
    );
    assert.deepStrictEqual(
      pickContext(parseFormReferenceContext(detail, detail.length)),
      { object: 'ModeForm', role: 'detailMark', prefix: 'detail_' },
    );
    assert.deepStrictEqual(
      pickContext(parseFormReferenceContext(objectKey, objectKey.length)),
      { object: 'WfForm', role: 'fieldObjectKey', prefix: 'field11' },
    );
    assert.strictEqual(
      parseFormReferenceContext('const value = "field11', 22),
      undefined,
    );
    assert.strictEqual(
      parseFormReferenceContext('other.getFieldValue("field11', 28),
      undefined,
    );
    assert.strictEqual(
      parseFormReferenceContext(detailObjectKey, detailObjectKey.length)?.tableScope,
      'detail_1',
    );
    const defaultMain = 'WfForm.convertFieldNameToId("app';
    assert.strictEqual(
      parseFormReferenceContext(defaultMain, defaultMain.length)?.tableScope,
      'main',
    );
    const dynamicTable =
      'WfForm.convertFieldNameToId("applicant", currentDetail);';
    assert.strictEqual(
      parseFormReferenceContext(
        dynamicTable,
        dynamicTable.indexOf('applicant') + 3,
      ),
      undefined,
    );
  });

  test('finds field marks, row-suffixed marks, names, and detail marks for F12', () => {
    const source = [
      'WfForm.getFieldValue("field110_3");',
      'WfForm.convertFieldNameToId("applicant");',
      'WfForm.convertFieldNameToId("amount", "detail_1", false);',
      'ModeForm.addDetailRow("detail_1", { field205: { value: "1" } });',
    ].join('\n');

    assert.strictEqual(
      findFormReferenceAt(source, source.indexOf('field110') + 3)?.prefix,
      'field110_3',
    );
    assert.strictEqual(
      findFormReferenceAt(source, source.indexOf('applicant') + 3)?.role,
      'fieldName',
    );
    assert.strictEqual(
      findFormReferenceAt(source, source.indexOf('amount') + 3)?.tableScope,
      'detail_1',
    );
    assert.strictEqual(
      findFormReferenceAt(source, source.indexOf('detail_1') + 3)?.role,
      'detailMark',
    );
    assert.strictEqual(
      findFormReferenceAt(source, source.indexOf('field205') + 3)?.role,
      'fieldObjectKey',
    );
  });

  test('builds localized completion items and metadata definitions', async () => {
    const source = [
      'WfForm.getFieldValue("field1',
      'WfForm.getFieldValue("field110_3");',
    ].join('\n');
    const document = await vscode.workspace.openTextDocument({
      language: 'javascript',
      content: source,
    });
    const file = cachedFile();
    const registry = {
      getContexts: () => file.contexts,
      getFile: () => file,
      getDocumentUri: () => vscode.Uri.parse('ecode-form:/fixture.md'),
    } as unknown as WorkspaceFormMetadataRegistry;
    const completionOffset = source.indexOf('\n');
    const completionContext = parseFormReferenceContext(source, completionOffset);
    assert.ok(completionContext);
    const items = formCompletionItems(document, completionContext!, registry);
    assert.ok(items);
    assert.ok(items!.some(item =>
      String(item.label).includes('field110')
      && String(item.label).includes('申请人')
      && item.insertText === 'field110'));

    const referenceOffset = source.lastIndexOf('field110') + 4;
    const reference = findFormReferenceAt(source, referenceOffset);
    assert.ok(reference);
    const definitions = formDefinitions(document, reference!, registry);
    assert.strictEqual(definitions?.length, 1);
    assert.strictEqual(definitions?.[0].uri.scheme, 'ecode-form');
    assert.ok((definitions?.[0].range.start.line ?? -1) > 0);

    const hover = formHover(document, reference!, registry);
    assert.ok(hover);
    const hoverText = hover!.contents.map(content =>
      typeof content === 'string' ? content : content.value).join('\n');
    assert.match(hoverText, /申请人/);
    assert.match(hoverText, /field110/);
    assert.match(hoverText, /applicant/);
    assert.match(hoverText, /Ctrl\+单击/);
    assert.strictEqual(
      document.getText(hover!.range),
      'field110_3',
    );
  });

  test('prioritizes database field names in convertFieldNameToId', async () => {
    const source = 'WfForm.convertFieldNameToId("amount", "detail_1", false);';
    const document = await vscode.workspace.openTextDocument({
      language: 'javascript',
      content: source,
    });
    const file = cachedFile();
    const registry = {
      getContexts: () => file.contexts,
      getFile: () => file,
      getDocumentUri: () => vscode.Uri.parse('ecode-form:/fixture.md'),
    } as unknown as WorkspaceFormMetadataRegistry;
    const offset = source.indexOf('"amount') + 3;
    const context = parseFormReferenceContext(source, offset);
    assert.strictEqual(context?.role, 'fieldName');
    assert.strictEqual(context?.tableScope, 'detail_1');

    const items = formCompletionItems(document, context!, registry);
    assert.strictEqual(items?.length, 1);
    assert.strictEqual(items?.[0].insertText, 'amount');
    assert.ok(String(items?.[0].label).includes('amount'));
    assert.ok(!items?.some(item => item.insertText === 'applicant'));

    const reference = findFormReferenceAt(source, source.indexOf('amount') + 3);
    assert.ok(reference);
    const hover = formHover(document, reference!, registry);
    assert.ok(hover);
    const hoverText = hover!.contents.map(content =>
      typeof content === 'string' ? content : content.value).join('\n');
    assert.match(hoverText, /金额/);
    assert.match(hoverText, /field205/);
    assert.match(hoverText, /detail_1/);
  });

  test('adds field metadata hover to a statically converted field variable', async () => {
    const source = [
      'const applicantId = WfForm.convertFieldNameToId("applicant");',
      'WfForm.getFieldValue(applicantId);',
      'const unrelated = "applicantId";',
    ].join('\n');
    const declarationOffset = source.indexOf('applicantId') + 3;
    const usageOffset = source.indexOf(
      'applicantId',
      declarationOffset + 'applicantId'.length,
    ) + 3;
    const unrelatedOffset = source.indexOf('"applicantId') + 4;
    const reference = findFormVariableReferenceAt(source, usageOffset);
    assert.ok(reference);
    assert.strictEqual(reference?.prefix, 'applicant');
    assert.ok(findFormVariableReferenceAt(source, declarationOffset));
    assert.strictEqual(
      findFormVariableReferenceAt(source, unrelatedOffset),
      undefined,
    );

    const document = await vscode.workspace.openTextDocument({
      language: 'javascript',
      content: source,
    });
    const file = cachedFile();
    const registry = {
      getContexts: () => file.contexts,
      getFile: () => file,
      getDocumentUri: () => vscode.Uri.parse('ecode-form:/fixture.md'),
    } as unknown as WorkspaceFormMetadataRegistry;
    const hover = formHover(document, reference!, registry);
    assert.ok(hover);
    const hoverText = hover!.contents.map(content =>
      typeof content === 'string' ? content : content.value).join('\n');
    assert.match(hoverText, /申请人/);
    assert.match(hoverText, /field110/);
    assert.strictEqual(document.getText(hover!.range), 'applicantId');
  });

  test('scopes converted field variables to main or the explicit detail table', async () => {
    const source = [
      'const mainId = WfForm.convertFieldNameToId("shared");',
      'const detailId = WfForm.convertFieldNameToId("shared", "detail_2");',
      'mainId;',
      'detailId;',
    ].join('\n');
    const file = cachedFile();
    file.contexts[0].tables[0].fields.push({
      id: '300',
      label: '主表同名字段',
      name: 'shared',
    });
    file.contexts[0].tables[1].fields.push({
      id: '301',
      label: '明细一同名字段',
      name: 'shared',
    });
    file.contexts[0].tables.push({
      mark: 'detail_2',
      title: '明细二',
      fields: [{
        id: '302',
        label: '明细二同名字段',
        name: 'shared',
      }],
    });
    const registry = {
      getContexts: () => file.contexts,
      getFile: () => file,
      getDocumentUri: () => vscode.Uri.parse('ecode-form:/fixture.md'),
    } as unknown as WorkspaceFormMetadataRegistry;
    const document = await vscode.workspace.openTextDocument({
      language: 'javascript',
      content: source,
    });
    const mainUsage = source.lastIndexOf('mainId') + 2;
    const detailUsage = source.lastIndexOf('detailId') + 2;
    const mainReference = findFormVariableReferenceAt(source, mainUsage);
    const detailReference = findFormVariableReferenceAt(source, detailUsage);
    assert.strictEqual(mainReference?.tableScope, 'main');
    assert.strictEqual(detailReference?.tableScope, 'detail_2');

    const mainHover = formHover(document, mainReference!, registry);
    const detailHover = formHover(document, detailReference!, registry);
    const mainText = hoverText(mainHover);
    const detailText = hoverText(detailHover);
    assert.match(mainText, /主表同名字段/);
    assert.doesNotMatch(mainText, /明细一同名字段|明细二同名字段/);
    assert.match(detailText, /明细二同名字段/);
    assert.doesNotMatch(detailText, /主表同名字段|明细一同名字段/);

    const mainDefinition = formDefinitions(
      document,
      mainReference!,
      registry,
    );
    const detailDefinition = formDefinitions(
      document,
      detailReference!,
      registry,
    );
    assert.strictEqual(mainDefinition?.length, 1);
    assert.strictEqual(detailDefinition?.length, 1);
    assert.notStrictEqual(
      mainDefinition?.[0].range.start.line,
      detailDefinition?.[0].range.start.line,
    );
    const dynamicSource =
      'const dynamicId = WfForm.convertFieldNameToId("shared", tableMark);';
    assert.strictEqual(
      findFormVariableReferenceAt(
        dynamicSource,
        dynamicSource.indexOf('dynamicId') + 2,
      ),
      undefined,
    );
  });
});

function pickContext(context: ReturnType<typeof parseFormReferenceContext>): {
  object: string;
  role: string;
  prefix: string;
} | undefined {
  return context
    ? {
        object: context.object,
        role: context.role,
        prefix: context.prefix,
      }
    : undefined;
}

function cachedFile(): CachedFileFormMetadata {
  const context: FormContext = {
    kind: 'workflow',
    workflowId: '77',
    formId: '-12',
    tables: [
      {
        mark: 'main',
        tableName: 'formtable_main_12',
        fields: [
          {
            id: '110',
            label: '申请人',
            name: 'applicant',
            htmlType: '3',
            detailType: '1',
            dbType: 'varchar(4000)',
          },
        ],
      },
      {
        mark: 'detail_1',
        title: '费用明细',
        fields: [
          {
            id: '205',
            label: '金额',
            name: 'amount',
          },
        ],
      },
    ],
  };
  return {
    remoteId: 'file-1',
    path: 'Type/form.js',
    updatedAt: new Date(0).toISOString(),
    contexts: [context],
  };
}

function hoverText(hover: vscode.Hover | undefined): string {
  return hover?.contents.map(content =>
    typeof content === 'string' ? content : content.value).join('\n') ?? '';
}
