import * as vscode from 'vscode';
import {
  ECODE_COMPONENT_DOCUMENTATION_URL,
  ECODE_COMPONENT_ENTRIES,
  findDirectComponentReferenceAt,
  getComponentBindings,
  getComponentEntries,
  getComponentEntry,
  parseComponentMemberContext,
  parseJsxComponentCompletionContext,
  parseJsxPropContext,
  type EcodeComponentEntry,
  type EcodeComponentNamespace,
  type EcodeComponentProp,
} from './componentKnowledge';
import {
  findEcodeComponentCallAt,
  parseEcodeComponentNameCompletionContext,
  type EcodeComponentNameCompletionContext,
} from './componentRegistry';
import {
  ECODE_API_ENTRIES,
  ECODE_API_OBJECTS,
  ECODE_DOCUMENTATION_URLS,
  findApiObjectReferenceAt,
  findApiReferenceAt,
  getApiEntries,
  getApiEntry,
  getApiObjectInfo,
  parseCallContext,
  parseCompletionContext,
  type EcodeApiEntry,
  type EcodeApiObject,
  type EcodeApiObjectInfo,
} from './knowledge';
import {
  getApiNestedSchemas,
  getComponentNestedSchemas,
  getComponentPropSchema,
  parseApiNestedPropertyContext,
  parseComponentNestedPropertyContext,
  type NestedProperty,
  type NestedSchema,
} from './nestedKnowledge';
import {
  WorkspaceComponentRegistry,
  type RegisteredEcodeComponent,
} from './WorkspaceComponentRegistry';

export const ECODE_DOC_SCHEME = 'ecode-doc';

const LANGUAGE_SELECTOR: vscode.DocumentSelector = [
  { language: 'javascript' },
  { language: 'javascriptreact' },
  { language: 'typescript' },
  { language: 'typescriptreact' },
];

export function registerEcodeLanguageFeatures(): vscode.Disposable[] {
  const registry = new WorkspaceComponentRegistry();
  const provider = new EcodeLanguageProvider(registry);
  const documentation = new EcodeDocumentationProvider();
  return [
    registry,
    vscode.workspace.registerTextDocumentContentProvider(ECODE_DOC_SCHEME, documentation),
    vscode.languages.registerCompletionItemProvider(
      LANGUAGE_SELECTOR,
      provider,
      '.',
      '<',
      ' ',
      '{',
      '[',
      ',',
      '\'',
      '"',
    ),
    vscode.languages.registerHoverProvider(LANGUAGE_SELECTOR, provider),
    vscode.languages.registerDefinitionProvider(LANGUAGE_SELECTOR, provider),
    vscode.languages.registerReferenceProvider(LANGUAGE_SELECTOR, provider),
    vscode.languages.registerSignatureHelpProvider(LANGUAGE_SELECTOR, provider, '(', ','),
    vscode.commands.registerCommand('ecode.searchApiDocumentation', () =>
      searchApiDocumentation()),
    vscode.commands.registerCommand('ecode.openOnlineDocumentation', () =>
      openOnlineDocumentation()),
  ];
}

