import * as vscode from 'vscode';
import type {
  CachedFileFormMetadata,
  FormContext,
  FormField,
  FormTable,
} from '../domain/formMetadata';
import type {
  FormReferenceContext,
  FormReferenceRole,
} from './formKnowledge';
import {
  type WorkspaceFormMetadataRegistry,
} from './WorkspaceFormMetadataRegistry';

interface FieldCandidate {
  context: FormContext;
  table: FormTable;
  field: FormField;
  insertText: string;
}

interface TableCandidate {
  context: FormContext;
  table: FormTable;
  insertText: string;
}

interface RenderedMetadataDocument {
  text: string;
  targetLines: Map<string, number>;
}

export class EcodeFormDocumentationProvider
implements vscode.TextDocumentContentProvider {
  readonly onDidChange: vscode.Event<vscode.Uri>;

  constructor(
    private readonly registry: WorkspaceFormMetadataRegistry,
  ) {
    this.onDidChange = registry.onDidChangeDocument;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const file = this.registry.getFileByDocumentUri(uri);
    return file
      ? renderMetadataDocument(file).text
      : '# Ecode 表单元数据\n\n未找到当前文件的缓存表单元数据。';
  }
}

export function formCompletionItems(
  document: vscode.TextDocument,
  context: FormReferenceContext,
  registry: WorkspaceFormMetadataRegistry,
): vscode.CompletionItem[] | undefined {
  const contexts = registry.getContexts(document, context.object);
  if (contexts.length === 0) {
    return undefined;
  }
  const range = new vscode.Range(
    document.positionAt(context.replaceStart),
    document.positionAt(context.replaceEnd),
  );
  const result: vscode.CompletionItem[] = [];

  if (context.role === 'detailMark' || context.role === 'detailOrFieldMark') {
    for (const candidate of tableCandidates(contexts)) {
      if (!matchesPrefix(context.prefix, [
        candidate.insertText,
        candidate.table.title,
        candidate.table.tableName,
      ])) {
        continue;
      }
      const item = new vscode.CompletionItem(
        `${candidate.insertText} — ${tableDisplayName(candidate.table)}`,
        vscode.CompletionItemKind.Struct,
      );
      item.insertText = candidate.insertText;
      item.filterText = searchText([
        candidate.insertText,
        candidate.table.title,
        candidate.table.tableName,
      ]);
      item.detail = `${contextDescription(candidate.context)} · ${candidate.table.fields.length} 个字段`;
      item.documentation = tableDocumentation(candidate.context, candidate.table);
      item.range = range;
      item.sortText = `0-${candidate.insertText}`;
      result.push(item);
    }
  }

  if (context.role !== 'detailMark') {
    for (const candidate of fieldCandidates(contexts, context)) {
      if (!matchesPrefix(context.prefix, [
        candidate.insertText,
        candidate.field.label,
        candidate.field.name,
        `field${candidate.field.id}`,
        candidate.field.id,
      ])) {
        continue;
      }
      const item = new vscode.CompletionItem(
        `${candidate.insertText} — ${candidate.field.label}`,
        vscode.CompletionItemKind.Field,
      );
      item.insertText = candidate.insertText;
      item.filterText = searchText([
        candidate.insertText,
        candidate.field.label,
        candidate.field.name,
        `field${candidate.field.id}`,
        candidate.field.id,
      ]);
      item.detail = [
        tableDisplayName(candidate.table),
        candidate.field.name,
        fieldType(candidate.field),
        contextDescription(candidate.context),
      ].filter(Boolean).join(' · ');
      item.documentation = fieldDocumentation(
        candidate.context,
        candidate.table,
        candidate.field,
      );
      item.range = range;
      item.sortText = `1-${tableSortKey(candidate.table)}-${candidate.field.id}`;
      result.push(item);
    }
  }

  return result.length > 0 ? result : undefined;
}

export function formDefinitions(
  document: vscode.TextDocument,
  reference: FormReferenceContext,
  registry: WorkspaceFormMetadataRegistry,
): vscode.Location[] | undefined {
  const file = registry.getFile(document);
  const contexts = registry.getContexts(document, reference.object);
  if (!file || contexts.length === 0) {
    return undefined;
  }
  const rendered = renderMetadataDocument(file);
  const uri = registry.getDocumentUri(file);
  const locations: vscode.Location[] = [];

  if (reference.role === 'detailMark' || reference.role === 'detailOrFieldMark') {
    for (const context of contexts) {
      const contextIndex = file.contexts.indexOf(context);
      for (const table of context.tables) {
        if (table.mark !== reference.prefix.toLowerCase()) {
          continue;
        }
        const line = rendered.targetLines.get(tableTargetKey(contextIndex, table));
        if (line !== undefined) {
          locations.push(new vscode.Location(uri, new vscode.Position(line, 0)));
        }
      }
    }
  }

  if (reference.role !== 'detailMark') {
    for (const context of contexts) {
      const contextIndex = file.contexts.indexOf(context);
      for (const table of context.tables) {
        if (reference.tableScope && table.mark !== reference.tableScope) {
          continue;
        }
        for (const field of table.fields) {
          if (!fieldMatchesReference(reference.role, reference.prefix, field)) {
            continue;
          }
          const line = rendered.targetLines.get(
            fieldTargetKey(contextIndex, table, field),
          );
          if (line !== undefined) {
            locations.push(new vscode.Location(uri, new vscode.Position(line, 0)));
          }
        }
      }
    }
  }

  return locations.length > 0 ? locations : undefined;
}

