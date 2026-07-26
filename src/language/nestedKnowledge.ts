import {
  getComponentEntry,
  type EcodeComponentEntry,
  type EcodeComponentNamespace,
} from './componentKnowledge';
import {
  parseCallContext,
  type EcodeApiEntry,
} from './knowledge';

export interface NestedProperty {
  name: string;
  type: string;
  required: boolean;
  description: string;
  defaultValue?: string;
  snippet?: string;
  properties?: readonly NestedProperty[];
  itemProperties?: readonly NestedProperty[];
}

export interface NestedSchema {
  properties?: readonly NestedProperty[];
  itemProperties?: readonly NestedProperty[];
}

export interface NestedPropertyCompletionContext {
  properties: readonly NestedProperty[];
  prefix: string;
  usedProperties: ReadonlySet<string>;
}

const SPECIAL_OBJECT_ITEM: readonly NestedProperty[] = [
  property('id', 'string', true, '浏览按钮选中项 ID。'),
  property('name', 'string', true, '浏览按钮选中项显示名称。'),
];

const VALUE_INFO: readonly NestedProperty[] = [
  property('value', 'string', true, '字段真实值；多值通常使用逗号分隔。'),
  arrayProperty(
    'specialobj',
    false,
    '浏览按钮选中项数组；浏览按钮赋值时与 value 同时提供。',
    SPECIAL_OBJECT_ITEM,
  ),
  property(
    'showhtml',
    'string',
    false,
    '只读单行文本的显示值，可与实际入库 value 不同。',
  ),
];

const FIELD_ATTRIBUTE: readonly NestedProperty[] = [
  property(
    'viewAttr',
    'number | string',
    true,
    '字段状态：1 只读、2 可编辑、3 必填。',
    '2',
  ),
];

const CONFIRM_INFO: readonly NestedProperty[] = [
  property('title', 'string', false, '确认框标题，仅 PC 端有效。'),
  property('okText', 'string', false, '确认按钮显示文本。'),
  property('cancelText', 'string', false, '取消按钮显示文本。'),
];

const OVERWRITE_OPTION: readonly NestedProperty[] = [
  property(
    'fn',
    'function',
    true,
    '组件复写钩子；props 复写接收 newProps，组件重写接收 Com 和 newProps。',
    undefined,
    'fn: ${1:(newProps) => {\n  $0\n  return newProps;\n}}',
  ),
  property('order', 'integer', false, '同一组件存在多个复写时的执行顺序。', '0'),
  property('desc', 'string', false, '复写用途说明，便于调试定位。', '\'\''),
];

const DIALOG_PROPS: readonly NestedProperty[] = [
  property('title', 'string', true, 'Dialog 标题。'),
  property('url', 'string', true, 'Dialog 内嵌 JSP 或页面地址。'),
  objectProperty(
    'style',
    false,
    'Dialog 样式。',
    [
      property('width', 'number | string', false, 'Dialog 宽度。'),
      property('height', 'number | string', false, 'Dialog 高度。'),
    ],
  ),
  property(
    'icon',
    'string',
    false,
    'Dialog 顶部标题图标 className。',
    '\'icon-coms-ModelingEngine\'',
  ),
  property(
    'iconBgcolor',
    'string',
    false,
    'Dialog 顶部标题图标背景色。',
    '\'#96358a\'',
  ),
  property(
    'iconFontColor',
    'string',
    false,
    'Dialog 顶部标题图标颜色。',
    '\'#fff\'',
  ),
];

const DIALOG_BUTTON: readonly NestedProperty[] = [
  property('btnname', 'string', true, '按钮显示名称。'),
  property(
    'callfun',
    'string',
    true,
    '按钮回调方法名；外部代码块方法通常使用 base. 前缀。',
  ),
];

const ECODE_ASYNC_COMPONENT: readonly NestedProperty[] = [
  property('appId', 'string', true, 'Ecode 发布目录 appId。'),
  property('name', 'string', true, '需要加载的模块名称。'),
  property('isPage', 'boolean', false, '是否作为路由页面加载。', 'false'),
  property('noCss', 'boolean', false, '是否禁止单独加载 CSS。', 'true'),
  objectProperty('props', false, '传给异步组件的 props。', []),
  objectProperty('params', false, '传给移动端异步组件的附加参数。', []),
];