export class EcodeLanguageProvider implements
  vscode.CompletionItemProvider,
  vscode.HoverProvider,
  vscode.DefinitionProvider,
  vscode.ReferenceProvider,
  vscode.SignatureHelpProvider {
  constructor(
    private readonly componentRegistry: WorkspaceComponentRegistry,
  ) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[] | undefined> {
    if (!isEnabled()) {
      return undefined;
    }
    const lineBeforeCursor = document.lineAt(position.line).text
      .slice(0, position.character);
    const textBeforeCursor = document.getText(
      new vscode.Range(new vscode.Position(0, 0), position),
    ).slice(-4000);
    const componentNameContext =
      parseEcodeComponentNameCompletionContext(textBeforeCursor);
    if (componentNameContext) {
      const registrations = await this.componentRegistry
        .getRegisteredComponents(componentNameContext.appId);
      return registrations
        .filter(component =>
          component.name.toLowerCase()
            .startsWith(componentNameContext.prefix.toLowerCase()))
        .map(component => registeredComponentCompletionItem(
          component,
          componentNameContext,
          document,
          position,
        ));
    }

    const apiContext = parseCompletionContext(lineBeforeCursor);
    if (apiContext) {
      return getApiEntries(apiContext.object)
        .filter(entry => entry.name.startsWith(apiContext.prefix))
        .map(entry => completionItem(entry));
    }

    const memberContext = parseComponentMemberContext(lineBeforeCursor);
    if (memberContext) {
      return getComponentEntries(memberContext.namespace)
        .filter(entry => entry.name.startsWith(memberContext.prefix))
        .map(entry => componentCompletionItem(entry));
    }

    const apiNestedContext = parseApiNestedPropertyContext(textBeforeCursor);
    if (apiNestedContext) {
      return apiNestedContext.properties
        .filter(property =>
          property.name.startsWith(apiNestedContext.prefix)
          && !apiNestedContext.usedProperties.has(property.name))
        .map(nestedPropertyCompletionItem);
    }

    const bindings = getComponentBindings(document.getText());
    const componentNestedContext = parseComponentNestedPropertyContext(
      textBeforeCursor,
      bindings,
    );
    if (componentNestedContext) {
      return componentNestedContext.properties
        .filter(property =>
          property.name.startsWith(componentNestedContext.prefix)
          && !componentNestedContext.usedProperties.has(property.name))
        .map(nestedPropertyCompletionItem);
    }

    const propContext = parseJsxPropContext(textBeforeCursor, bindings);
    if (propContext) {
      return propContext.entry.props
        .filter(prop =>
          prop.name.startsWith(propContext.prefix)
          && !propContext.usedProps.has(prop.name))
        .map(prop => componentPropCompletionItem(prop, propContext.entry));
    }

    const tagContext = parseJsxComponentCompletionContext(textBeforeCursor, bindings);
    return tagContext
      ? tagContext.entries
        .filter(entry => entry.name.startsWith(tagContext.prefix))
        .map(entry => componentCompletionItem(entry))
      : undefined;
  }

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    if (!isEnabled()) {
      return undefined;
    }
    const entry = entryAt(document, position);
    const range = document.getWordRangeAtPosition(position);
    return entry && range
      ? new vscode.Hover(
        entry.kind === 'api'
          ? documentationMarkdown(entry.entry)
          : entry.kind === 'apiObject'
            ? apiObjectDocumentationMarkdown(entry.entry)
            : componentDocumentationMarkdown(entry.entry),
        range,
      )
      : undefined;
  }

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Definition | undefined> {
    if (!isEnabled()) {
      return undefined;
    }
    const componentCall = findEcodeComponentCallAt(
      document.getText(),
      document.offsetAt(position),
    );
    if (componentCall) {
      const definitions = await this.componentRegistry
        .getDefinitions(componentCall);
      return definitions.length > 0 ? definitions : undefined;
    }
    const entry = entryAt(document, position);
    return entry
      ? new vscode.Location(
        entry.kind === 'api'
          ? apiDocUri(entry.entry)
          : entry.kind === 'apiObject'
            ? apiObjectDocUri(entry.entry)
            : componentDocUri(entry.entry),
        new vscode.Position(0, 0),
      )
      : undefined;
  }

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext,
  ): Promise<vscode.Location[] | undefined> {
    if (!isEnabled()) {
      return undefined;
    }
    const componentCall = findEcodeComponentCallAt(
      document.getText(),
      document.offsetAt(position),
    );
    return componentCall
      ? this.componentRegistry.getReferences(
        componentCall,
        context.includeDeclaration,
      )
      : undefined;
  }

  provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.SignatureHelp | undefined {
    if (!isEnabled()) {
      return undefined;
    }
    const call = parseCallContext(
      document.getText(new vscode.Range(new vscode.Position(0, 0), position)).slice(-1000),
    );
    if (!call) {
      return undefined;
    }
    const help = new vscode.SignatureHelp();
    const signature = new vscode.SignatureInformation(
      `${call.entry.object}.${call.entry.signature}`,
      call.entry.description,
    );
    signature.parameters = call.entry.parameters.map(parameter =>
      new vscode.ParameterInformation(parameter.label, parameter.description));
    help.signatures = [signature];
    help.activeSignature = 0;
    help.activeParameter = Math.min(
      call.activeParameter,
      Math.max(signature.parameters.length - 1, 0),
    );
    return help;
  }
}