export function formHover(
  document: vscode.TextDocument,
  reference: FormReferenceContext,
  registry: WorkspaceFormMetadataRegistry,
): vscode.Hover | undefined {
  const contexts = registry.getContexts(document, reference.object);
  if (contexts.length === 0) {
    return undefined;
  }
  const sections: string[] = [];
  const seen = new Set<string>();

  if (reference.role === 'detailMark' || reference.role === 'detailOrFieldMark') {
    for (const context of contexts) {
      for (const table of context.tables) {
        if (table.mark !== reference.prefix.toLowerCase()) {
          continue;
        }
        const key = `table|${contextDescription(context)}|${table.mark}`;
        if (!seen.has(key)) {
          seen.add(key);
          sections.push(tableDocumentation(context, table).value);
        }
      }
    }
  }

  if (reference.role !== 'detailMark') {
    for (const candidate of fieldCandidates(contexts, reference)) {
      if (!fieldMatchesReference(
        reference.role,
        reference.prefix,
        candidate.field,
      )) {
        continue;
      }
      const key = [
        'field',
        contextDescription(candidate.context),
        candidate.table.mark,
        candidate.field.id,
      ].join('|');
      if (!seen.has(key)) {
        seen.add(key);
        sections.push(fieldDocumentation(
          candidate.context,
          candidate.table,
          candidate.field,
        ).value);
      }
    }
  }

  if (sections.length === 0) {
    return undefined;
  }
  const visibleSections = sections.slice(0, 8);
  const markdown = new vscode.MarkdownString(
    visibleSections.join('\n\n---\n\n'),
  );
  if (sections.length > visibleSections.length) {
    markdown.appendMarkdown(
      `\n\n另有 ${sections.length - visibleSections.length} 个匹配项。`,
    );
  }
  markdown.appendMarkdown('\n\nCtrl+单击可跳转到表单元数据。');
  const range = new vscode.Range(
    document.positionAt(reference.replaceStart),
    document.positionAt(reference.replaceEnd),
  );
  return new vscode.Hover(markdown, range);
}

function fieldCandidates(
  contexts: FormContext[],
  reference: FormReferenceContext,
): FieldCandidate[] {
  const candidates: FieldCandidate[] = [];
  for (const context of contexts) {
    for (const table of context.tables) {
      if (reference.tableScope && table.mark !== reference.tableScope) {
        continue;
      }
      for (const field of table.fields) {
        const insertText = fieldInsertText(reference.role, field);
        if (insertText) {
          candidates.push({ context, table, field, insertText });
        }
      }
    }
  }
  return candidates;
}

function tableCandidates(contexts: FormContext[]): TableCandidate[] {
  return contexts.flatMap(context =>
    context.tables
      .filter(table => table.mark !== 'main')
      .map(table => ({ context, table, insertText: table.mark })));
}

function fieldInsertText(
  role: FormReferenceRole,
  field: FormField,
): string | undefined {
  switch (role) {
    case 'fieldId':
      return field.id;
    case 'fieldName':
      return field.name;
    case 'fieldMark':
    case 'fieldMarks':
    case 'fieldObjectKey':
    case 'detailOrFieldMark':
      return `field${field.id}`;
    default:
      return undefined;
  }
}

function fieldMatchesReference(
  role: FormReferenceRole,
  value: string,
  field: FormField,
): boolean {
  if (role === 'fieldName') {
    return field.name?.toLowerCase() === value.toLowerCase();
  }
  if (role === 'fieldId') {
    return field.id === value;
  }
  const match = /^field(-?\d+)(?:_[\w-]+)?$/i.exec(value);
  return Boolean(match && match[1] === field.id);
}