const ECODE_CHECK_PATH: readonly NestedProperty[] = [
  property('path', 'string', true, '需要匹配的 PC 路由地址。'),
  property('appId', 'string', true, '路由页面所属 Ecode appId。'),
  property('name', 'string', true, '路由页面模块名称。'),
  property('node', 'string', false, '需要渲染的路由节点。'),
  property('Route', 'object', false, 'React Router 的 Route 对象。'),
  property('nextState', 'object', false, 'React Router 当前 nextState。'),
];

const BROWSER_TAB_BROWSER_PROPS: readonly NestedProperty[] = [
  objectProperty('dataParams', false, '当前 tab 的列表请求参数。', []),
  objectProperty('conditionDataParams', false, '当前 tab 的查询条件请求参数。', []),
  objectProperty('completeParams', false, '当前 tab 的联想搜索请求参数。', []),
  property('hasAdvanceSerach', 'boolean', false, '当前 tab 是否显示高级搜索。'),
  property('pageSize', 'number', false, '当前 tab 每页数据条数。'),
  property(
    'clickNameExpandFirst',
    'boolean',
    false,
    '树形 tab 点击名称时是否优先展开节点。',
  ),
];

const BROWSER_TAB: readonly NestedProperty[] = [
  property('name', 'string', true, 'Tab 显示名称。'),
  property('key', 'string', true, 'Tab 唯一标识。'),
  property('selected', 'boolean', false, '是否默认选中当前 tab。', 'false'),
  property('isSearch', 'boolean', false, '当前 tab 是否支持搜索。', 'true'),
  property('showOrder', 'number', false, 'Tab 显示顺序。'),
  objectProperty('dataParams', false, '当前 tab 的列表请求参数。', []),
  objectProperty(
    'browserProps',
    false,
    '当前 tab 覆盖的浏览按钮配置。',
    BROWSER_TAB_BROWSER_PROPS,
  ),
];

const TABLE_COLUMN: readonly NestedProperty[] = [
  property('title', 'React.Node', true, '列标题。'),
  property(
    'dataIndex',
    'string',
    true,
    '列数据在行记录中对应的 key，支持 a.b.c 嵌套路径。',
  ),
  property('key', 'string', false, 'React 列 key，建议显式设置。'),
  property(
    'render',
    '(text, record, index) => React.Node',
    false,
    '自定义单元格渲染函数。',
    undefined,
    'render: ${1:(text, record, index) => {\n  $0\n  return text;\n}}',
  ),
  arrayProperty('filters', false, '表头筛选菜单项。', [
    property('text', 'string', true, '筛选项显示文本。'),
    property('value', 'string', true, '筛选项值。'),
  ]),
  property('onFilter', '(value, record) => boolean', false, '本地筛选函数。'),
  property('filterMultiple', 'boolean', false, '筛选菜单是否允许多选。', 'true'),
  property('filterDropdown', 'React.Element', false, '自定义筛选菜单。'),
  property(
    'filterDropdownVisible',
    'boolean',
    false,
    '控制自定义筛选菜单是否可见。',
  ),
  property(
    'onFilterDropdownVisibleChange',
    '(visible) => void',
    false,
    '筛选菜单可见状态变化回调。',
  ),
  property('sorter', 'function | boolean', false, '本地排序函数；服务端排序可设为 true。'),
  property('colSpan', 'number', false, '表头列合并数；0 表示不渲染。'),
  property('width', 'string | number', false, '列宽度。'),
  property('className', 'string', false, '列 className。'),
  property(
    'fixed',
    'boolean | \'left\' | \'right\'',
    false,
    '固定列位置。',
    'false',
  ),
  property('filteredValue', 'unknown[]', false, '受控筛选值。'),
  property(
    'sortOrder',
    '\'ascend\' | \'descend\' | false',
    false,
    '受控排序状态。',
  ),
  property(
    'isHtml',
    'boolean',
    false,
    'WeaTable 扩展：是否按 HTML 渲染当前列。',
    'false',
  ),
];