export class EcodeDocumentationProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    const parts = uri.path.split('/').filter(Boolean);
    if (parts[0] === 'component') {
      const namespace = parts[1] as EcodeComponentNamespace | undefined;
      const name = parts[2]?.replace(/\.md$/, '');
      const component = namespace && name
        ? getComponentEntry(namespace, name)
        : undefined;
      return component
        ? componentDocument(component)
        : '# Ecode 组件\n\n未找到对应的内置组件文档。';
    }
    const object = parts[0] as EcodeApiObject | undefined;
    const name = parts[1]?.replace(/\.md$/, '');
    const objectInfo = object ? getApiObjectInfo(object) : undefined;
    if (objectInfo && name === 'index') {
      return apiObjectDocument(objectInfo);
    }
    const entry = object && name ? getApiEntry(object, name) : undefined;
    if (!entry) {
      return '# Ecode API\n\n未找到对应的内置文档。';
    }
    return [
      `# ${entry.object}.${entry.name}`,
      '',
      '```typescript',
      `${entry.object}.${entry.signature}`,
      '```',
      '',
      entry.description,
      '',
      ...parameterDocumentationLines(entry, true),
      '',
      `来源：[泛微官方在线文档](${entry.officialUrl})`,
      '',
      '> 内置说明用于编码时快速查阅；版本、KB 与端能力限制请以在线文档为准。',
    ].join('\n');
  }
}

function completionItem(entry: EcodeApiEntry): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    entry.name,
    entry.kind === 'method'
      ? vscode.CompletionItemKind.Method
      : vscode.CompletionItemKind.Property,
  );
  item.detail = `${entry.object}.${entry.signature}`;
  item.documentation = documentationMarkdown(entry);
  item.insertText = new vscode.SnippetString(entry.snippet);
  item.sortText = entry.kind === 'method' ? `0-${entry.name}` : `1-${entry.name}`;
  if (entry.kind === 'method') {
    item.command = {
      command: 'editor.action.triggerParameterHints',
      title: '显示参数提示',
    };
  }
  return item;
}