function renderMetadataDocument(file: CachedFileFormMetadata): RenderedMetadataDocument {
  const lines: string[] = [
    '# Ecode 表单元数据',
    '',
    `- 源文件：\`${file.path}\``,
    `- 远端文件 ID：\`${file.remoteId}\``,
    `- 缓存时间：${file.updatedAt}`,
    '',
  ];
  const targetLines = new Map<string, number>();

  file.contexts.forEach((context, contextIndex) => {
    lines.push(`## ${contextDescription(context)}`, '');
    for (const table of context.tables) {
      targetLines.set(tableTargetKey(contextIndex, table), lines.length);
      lines.push(
        `### ${table.mark} — ${tableDisplayName(table)}`,
        '',
        `数据库表：${table.tableName ? `\`${table.tableName}\`` : '未提供'}`,
        '',
        '| 标识 | 字段名称 | 数据库字段 | 类型 | 显示 | 编辑 | 必填 |',
        '| --- | --- | --- | --- | --- | --- | --- |',
      );
      for (const field of table.fields) {
        targetLines.set(
          fieldTargetKey(contextIndex, table, field),
          lines.length,
        );
        lines.push([
          `\`field${escapeTableCell(field.id)}\``,
          escapeTableCell(field.label),
          field.name ? `\`${escapeTableCell(field.name)}\`` : '',
          escapeTableCell(fieldType(field)),
          booleanDisplay(field.isView),
          booleanDisplay(field.isEdit),
          booleanDisplay(field.isMandatory),
        ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
      }
      lines.push('');
    }
  });
  return { text: lines.join('\n'), targetLines };
}

function contextDescription(context: FormContext): string {
  const ids = [
    context.workflowId ? `workflowId ${context.workflowId}` : undefined,
    context.requestId ? `requestId ${context.requestId}` : undefined,
    context.modeId ? `modeId ${context.modeId}` : undefined,
    context.formId ? `formId ${context.formId}` : undefined,
  ].filter(Boolean);
  const title = context.kind === 'workflow'
    ? '流程表单'
    : context.kind === 'mode' ? '建模表单' : '共享表单';
  return ids.length > 0 ? `${title}（${ids.join('，')}）` : title;
}

function tableDisplayName(table: FormTable): string {
  return table.title || table.tableName || (table.mark === 'main' ? '主表' : table.mark);
}

function fieldType(field: FormField): string {
  const typeNames: Record<string, string> = {
    '1': '单行文本',
    '2': '多行文本',
    '3': '浏览按钮',
    '4': 'Check 框',
    '5': '选择框',
    '6': '附件',
    '7': '特殊字段',
    '9': '位置',
  };
  const values = [
    field.htmlType
      ? typeNames[field.htmlType] ?? `htmlType ${field.htmlType}`
      : undefined,
    field.detailType ? `detailType ${field.detailType}` : undefined,
    field.dbType,
  ].filter(Boolean);
  return values.join(' · ') || '未提供';
}

function fieldDocumentation(
  context: FormContext,
  table: FormTable,
  field: FormField,
): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${field.label}**  \n`);
  markdown.appendMarkdown(`标识：\`field${field.id}\`  \n`);
  if (field.name) {
    markdown.appendMarkdown(`数据库字段：\`${field.name}\`  \n`);
  }
  markdown.appendMarkdown(`表：${table.mark} · ${tableDisplayName(table)}  \n`);
  markdown.appendMarkdown(`类型：${fieldType(field)}  \n`);
  markdown.appendMarkdown(`上下文：${contextDescription(context)}`);
  return markdown;
}

function tableDocumentation(
  context: FormContext,
  table: FormTable,
): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${tableDisplayName(table)}**  \n`);
  markdown.appendMarkdown(`标识：\`${table.mark}\`  \n`);
  if (table.tableName) {
    markdown.appendMarkdown(`数据库表：\`${table.tableName}\`  \n`);
  }
  markdown.appendMarkdown(`字段数：${table.fields.length}  \n`);
  markdown.appendMarkdown(`上下文：${contextDescription(context)}`);
  return markdown;
}

function tableTargetKey(contextIndex: number, table: FormTable): string {
  return `${contextIndex}|${table.mark}`;
}

function fieldTargetKey(
  contextIndex: number,
  table: FormTable,
  field: FormField,
): string {
  return `${tableTargetKey(contextIndex, table)}|${field.id}`;
}

function matchesPrefix(prefix: string, values: Array<string | undefined>): boolean {
  if (!prefix) {
    return true;
  }
  const normalized = prefix.toLowerCase();
  return values.some(value => value?.toLowerCase().includes(normalized));
}

function searchText(values: Array<string | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function tableSortKey(table: FormTable): string {
  return table.mark === 'main'
    ? '0000'
    : table.mark.slice('detail_'.length).padStart(4, '0');
}

function booleanDisplay(value: boolean | undefined): string {
  return value === undefined ? '' : value ? '是' : '否';
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}