const TABLE_ROW_SELECTION: readonly NestedProperty[] = [
  property('type', '\'checkbox\' | \'radio\'', false, '行选择类型。', '\'checkbox\''),
  property('selectedRowKeys', 'unknown[]', false, '受控选中行 key 数组。', '[]'),
  property('getCheckboxProps', '(record) => object', false, '设置行选择框属性。'),
  property(
    'onChange',
    '(selectedRowKeys, selectedRows) => void',
    false,
    '选中项变化回调。',
  ),
  property(
    'onSelect',
    '(record, selected, selectedRows) => void',
    false,
    '手动选择或取消单行时的回调。',
  ),
  property(
    'onSelectAll',
    '(selected, selectedRows, changeRows) => void',
    false,
    '手动全选或取消全选时的回调。',
  ),
];

const API_PARAMETER_SCHEMAS = new Map<string, NestedSchema>([
  ['ecodeSDK.load.options', schema([
    property('id', 'string', true, 'Ecode 发布目录 appId。'),
    property('noCss', 'boolean', false, '是否禁止单独加载 CSS。', 'true'),
    property(
      'cb',
      '() => void',
      false,
      'JavaScript 与 CSS 加载完成后的回调。',
      undefined,
      'cb: ${1:() => {\n  $0\n}}',
    ),
  ])],
  ['ecodeSDK.getAsyncCom.options', schema(ECODE_ASYNC_COMPONENT)],
  ['ecodeSDK.checkPath.options', schema(ECODE_CHECK_PATH)],
  ['ecodeSDK.checkMobilePath.options', schema(ECODE_CHECK_PATH)],
  ['ecodeSDK.overwritePropsFnQueueMapSet.options', schema(OVERWRITE_OPTION)],
  ['ecodeSDK.overwriteMobilePropsFnQueueMapSet.options', schema(OVERWRITE_OPTION)],
  ['ecodeSDK.overwriteClassFnQueueMapSet.options', schema(OVERWRITE_OPTION)],
  ['ecodeSDK.overwriteMobileClassFnQueueMapSet.options', schema(OVERWRITE_OPTION)],
  ['ModeForm.changeFieldValue.valueInfo', schema(VALUE_INFO)],
  ['ModeForm.changeSingleField.valueInfo', schema(VALUE_INFO)],
  ['ModeForm.changeSingleField.attrInfo', schema(FIELD_ATTRIBUTE)],
  ['ModeForm.showConfirm.otherInfo', schema(CONFIRM_INFO)],
  ['ModeForm.openCustomDialog.props', schema(DIALOG_PROPS)],
  ['ModeForm.openCustomDialog.buttons', arraySchema(DIALOG_BUTTON)],
  ['ModeForm.addDetailRow.initialValues', dynamicFieldSchema()],
  ['ModeForm.changeMoreField.changeDatas', dynamicFieldSchema()],
  ['ModeForm.changeMoreField.changeVariable', dynamicFieldSchema(FIELD_ATTRIBUTE)],
  ['WfForm.changeFieldValue.valueInfo', schema(VALUE_INFO)],
  ['WfForm.changeSingleField.valueInfo', schema(VALUE_INFO)],
  ['WfForm.changeSingleField.attrInfo', schema(FIELD_ATTRIBUTE)],
  ['WfForm.showConfirm.otherInfo', schema(CONFIRM_INFO)],
  ['WfForm.addDetailRow.initialValues', dynamicFieldSchema()],
  ['WfForm.changeMoreField.changeDatas', dynamicFieldSchema()],
  ['WfForm.changeMoreField.changeVariable', dynamicFieldSchema(FIELD_ATTRIBUTE)],
]);

const COMPONENT_PROP_SCHEMAS = new Map<string, NestedSchema>([
  ['ecCom.WeaBrowser.tabs', arraySchema(BROWSER_TAB)],
  ['ecCom.WeaBrowser.extendTabs', arraySchema(BROWSER_TAB)],
  ['ecCom.WeaTable.columns', arraySchema(TABLE_COLUMN)],
  ['ecCom.WeaTable.rowSelection', schema(TABLE_ROW_SELECTION)],
  ['antd.Table.columns', arraySchema(TABLE_COLUMN)],
  ['antd.Table.rowSelection', schema(TABLE_ROW_SELECTION)],
]);