function registeredComponentCompletionItem(
  component: RegisteredEcodeComponent,
  context: EcodeComponentNameCompletionContext,
  document: vscode.TextDocument,
  position: vscode.Position,
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    component.name,
    vscode.CompletionItemKind.Reference,
  );
  item.detail =
    `ecodeSDK.setCom('${component.appId}', '${component.name}', …)`
    + ` · ${component.definitions.length} 处注册`;
  const definitionPaths = component.definitions
    .map(definition => vscode.workspace.asRelativePath(definition.uri, false));
  item.documentation = new vscode.MarkdownString(
    `由工作区中的 \`ecodeSDK.setCom\` 注册。\n\n`
    + `定义：${definitionPaths.map(path => `\`${path}\``).join('、')}`,
  );
  const nextCharacter = document.lineAt(position.line).text[position.character];
  item.insertText = context.hasOpeningQuote
    ? `${component.name}${nextCharacter === context.quote ? '' : context.quote ?? ''}`
    : `'${component.name}'`;
  item.range = new vscode.Range(
    position.line,
    Math.max(0, position.character - context.replaceLength),
    position.line,
    position.character,
  );
  item.filterText = component.name;
  item.sortText = `0-${component.name}`;
  return item;
}

function componentCompletionItem(entry: EcodeComponentEntry): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    entry.name,
    vscode.CompletionItemKind.Class,
  );
  item.detail = `${entry.namespace}.${entry.name} · ${entry.title}`;
  item.documentation = componentDocumentationMarkdown(entry);
  item.insertText = entry.name;
  item.sortText = `0-${entry.name}`;
  return item;
}

function componentPropCompletionItem(
  prop: EcodeComponentProp,
  entry: EcodeComponentEntry,
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    prop.name,
    vscode.CompletionItemKind.Property,
  );
  item.detail = `${prop.type}${prop.required ? ' · 必填' : ''}`;
  item.documentation = new vscode.MarkdownString(
    `${prop.description}${prop.defaultValue ? `\n\n默认值：\`${prop.defaultValue}\`` : ''}`,
  );
  item.insertText = new vscode.SnippetString(
    componentPropSnippet(prop, getComponentPropSchema(entry, prop.name)),
  );
  item.sortText = `${prop.required ? '0' : '1'}-${prop.name}`;
  item.command = {
    command: 'editor.action.triggerSuggest',
    title: `继续填写 ${entry.name} props`,
  };
  return item;
}

function nestedPropertyCompletionItem(
  property: NestedProperty,
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    property.name,
    vscode.CompletionItemKind.Field,
  );
  item.detail = `${property.type}${property.required ? ' · 必填' : ''}`;
  item.documentation = new vscode.MarkdownString(
    `${property.description}`
    + `${property.defaultValue ? `\n\n默认值：\`${property.defaultValue}\`` : ''}`,
  );
  item.insertText = new vscode.SnippetString(
    property.snippet ?? nestedPropertySnippet(property),
  );
  item.sortText = `${property.required ? '0' : '1'}-${property.name}`;
  return item;
}

function documentationMarkdown(entry: EcodeApiEntry): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.appendCodeblock(`${entry.object}.${entry.signature}`, 'typescript');
  markdown.appendMarkdown(`\n${entry.description}\n\n`);
  markdown.appendMarkdown(parameterDocumentationLines(entry).join('\n'));
  markdown.appendMarkdown('\n\n');
  markdown.appendMarkdown(`[打开泛微官方文档](${entry.officialUrl})`);
  return markdown;
}

function apiObjectDocumentationMarkdown(
  info: EcodeApiObjectInfo,
): vscode.MarkdownString {
  const entries = getApiEntries(info.object);
  const methodCount = entries.filter(entry => entry.kind === 'method').length;
  const propertyCount = entries.length - methodCount;
  const markdown = new vscode.MarkdownString();
  markdown.appendCodeblock(`const { /* API */ } = ${info.object};`, 'typescript');
  markdown.appendMarkdown(`\n**${info.title}**\n\n${info.description}\n\n`);
  markdown.appendMarkdown(
    `内置索引包含 **${methodCount} 个方法**`
    + `${propertyCount > 0 ? `、**${propertyCount} 个属性或常量**` : ''}。`
    + '\n\n按 F12 或 Ctrl+单击查看全部成员、签名和说明。',
  );
  markdown.appendMarkdown(`\n\n[打开泛微官方文档](${info.officialUrl})`);
  return markdown;
}

function componentDocumentationMarkdown(
  entry: EcodeComponentEntry,
): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.appendCodeblock(
    `import { ${entry.name} } from '${entry.namespace}';`,
    'typescript',
  );
  markdown.appendMarkdown(`\n**${entry.title}**\n\n${entry.description}\n\n`);
  const visibleProps = entry.props.slice(0, 12);
  if (visibleProps.length > 0) {
    markdown.appendMarkdown(componentPropDocumentationLines(visibleProps).join('\n'));
    if (entry.props.length > visibleProps.length) {
      markdown.appendMarkdown(`\n\n另有 ${entry.props.length - visibleProps.length} 个参数，按 F12 查看完整说明。`);
    }
    markdown.appendMarkdown('\n\n');
  }
  markdown.appendMarkdown(`[打开泛微 PC 组件库](${entry.officialUrl})`);
  return markdown;
}

function entryAt(
  document: vscode.TextDocument,
  position: vscode.Position,
):
  | { kind: 'api'; entry: EcodeApiEntry }
  | { kind: 'apiObject'; entry: EcodeApiObjectInfo }
  | { kind: 'component'; entry: EcodeComponentEntry }
  | undefined {
  const line = document.lineAt(position.line);
  const offset = Math.min(position.character, line.text.length);
  const api = findApiReferenceAt(line.text, offset);
  if (api) {
    return { kind: 'api', entry: api };
  }
  const apiObject = findApiObjectReferenceAt(line.text, offset);
  if (apiObject) {
    return { kind: 'apiObject', entry: apiObject };
  }
  const directComponent = findDirectComponentReferenceAt(line.text, offset);
  if (directComponent) {
    return { kind: 'component', entry: directComponent };
  }
  const wordRange = document.getWordRangeAtPosition(position);
  if (!wordRange) {
    return undefined;
  }
  const component = getComponentBindings(document.getText())
    .get(document.getText(wordRange));
  return component
    ? { kind: 'component', entry: component }
    : undefined;
}

function apiDocUri(entry: EcodeApiEntry): vscode.Uri {
  return vscode.Uri.parse(
    `${ECODE_DOC_SCHEME}:/${entry.object}/${entry.name}.md`,
  );
}

function apiObjectDocUri(info: EcodeApiObjectInfo): vscode.Uri {
  return vscode.Uri.parse(
    `${ECODE_DOC_SCHEME}:/${info.object}/index.md`,
  );
}

function componentDocUri(entry: EcodeComponentEntry): vscode.Uri {
  return vscode.Uri.parse(
    `${ECODE_DOC_SCHEME}:/component/${entry.namespace}/${entry.name}.md`,
  );
}

function parameterDocumentationLines(
  entry: EcodeApiEntry,
  includeNested = false,
): string[] {
  if (entry.kind !== 'method') {
    return [];
  }
  if (entry.parameters.length === 0) {
    return ['**参数**：无'];
  }
  const lines = [
    '**参数说明**',
    '',
    '| 参数 | 类型 | 必填 | 说明 |',
    '| --- | --- | --- | --- |',
    ...entry.parameters.map(parameter =>
      `| \`${parameter.name}\` | \`${escapeTableCell(parameter.type)}\` | `
      + `${parameter.required ? '是' : '否'} | ${escapeTableCell(parameter.description)} |`),
  ];
  if (includeNested) {
    for (const nested of getApiNestedSchemas(entry)) {
      lines.push(
        '',
        ...nestedSchemaDocumentationLines(nested.parameterName, nested.schema),
      );
    }
  }
  return lines;
}