export function getApiParameterSchema(
  entry: EcodeApiEntry,
  parameterName: string,
): NestedSchema | undefined {
  return API_PARAMETER_SCHEMAS.get(
    `${entry.object}.${entry.name}.${parameterName}`,
  );
}

export function getComponentPropSchema(
  entry: EcodeComponentEntry,
  propName: string,
): NestedSchema | undefined {
  return COMPONENT_PROP_SCHEMAS.get(
    `${entry.namespace}.${entry.name}.${propName}`,
  );
}

export function getApiNestedSchemas(
  entry: EcodeApiEntry,
): ReadonlyArray<{ parameterName: string; schema: NestedSchema }> {
  return entry.parameters
    .map(parameter => ({
      parameterName: parameter.name,
      schema: getApiParameterSchema(entry, parameter.name),
    }))
    .filter((item): item is { parameterName: string; schema: NestedSchema } =>
      item.schema !== undefined);
}

export function getComponentNestedSchemas(
  entry: EcodeComponentEntry,
): ReadonlyArray<{ propName: string; schema: NestedSchema }> {
  return entry.props
    .map(prop => ({
      propName: prop.name,
      schema: getComponentPropSchema(entry, prop.name),
    }))
    .filter((item): item is { propName: string; schema: NestedSchema } =>
      item.schema !== undefined);
}

export function parseApiNestedPropertyContext(
  textBeforeCursor: string,
): NestedPropertyCompletionContext | undefined {
  const call = parseCallContext(textBeforeCursor);
  if (!call) {
    return undefined;
  }
  const parameter = call.entry.parameters[call.activeParameter];
  const parameterSchema = parameter
    ? getApiParameterSchema(call.entry, parameter.name)
    : undefined;
  return parameterSchema
    ? parseNestedPropertyContext(call.activeArgumentText, parameterSchema)
    : undefined;
}