function componentPropDocumentationLines(
  props: readonly EcodeComponentProp[],
): string[] {
  if (props.length === 0) {
    return ['**Props 参数**：官方页面未提供参数表。'];
  }
  return [
    '**Props 参数说明**',
    '',
    '| 参数 | 类型 | 必填 | 默认值 | 说明 |',
    '| --- | --- | --- | --- | --- |',
    ...props.map(prop =>
      `| \`${prop.name}\` | \`${escapeTableCell(prop.type)}\` | `
      + `${prop.required ? '是' : '否'} | `
      + `${prop.defaultValue ? `\`${escapeTableCell(prop.defaultValue)}\`` : '-'} | `
      + `${escapeTableCell(prop.description)} |`),
  ];
}

function componentDocument(entry: EcodeComponentEntry): string {
  const nestedLines = getComponentNestedSchemas(entry)
    .flatMap(nested => [
      '',
      ...nestedSchemaDocumentationLines(nested.propName, nested.schema),
    ]);
  return [
    `# ${entry.namespace}.${entry.name}`,
    '',
    `**${entry.title}**`,
    '',
    entry.description,
    '',
    '```typescript',
    `import { ${entry.name} } from '${entry.namespace}';`,
    '```',
    '',
    ...componentPropDocumentationLines(entry.props),
    ...nestedLines,
    '',
    `来源：[泛微 PC 组件库](${entry.officialUrl})`,
    '',
    '> 组件库会随 Ecology 9 / KB 版本变化；参数、示例与兼容范围请以在线文档为准。',
  ].join('\n');
}

function apiObjectDocument(info: EcodeApiObjectInfo): string {
  const entries = getApiEntries(info.object);
  const methods = entries.filter(entry => entry.kind === 'method');
  const properties = entries.filter(entry => entry.kind === 'property');
  return [
    `# ${info.object}`,
    '',
    `**${info.title}**`,
    '',
    info.description,
    '',
    `共收录 ${methods.length} 个方法`
    + `${properties.length > 0 ? `、${properties.length} 个属性或常量` : ''}。`,
    '',
    '## 方法',
    '',
    '| 方法 | 签名 | 说明 |',
    '| --- | --- | --- |',
    ...methods.map(entry =>
      `| [\`${entry.name}\`](${apiDocUri(entry).toString()}) | `
      + `\`${escapeTableCell(entry.signature)}\` | `
      + `${escapeTableCell(entry.description)} |`),
    ...(properties.length > 0
      ? [
        '',
        '## 属性与常量',
        '',
        '| 名称 | 类型或签名 | 说明 |',
        '| --- | --- | --- |',
        ...properties.map(entry =>
          `| [\`${entry.name}\`](${apiDocUri(entry).toString()}) | `
          + `\`${escapeTableCell(entry.signature)}\` | `
          + `${escapeTableCell(entry.description)} |`),
      ]
      : []),
    '',
    `来源：[泛微官方在线文档](${info.officialUrl})`,
    '',
    '> 单击成员链接或直接在源码中 Ctrl+单击成员名，可查看参数及二级参数说明。',
  ].join('\n');
}