export function parseComponentNestedPropertyContext(
  textBeforeCursor: string,
  bindings: ReadonlyMap<string, EcodeComponentEntry>,
): NestedPropertyCompletionContext | undefined {
  const tagStart = textBeforeCursor.lastIndexOf('<');
  if (tagStart < 0) {
    return undefined;
  }
  const fragment = textBeforeCursor.slice(tagStart);
  const tag =
    /^<(?:(?:window\.)?(ecCom|antd)\.)?([A-Za-z_$][\w$]*)([\s\S]*)$/
      .exec(fragment);
  if (!tag) {
    return undefined;
  }
  const entry = tag[1]
    ? getComponentEntry(tag[1] as EcodeComponentNamespace, tag[2])
    : bindings.get(tag[2]);
  if (!entry) {
    return undefined;
  }

  const propPattern = /([A-Za-z_$][\w$]*)\s*=\s*\{/g;
  let match: RegExpExecArray | null;
  let result: NestedPropertyCompletionContext | undefined;
  while ((match = propPattern.exec(tag[3])) !== null) {
    const propSchema = getComponentPropSchema(entry, match[1]);
    if (!propSchema) {
      continue;
    }
    const valueBeforeCursor = tag[3].slice(match.index + match[0].length);
    const context = parseNestedPropertyContext(valueBeforeCursor, propSchema);
    if (context) {
      result = context;
    }
  }
  return result;
}

export function parseNestedPropertyContext(
  valueBeforeCursor: string,
  rootSchema: NestedSchema,
): NestedPropertyCompletionContext | undefined {
  interface Frame {
    kind: 'object' | 'array' | 'parenthesis';
    schema?: NestedSchema;
    currentProperty?: NestedProperty;
    segmentStart: number;
    usedProperties: Set<string>;
  }

  const frames: Frame[] = [];
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < valueBeforeCursor.length; index += 1) {
    const character = valueBeforeCursor[index];
    const next = valueBeforeCursor[index + 1];
    if (lineComment) {
      if (character === '\n') {
        lineComment = false;
      }
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if ('\'"`'.includes(character)) {
      quote = character;
      continue;
    }

    if (character === '{') {
      const parent = frames.at(-1);
      const nestedSchema = frames.length === 0
        ? rootSchema
        : parent?.kind === 'array'
          ? parent.schema?.itemProperties
            ? arrayItemObjectSchema(parent.schema)
            : undefined
          : parent?.currentProperty?.properties
            ? schema(parent.currentProperty.properties)
            : undefined;
      frames.push({
        kind: 'object',
        schema: nestedSchema,
        segmentStart: index + 1,
        usedProperties: new Set(),
      });
      continue;
    }
    if (character === '[') {
      const parent = frames.at(-1);
      const nestedSchema = frames.length === 0
        ? rootSchema
        : parent?.currentProperty?.itemProperties
          ? arraySchema(parent.currentProperty.itemProperties)
          : undefined;
      frames.push({
        kind: 'array',
        schema: nestedSchema,
        segmentStart: index + 1,
        usedProperties: new Set(),
      });
      continue;
    }
    if (character === '(') {
      frames.push({
        kind: 'parenthesis',
        segmentStart: index + 1,
        usedProperties: new Set(),
      });
      continue;
    }
    if (character === '}' || character === ']' || character === ')') {
      frames.pop();
      continue;
    }

    const current = frames.at(-1);
    if (!current) {
      continue;
    }
    if (character === ':' && current.kind === 'object') {
      const segment = valueBeforeCursor.slice(current.segmentStart, index);
      const key = /(?:^|,)\s*(?:['"])?([A-Za-z_$][\w$]*)(?:['"])?\s*$/
        .exec(segment)?.[1];
      if (key) {
        current.usedProperties.add(key);
        current.currentProperty = current.schema?.properties
          ?.find(propertyDefinition => propertyDefinition.name === key);
      }
      continue;
    }
    if (character === ',' && current.kind === 'object') {
      current.currentProperty = undefined;
      current.segmentStart = index + 1;
    }
  }

  const current = frames.at(-1);
  if (!current || current.kind !== 'object' || !current.schema?.properties) {
    return undefined;
  }
  const segment = valueBeforeCursor.slice(current.segmentStart);
  if (segment.includes(':')) {
    return undefined;
  }
  const prefix = /^\s*([A-Za-z_$][\w$]*)?\s*$/.exec(segment)?.[1];
  if (prefix === undefined && segment.trim() !== '') {
    return undefined;
  }
  return {
    properties: current.schema.properties,
    prefix: prefix ?? '',
    usedProperties: current.usedProperties,
  };
}

function property(
  name: string,
  type: string,
  required: boolean,
  description: string,
  defaultValue?: string,
  snippet?: string,
): NestedProperty {
  return { name, type, required, description, defaultValue, snippet };
}

function objectProperty(
  name: string,
  required: boolean,
  description: string,
  properties: readonly NestedProperty[],
): NestedProperty {
  return {
    name,
    type: 'object',
    required,
    description,
    properties,
  };
}

function arrayProperty(
  name: string,
  required: boolean,
  description: string,
  itemProperties: readonly NestedProperty[],
): NestedProperty {
  return {
    name,
    type: 'object[]',
    required,
    description,
    itemProperties,
  };
}

function schema(properties: readonly NestedProperty[]): NestedSchema {
  return { properties };
}

function arraySchema(itemProperties: readonly NestedProperty[]): NestedSchema {
  return { itemProperties };
}

function arrayItemObjectSchema(array: NestedSchema): NestedSchema | undefined {
  return array.itemProperties
    ? schema(array.itemProperties)
    : undefined;
}

function dynamicFieldSchema(
  fieldProperties: readonly NestedProperty[] = VALUE_INFO,
): NestedSchema {
  return schema([
    {
      ...objectProperty(
        'field',
        false,
        '字段标识；实际键名使用 field${字段ID}。',
        fieldProperties,
      ),
      snippet: 'field${1:110}: {\n  $0\n}',
    },
  ]);
}