function nestedSchemaDocumentationLines(
  path: string,
  schema: NestedSchema,
): string[] {
  const properties = schema.properties ?? schema.itemProperties ?? [];
  if (properties.length === 0) {
    return [];
  }
  const lines = [
    `**\`${path}\` 二级参数**`,
    '',
    '| 参数 | 类型 | 必填 | 默认值 | 说明 |',
    '| --- | --- | --- | --- | --- |',
    ...properties.map(property =>
      `| \`${property.name}\` | \`${escapeTableCell(property.type)}\` | `
      + `${property.required ? '是' : '否'} | `
      + `${property.defaultValue ? `\`${escapeTableCell(property.defaultValue)}\`` : '-'} | `
      + `${escapeTableCell(property.description)} |`),
  ];
  for (const property of properties) {
    const childSchema = property.properties
      ? { properties: property.properties }
      : property.itemProperties
        ? { itemProperties: property.itemProperties }
        : undefined;
    if (childSchema) {
      lines.push(
        '',
        ...nestedSchemaDocumentationLines(`${path}.${property.name}`, childSchema),
      );
    }
  }
  return lines;
}

function componentPropSnippet(
  prop: EcodeComponentProp,
  nestedSchema?: NestedSchema,
): string {
  if (nestedSchema?.itemProperties) {
    return `${prop.name}={[\n  {\n    $0\n  },\n]}`;
  }
  if (nestedSchema?.properties) {
    return `${prop.name}={{\n  $0\n}}`;
  }
  const normalizedType = prop.type.toLowerCase();
  if (/bool/.test(normalizedType)) {
    return `${prop.name}={\${1:true}}`;
  }
  if (/function|func|\(.*\)\s*=>/.test(normalizedType) || /^on[A-Z]/.test(prop.name)) {
    return `${prop.name}={\${1:value} => {\n  $0\n}}`;
  }
  if (/string|char|text/.test(normalizedType)) {
    return `${prop.name}="\${1:value}"`;
  }
  return `${prop.name}={\${1:value}}`;
}

function nestedPropertySnippet(property: NestedProperty): string {
  if (property.properties) {
    return `${property.name}: {\n  $0\n}`;
  }
  if (property.itemProperties) {
    return `${property.name}: [\n  {\n    $0\n  },\n]`;
  }
  const normalizedType = property.type.toLowerCase();
  if (/bool/.test(normalizedType)) {
    return `${property.name}: \${1:true}`;
  }
  if (/function|=>|\(.*\)\s*=>/.test(normalizedType)) {
    return `${property.name}: \${1:(...args) => {\n  $0\n}}`;
  }
  if (/string|char|text/.test(normalizedType)) {
    return `${property.name}: '\${1:value}'`;
  }
  return `${property.name}: \${1:value}`;
}

function escapeTableCell(value: string): string {
  return value
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
}

async function searchApiDocumentation(): Promise<void> {
  const selected = await vscode.window.showQuickPick(
    [
      ...ECODE_API_OBJECTS.map(info => {
        const entries = getApiEntries(info.object);
        const methods = entries.filter(entry => entry.kind === 'method').length;
        return {
          label: info.object,
          description: `${info.title} · ${methods} 个方法`,
          detail: info.description,
          uri: apiObjectDocUri(info),
        };
      }),
      ...ECODE_API_ENTRIES.map(entry => ({
        label: `${entry.object}.${entry.name}`,
        description: entry.signature,
        detail: entry.description,
        uri: apiDocUri(entry),
      })),
      ...ECODE_COMPONENT_ENTRIES.map(entry => ({
        label: `${entry.namespace}.${entry.name}`,
        description: `${entry.title} · ${entry.props.length} 个 props`,
        detail: entry.description,
        uri: componentDocUri(entry),
      })),
    ],
    {
      title: '搜索 Ecode API 与 PC 组件',
      matchOnDescription: true,
      matchOnDetail: true,
      placeHolder: '输入对象名、方法名、组件名、参数或功能描述',
    },
  );
  if (!selected) {
    return;
  }
  const document = await vscode.workspace.openTextDocument(selected.uri);
  await vscode.languages.setTextDocumentLanguage(document, 'markdown');
  await vscode.window.showTextDocument(document, { preview: true });
}

async function openOnlineDocumentation(): Promise<void> {
  const choices: Array<{
    label: string;
    description: string;
    url: string;
  }> = [
    {
      label: 'ecodeSDK 使用说明',
      description: '页面扩展、组件复写与路由注册',
      url: ECODE_DOCUMENTATION_URLS.ecodeSDK,
    },
    {
      label: 'ModeForm / ModeList API',
      description: '建模卡片与查询列表',
      url: ECODE_DOCUMENTATION_URLS.ModeForm,
    },
    {
      label: 'WfForm API',
      description: '流程表单前端接口',
      url: ECODE_DOCUMENTATION_URLS.WfForm,
    },
    {
      label: 'PC 组件库',
      description: 'ecCom 与内置 antd 组件、props 及示例',
      url: ECODE_COMPONENT_DOCUMENTATION_URL,
    },
  ];
  const selected = await vscode.window.showQuickPick(choices, {
    title: '打开泛微官方文档',
  });
  if (selected) {
    await vscode.env.openExternal(vscode.Uri.parse(selected.url));
  }
}

function isEnabled(): boolean {
  return vscode.workspace.getConfiguration('ecode').get('intelligence.enabled', true);
}
