export type EcodeApiObject = 'ecodeSDK' | 'ModeForm' | 'ModeList' | 'WfForm';

export interface EcodeApiParameter {
  name: string;
  label: string;
  type: string;
  required: boolean;
  description: string;
}

export interface EcodeApiEntry {
  object: EcodeApiObject;
  name: string;
  signature: string;
  description: string;
  parameters: EcodeApiParameter[];
  snippet: string;
  kind: 'method' | 'property';
  officialUrl: string;
}

export interface EcodeApiObjectInfo {
  object: EcodeApiObject;
  title: string;
  description: string;
  officialUrl: string;
}

type ApiDefinition = readonly [
  name: string,
  signature: string,
  description: string,
  snippet?: string,
  kind?: 'method' | 'property',
];

export const ECODE_DOCUMENTATION_URLS: Record<EcodeApiObject, string> = {
  ecodeSDK: 'https://e-cloudstore.com/doc.html',
  ModeForm: 'https://e-cloudstore.com/doc.html?appId=e783a1d75a784d9b97fbd40fdf569f7d',
  ModeList: 'https://e-cloudstore.com/doc.html?appId=e783a1d75a784d9b97fbd40fdf569f7d',
  WfForm: 'https://e-cloudstore.com/doc.html?appId=98cb7a20fae34aa3a7e3a3381dd8764e',
};

export const ECODE_API_OBJECTS: readonly EcodeApiObjectInfo[] = [
  {
    object: 'ecodeSDK',
    title: 'Ecode 前端扩展 SDK',
    description: '用于加载与共享 Ecode 模块、注册或复写组件，以及扩展 PC、移动端和门户页面。',
    officialUrl: ECODE_DOCUMENTATION_URLS.ecodeSDK,
  },
  {
    object: 'ModeForm',
    title: '建模卡片表单 API',
    description: '用于读写建模卡片字段和明细、控制显示属性与校验，以及处理弹窗和页面交互。',
    officialUrl: ECODE_DOCUMENTATION_URLS.ModeForm,
  },
  {
    object: 'ModeList',
    title: '建模查询列表 API',
    description: '用于读取建模列表数据和选中项、控制按钮与刷新，以及打开弹窗或侧滑页面。',
    officialUrl: ECODE_DOCUMENTATION_URLS.ModeList,
  },
  {
    object: 'WfForm',
    title: '流程表单前端 API',
    description: '用于读写流程表单字段和明细、监听事件、执行校验，以及控制浏览按钮和流程操作。',
    officialUrl: ECODE_DOCUMENTATION_URLS.WfForm,
  },
];

const OBJECT_LOOKUP = new Map(
  ECODE_API_OBJECTS.map(info => [info.object, info]),
);

const PARAMETER_DESCRIPTIONS: Record<string, string> = {
  action: '动作类型常量；可使用对应对象上的 ACTION_* 常量。',
  appId: 'Ecode 发布目录的 appId。',
  attrInfo: '字段显示属性，例如 `{ viewAttr: 3 }` 表示必填。',
  buttonType: '按钮类型标识；具体值可从当前页面右键菜单数据中定位。',
  buttons: '对话框按钮配置数组，包含按钮文本及对应回调。',
  callback: '操作完成后的回调函数；具体入参和调用时机取决于当前 API。',
  changeDatas: '字段值信息集合，键为字段标识，值的格式与 changeFieldValue 的 valueInfo 一致。',
  changeVariable: '字段显示属性集合，键为字段标识，例如 `{ field110: { viewAttr: 2 } }`。',
  clearBefore: '为 true 时先清除当前已选行，再应用 rowIndexes。',
  component: '需要注册、渲染或导出的 React 组件或模块对象。',
  componentName: '目标组件名，通常对应 ecCom、antd 或移动组件库中的组件。',
  components: '需要追加到签字意见编辑器底部的 React 组件数组。',
  content: '需要显示、写入或提交的内容。',
  detailMark: '明细表标识，例如 `detail_1` 表示明细表 1。',
  detailOrFieldMark: '支持 `detail_${序号}` 或 `field${字段ID}_${行号}` 两种格式。',
  disabled: '为 true 时禁用或置灰，为 false 时恢复可操作状态。',
  enabled: '是否启用该能力。',
  end: '结束日期；可传 `YYYY-MM-DD`，也可传相对当前日期的天数。',
  fieldId: '字段 ID；部分 API 要求不带 `field` 前缀。',
  fieldInfo: '字段值或显示属性信息集合。',
  fieldMark: '字段标识，主表通常为 `field${字段ID}`，明细字段为 `field${字段ID}_${行号}`。',
  fieldMarks: '字段标识集合；多个字段用逗号分隔，明细监听通常不带行号。',
  fieldName: '数据库字段名称。',
  fieldRequired: '是否校验字段必填，默认 true。',
  hidden: '为 true 时隐藏指定明细行，为 false 时恢复显示。',
  initialValues: '新增明细行的初始值，键不带行号，例如 `{ field110: { value: "11" } }`。',
  isAfter: '追加意见时的位置；true 表示尾部，false 表示头部。',
  isClear: '是否先清空已有意见；默认 true，false 表示保留并追加。',
  message: '提示或确认框中显示的文本。',
  module: '通过 ecodeSDK.exp/imp 导出或导入的模块对象。',
  mustAddDetail: '是否校验“必须新增明细”，默认 true。',
  name: '注册或获取的组件名称。',
  onCancel: '用户点击取消时执行的回调。',
  onOk: '用户点击确认时执行的回调。',
  operation: '操作类型；可使用对应对象上的 OPER_* 常量，多个类型用逗号分隔。',
  optionIds: '选项 key 集合，多个值用逗号分隔；空字符串表示不保留任何选项。',
  options: 'API 配置对象；具体字段见当前参数说明。',
  otherInfo: '确认框附加配置，例如自定义确认、取消按钮名称。',
  pageExpandId: '页面扩展 ID；执行该扩展按钮配置的保存接口。',
  params: 'JSON 格式的附加或覆盖参数。',
  path: '需要匹配的页面路径。',
  percent: '侧滑页面宽度占当前页面的百分比，默认 70。',
  placeholder: '字段为空时显示的灰色提示文本。',
  props: '需要扩展或覆盖的组件 props。',
  range: '生效范围：1 只读、2 可编辑、3 必填；多个范围用逗号分隔。',
  refreshTo: '保存后是否跳转到显示页面，默认 true。',
  render: '自定义渲染函数；必须返回要展示的 React 组件。',
  rowIndex: '明细行标识；使用 detail_* 格式时需要提供。',
  rowIndexes: '明细行标识，多个值用逗号分隔；部分 API 支持 `all`。',
  seconds: '消息自动消失时间，单位秒，默认 1.5。',
  splitChar: '多个显示值之间的分隔符，默认使用逗号。',
  start: '开始日期；可传 `YYYY-MM-DD`，也可传相对当前日期的天数。',
  title: '对话框或消息框标题。',
  type: '消息、动作或按钮类型；枚举含义取决于当前 API。',
  url: '要在侧滑窗口或对话框中打开的页面地址。',
  valueInfo: '字段值信息。普通字段使用 `{ value }`；浏览按钮还需 `specialobj`；只读单行文本可设置显示值。',
  viewAttr: '字段状态：1 只读、2 可编辑、3 必填、4 隐藏标签及内容、5 隐藏所在行。',
  visible: '为 true 时打开，为 false 时关闭。',
  withPrefix: '返回值是否包含 `field` 前缀，默认 true。',
};

const PARAMETER_DESCRIPTION_OVERRIDES: Record<string, Record<string, string>> = {
  'ecodeSDK.load': {
    options: '加载配置：`id` 为发布目录 appId；`noCss` 为 true 时不单独加载 CSS；`cb` 在资源加载完成后执行。',
  },
  'ecodeSDK.getAsyncCom': {
    options: '异步组件配置：`appId`、`name` 指定模块；`isPage` 表示是否为路由页面；`noCss` 控制 CSS；`props` 为组件参数。',
  },
  'ecodeSDK.checkPath': {
    options: 'PC 路由匹配配置，用于限定代码注入的页面范围。',
  },
  'ecodeSDK.checkMobilePath': {
    options: '移动端路由匹配配置，用于限定代码注入的页面范围。',
  },
  'ecodeSDK.overwritePropsFnQueueMapSet': {
    options: '复写配置：`fn(newProps)` 为必填钩子；`order` 控制同组件多个复写的顺序；`desc` 说明复写用途。',
  },
  'ecodeSDK.overwriteMobilePropsFnQueueMapSet': {
    options: '移动端 props 复写配置，包含复写函数、执行顺序和用途说明。',
  },
  'ecodeSDK.overwriteClassFnQueueMapSet': {
    options: 'PC 组件类或方法复写配置，包含目标方法及复写钩子。',
  },
  'ecodeSDK.overwriteMobileClassFnQueueMapSet': {
    options: '移动端组件类或方法复写配置，包含目标方法及复写钩子。',
  },
  changeFieldValue: {
    valueInfo: '字段值信息：普通字段 `{ value: "值" }`；浏览按钮需同时传 `specialobj: [{ id, name }]`；只读单行文本可用 `specialobj.showhtml` 设置显示值。',
  },
  changeSingleField: {
    attrInfo: '可选的字段属性信息，例如 `{ viewAttr: 3 }`。',
    valueInfo: '可选的字段值信息，格式与 changeFieldValue 的 valueInfo 相同。',
  },
  bindFieldChangeEvent: {
    callback: '值变化回调 `(object, id, value)`：依次为触发字段对象、字段标识和修改后的值。',
  },
  bindDetailFieldChangeEvent: {
    callback: '明细值变化回调 `(id, rowIndex, value)`：依次为字段标识、行标识和修改后的值。',
  },
  bindFieldAction: {
    action: '字段动作类型，例如 `onfocus` 或 `onclick`。',
    callback: '动作回调，接收字段标识和明细行号。',
  },
  checkDetailRow: {
    clearBefore: '是否先清除已有选择；传空 rowIndexes 且设为 true 可清空全部选择。',
  },
  controlDateRange: {
    end: '结束边界，格式与 start 相同；省略时只限制开始边界。',
  },
  showMessage: {
    type: '提示类型：1 警告、2 错误、3 成功、4 一般；默认 1。',
  },
  showConfirm: {
    onCancel: '可选的取消回调。',
    onOk: '点击确认后执行的回调。',
    otherInfo: '可选的确认框配置，用于自定义按钮名称等信息。',
  },
  registerCheckEvent: {
    callback: '拦截回调。完成同步或异步检查后必须调用其入参 callback 才会放行；不调用即阻断后续操作。',
  },
  registerAction: {
    callback: '动作完成后的回调；添加行接收新行标识，删除行接收被删除行集合，其他动作按文档传递对应上下文。',
  },
  'WfForm.verifyFormRequired': {
    fieldRequired: '是否校验字段必填，默认 true。',
    mustAddDetail: '是否校验必须新增明细，默认 true。',
  },
  'WfForm.setSignRemark': {
    callback: '意见设置成功后执行的可选回调函数。',
  },
  'WfForm.getFieldInfo': {
    fieldId: '纯字段 ID，不带 `field` 前缀。',
  },
  'WfForm.controlRadioPrintText': {
    fieldId: '字段 ID，不带 `field` 前缀；支持明细字段。',
  },
  'WfForm.proxyFieldContentComp': {
    fieldId: '字段 ID，不带 `field` 前缀。',
  },
  'ModeForm.getFieldInfo': {
    fieldId: '字段标识，格式为 `field${字段ID}`。',
  },
  'ModeForm.controlRadioPrintText': {
    fieldId: '字段标识，格式为 `field${字段ID}`；支持整列明细字段。',
  },
  'ModeForm.proxyFieldContentComp': {
    fieldId: '字段标识，格式为 `field${字段ID}`。',
  },
  'ModeForm.doCardSubmit': {
    buttonType: '按钮类型，通常传空字符串占位。',
    callback: '保存完成后的回调，入参为 billid。',
    isSystemFlag: '是否调用系统默认保存扩展按钮：`"1"` 调用，`"0"` 不调用。',
  },
  'ModeForm.openCustomDialog': {
    props: 'WeaDialog 配置；`title` 和 `url` 必填，可选 `style`、`icon`、`iconBgcolor`、`iconFontColor`。',
  },
  'ModeForm.slideOpenModal': {
    percent: '侧滑页面宽度占当前页面的百分比，默认 70。',
  },
  'ModeForm.showModalMsg': {
    type: '提示类型：1 一般、2 错误、3 成功、4 警告；默认 1。',
  },
  'ModeList.slideOpenModal': {
    percent: '侧滑页面宽度占当前页面的百分比，默认 70。',
  },
};

const ECODE_SDK_DEFINITIONS: ApiDefinition[] = [
  ['load', 'load(options: { id: string; noCss?: boolean; cb?: () => void }): void', '加载指定 Ecode 发布目录的 JavaScript 与 CSS。', 'load({\n  id: \'${1:appId}\',\n  noCss: ${2:true},\n  cb: () => {\n    $0\n  },\n})'],
  ['exp', 'exp(module: unknown): unknown', '导出模块，供同一发布目录中的其他文件导入。', 'exp(${1:module})'],
  ['imp', 'imp(module: unknown): unknown', '导入同一发布目录中通过 exp 导出的模块。', 'imp(${1:module})'],
  ['setCom', 'setCom(appId: string, name: string, component: unknown): void', '注册可由其他 Ecode 文件获取的组件。', 'setCom(\'${1:appId}\', \'${2:componentName}\', ${3:component})'],
  ['getCom', 'getCom(appId: string, name: string): unknown', '同步获取已注册的 Ecode 组件。', 'getCom(\'${1:appId}\', \'${2:componentName}\')'],
  ['getAsyncCom', 'getAsyncCom(options: object): unknown', '按配置异步获取 Ecode 组件。', 'getAsyncCom({\n  $0\n})'],
  ['getBaseInfo', 'getBaseInfo(): object', '获取当前 Ecode 运行环境的基础信息。'],
  ['checkPath', 'checkPath(options: object): boolean', '判断当前 PC 路由是否匹配注入配置。', 'checkPath({\n  $0\n})'],
  ['checkLPath', 'checkLPath(path: string): boolean', '判断当前 PC 页面路径是否匹配。', 'checkLPath(\'${1:/spa/path}\')'],
  ['checkMobilePath', 'checkMobilePath(options: object): boolean', '判断当前移动端路由是否匹配注入配置。', 'checkMobilePath({\n  $0\n})'],
  ['overwritePropsFnQueueMapSet', 'overwritePropsFnQueueMapSet(componentName: string, options: object): void', '注册 PC 组件 props 复写逻辑。', 'overwritePropsFnQueueMapSet(\'${1:ComponentName}\', {\n  fn: props => {\n    $0\n    return props;\n  },\n})'],
  ['overwriteMobilePropsFnQueueMapSet', 'overwriteMobilePropsFnQueueMapSet(componentName: string, options: object): void', '注册移动端组件 props 复写逻辑。'],
  ['overwriteClassFnQueueMapSet', 'overwriteClassFnQueueMapSet(componentName: string, options: object): void', '注册 PC 组件类或方法复写逻辑。'],
  ['overwriteMobileClassFnQueueMapSet', 'overwriteMobileClassFnQueueMapSet(componentName: string, options: object): void', '注册移动端组件类或方法复写逻辑。'],
  ['rewriteRouteQueue', 'rewriteRouteQueue: Array<object>', 'PC 新页面路由注册队列；通过 push 添加路由配置。', 'rewriteRouteQueue', 'property'],
  ['rewriteMobileRouteQueue', 'rewriteMobileRouteQueue: Array<object>', '移动端新页面路由注册队列。', 'rewriteMobileRouteQueue', 'property'],
  ['onWeaverMobileLoadQueue', 'onWeaverMobileLoadQueue: Array<() => void>', '移动端环境加载完成后的回调队列。', 'onWeaverMobileLoadQueue', 'property'],
  ['rewritePortalThemeQueue', 'rewritePortalThemeQueue: Array<object>', '门户主题扩展注册队列。', 'rewritePortalThemeQueue', 'property'],
  ['rewritePortalCusEleQueue', 'rewritePortalCusEleQueue: Array<object>', '门户自定义元素注册队列。', 'rewritePortalCusEleQueue', 'property'],
  ['rewritePortalCusEleSettingQueue', 'rewritePortalCusEleSettingQueue: Array<object>', '门户自定义元素设置页注册队列。', 'rewritePortalCusEleSettingQueue', 'property'],
  ['rewritePortalCusEleHeaderQueue', 'rewritePortalCusEleHeaderQueue: Array<object>', '门户自定义元素头部注册队列。', 'rewritePortalCusEleHeaderQueue', 'property'],
  ['rewritePortalCusEleTabQueue', 'rewritePortalCusEleTabQueue: Array<object>', '门户自定义元素页签注册队列。', 'rewritePortalCusEleTabQueue', 'property'],
  ['rewritePortalCusEleToolbarQueue', 'rewritePortalCusEleToolbarQueue: Array<object>', '门户自定义元素工具栏注册队列。', 'rewritePortalCusEleToolbarQueue', 'property'],
  ['rewritePortalLoginQueue', 'rewritePortalLoginQueue: Array<object>', '门户登录页扩展注册队列。', 'rewritePortalLoginQueue', 'property'],
];

const SHARED_FORM_DEFINITIONS: ApiDefinition[] = [
  ['convertFieldNameToId', 'convertFieldNameToId(fieldName: string, detailMark?: string, withPrefix?: boolean): string', '将数据库字段名转换为表单字段标识。', 'convertFieldNameToId(\'${1:fieldName}\', ${2:\'detail_1\'})'],
  ['getFieldValue', 'getFieldValue(fieldMark: string): string', '获取主表或明细字段的当前值。', 'getFieldValue(\'${1:field110}\')'],
  ['changeFieldValue', 'changeFieldValue(fieldMark: string, valueInfo: object): void', '修改字段值；浏览按钮等字段可在 valueInfo 中提供 specialobj。', 'changeFieldValue(\'${1:field110}\', { value: \'${2:value}\' })'],
  ['changeFieldAttr', 'changeFieldAttr(fieldMark: string, viewAttr: number): void', '修改字段显示属性，例如只读、可编辑、必填或隐藏。', 'changeFieldAttr(\'${1:field110}\', ${2:1})'],
  ['changeSingleField', 'changeSingleField(fieldMark: string, valueInfo?: object, attrInfo?: object): void', '同时修改单个字段的值和显示属性。', 'changeSingleField(\'${1:field110}\', {\n  $0\n}, {\n  viewAttr: ${2:1},\n})'],
  ['changeMoreField', 'changeMoreField(changeDatas: Record<string, object>, changeVariable?: Record<string, object>): void', '批量修改多个字段的值或显示属性。'],
  ['getFieldInfo', 'getFieldInfo(fieldId: string): object', '根据字段 ID 获取字段元信息。'],
  ['getFieldCurViewAttr', 'getFieldCurViewAttr(fieldMark: string): number', '获取字段当前的只读、可编辑或必填属性。'],
  ['bindFieldChangeEvent', 'bindFieldChangeEvent(fieldMarks: string, callback: (object: unknown, id: string, value: string) => void): void', '监听一个或多个主表字段的值变化。', 'bindFieldChangeEvent(\'${1:field110}\', (object, id, value) => {\n  $0\n})'],
  ['bindDetailFieldChangeEvent', 'bindDetailFieldChangeEvent(fieldMarks: string, callback: (id: string, rowIndex: string, value: string) => void): void', '监听一个或多个明细字段的值变化。'],
  ['bindFieldAction', 'bindFieldAction(action: string, fieldMarks: string, callback: Function): void', '为字段区域绑定 focus、click 等动作事件。'],
  ['proxyFieldComp', 'proxyFieldComp(fieldMark: string, component: unknown, range?: string): void', '代理渲染单行文本框字段组件。'],
  ['afterFieldComp', 'afterFieldComp(fieldMark: string, component: unknown): void', '在指定表单字段后追加自定义渲染内容。'],
  ['proxyFieldContentComp', 'proxyFieldContentComp(fieldId: string, render: Function): void', '通过函数自定义渲染表单字段内容。'],
  ['forceRenderField', 'forceRenderField(fieldMark: string): void', '强制重新渲染指定字段。'],
  ['generateFieldContentComp', 'generateFieldContentComp(fieldMark: string): unknown', '根据字段标识获取可用于自定义布局的字段组件。'],
  ['addDetailRow', 'addDetailRow(detailMark: string, initialValues?: Record<string, object>): void', '添加明细行并设置可选的初始字段值。', 'addDetailRow(\'${1:detail_1}\', {\n  ${2:field110}: { value: \'${3:value}\' },\n})'],
  ['delDetailRow', 'delDetailRow(detailMark: string, rowIndexes: string): void', '删除指定明细行；rowIndexes 可传 all。'],
  ['checkDetailRow', 'checkDetailRow(detailMark: string, rowIndexes?: string, clearBefore?: boolean): void', '选中、追加选中或清除明细行选择。'],
  ['getDetailAllRowIndexStr', 'getDetailAllRowIndexStr(detailMark: string): string', '获取明细表所有现有行标识，结果以逗号分隔。'],
  ['getDetailCheckedRowIndexStr', 'getDetailCheckedRowIndexStr(detailMark: string): string', '获取明细表已选中行的行标识。'],
  ['getDetailRowKey', 'getDetailRowKey(fieldMark: string): string', '获取明细行已有记录的数据库主键。'],
  ['getDetailRowCount', 'getDetailRowCount(detailMark: string): number', '获取明细总行数；遍历时应使用实际行标识而非该数字。'],
  ['getDetailRowSerailNum', 'getDetailRowSerailNum(detailOrFieldMark: string, rowIndex?: number): number', '根据明细行标识获取显示序号。'],
  ['controlDetailRowDisplay', 'controlDetailRowDisplay(detailMark: string, rowIndexes: string, hidden: boolean): void', '显示或隐藏指定明细数据行。'],
  ['controlDetailRowDisableCheck', 'controlDetailRowDisableCheck(detailMark: string, rowIndexes: string, disabled: boolean): void', '控制明细行复选框是否允许勾选。'],
  ['setDetailAddUseCopy', 'setDetailAddUseCopy(detailMark: string, enabled: boolean): void', '设置新增明细行时是否复制最后一行数据。'],
  ['appendBrowserDataUrlParam', 'appendBrowserDataUrlParam(fieldMark: string, params: object): void', '为浏览按钮取数请求追加 URL 参数。'],
  ['getBrowserShowName', 'getBrowserShowName(fieldMark: string, splitChar?: string): string', '获取浏览按钮字段的显示值。'],
  ['removeSelectOption', 'removeSelectOption(fieldMark: string, optionIds: string): void', '移除选择框中的指定选项。'],
  ['controlSelectOption', 'controlSelectOption(fieldMark: string, optionIds: string): void', '控制选择框只显示指定选项。'],
  ['getSelectShowName', 'getSelectShowName(fieldMark: string, splitChar?: string): string', '获取选择框字段的显示文本。'],
  ['setTextFieldEmptyShowContent', 'setTextFieldEmptyShowContent(fieldMark: string, placeholder: string): void', '为可编辑且为空的文本字段设置灰色提示。'],
  ['overrideBrowserProp', 'overrideBrowserProp(fieldMark: string, props: object): void', '复写指定浏览按钮组件的 props。'],
  ['controlDateRange', 'controlDateRange(fieldMark: string, start: number | string, end?: number | string): void', '限制日期浏览按钮的可选日期范围。'],
  ['controlRadioPrintText', 'controlRadioPrintText(fieldId: string): void', '打印时仅显示 Radio 字段的已选项文字。'],
  ['controlBtnDisabled', 'controlBtnDisabled(disabled: boolean): void', '控制表单顶部按钮和右键菜单是否置灰。'],
  ['doRightBtnEvent', 'doRightBtnEvent(buttonType: string): void', '主动触发表单右键按钮事件。'],
  ['showMessage', 'showMessage(message: string, type?: number, seconds?: number): void', '显示可配置类型和持续时间的系统消息。'],
  ['showConfirm', 'showConfirm(message: string, onOk: () => void, onCancel?: () => void, otherInfo?: object): void', '显示系统样式的确认框。'],
  ['appendSubmitParam', 'appendSubmitParam(params?: Record<string, unknown>): void', '为提交操作追加发送到服务端的参数。'],
  ['registerCheckEvent', 'registerCheckEvent(operation: string, callback: Function): void', '注册操作执行前的拦截事件，可通过回调放行。', 'registerCheckEvent(${1:operation}, callback => {\n  $0\n  callback();\n})'],
  ['registerAction', 'registerAction(action: string, callback: Function): void', '注册指定动作完成后的钩子事件。'],
];

const WF_FORM_DEFINITIONS: ApiDefinition[] = [
  ['isMobile', 'isMobile(): boolean', '判断当前是否运行在 eMobile、微信、钉钉等移动终端。'],
  ['triggerFieldAllLinkage', 'triggerFieldAllLinkage(fieldMark: string): void', '触发指定字段涉及的全部联动。'],
  ['getBaseInfo', 'getBaseInfo(): object', '获取当前流程请求的基础信息。'],
  ['getGlobalStore', 'getGlobalStore(): object', '获取流程表单全局状态 Store。'],
  ['getLayoutStore', 'getLayoutStore(): object', '获取流程表单布局状态 Store。'],
  ['getOperateStore', 'getOperateStore(): object', '获取移动端流程操作状态 Store。'],
  ['reloadPage', 'reloadPage(params?: object): void', '刷新当前流程表单，可覆盖请求参数。'],
  ['getFirstRequiredEmptyField', 'getFirstRequiredEmptyField(): string', '获取当前第一个未填写的必填字段标识。'],
  ['verifyFormRequired', 'verifyFormRequired(mustAddDetail?: boolean, fieldRequired?: boolean): boolean', '主动执行表单必填校验。'],
  ['getSignRemark', 'getSignRemark(): string', '获取当前签字意见内容。'],
  ['setSignRemark', 'setSignRemark(content: string, isClear?: boolean, isAfter?: boolean, callback?: Function): void', '设置、前置或追加签字意见内容。'],
  ['appendSignEditorBottomBar', 'appendSignEditorBottomBar(components: object[]): void', '扩展签字意见输入框底部按钮。'],
];

const MODE_FORM_DEFINITIONS: ApiDefinition[] = [
  ['getDetailCheckedRowKey', 'getDetailCheckedRowKey(detailMark: string): string', '获取建模明细选中行的数据库主键。'],
  ['getCardUrlInfo', 'getCardUrlInfo(): object', '获取当前建模卡片 URL 参数。'],
  ['reloadCard', 'reloadCard(params?: object): void', '刷新当前建模卡片页面。'],
  ['doCardSubmit', 'doCardSubmit(pageExpandId: string, isSystemFlag?: string, buttonType?: string, refreshTo?: boolean, callback?: Function): void', '从外部调用建模卡片保存。'],
  ['showModalMsg', 'showModalMsg(title: string, content: string, type?: number): void', '显示系统样式的 Modal 消息。'],
  ['slideOpenModal', 'slideOpenModal(visible: boolean, url: string, percent?: number): void', '通过侧滑窗口打开页面。'],
  ['closePageBySlide', 'closePageBySlide(): void', '关闭由侧滑方式打开的页面。'],
  ['getCurrentUserInfo', 'getCurrentUserInfo(): object', '获取当前登录用户信息。'],
  ['getCardSubmitExpendId', 'getCardSubmitExpendId(): string', '获取建模卡片保存按钮的页面扩展 ID。'],
  ['openCustomDialog', 'openCustomDialog(props: object, buttons?: object[]): void', '打开建模系统样式的自定义对话框。', 'openCustomDialog({\n  title: \'${1:标题}\',\n  url: \'${2:/path}\',\n  $0\n}, [\n  {\n    btnname: \'${3:关闭}\',\n    callfun: \'${4:closeDialog}\',\n  },\n])'],
  ['closeCustomDialog', 'closeCustomDialog(): void', '关闭建模自定义对话框。'],
];

const MODE_LIST_DEFINITIONS: ApiDefinition[] = [
  ['getCheckedID', 'getCheckedID(): string', '获取建模查询列表已选记录 ID。'],
  ['getCheckedIDWithDetail', 'getCheckedIDWithDetail(): object[]', '获取查询列表已选记录及其明细信息。'],
  ['getUnCheckedID', 'getUnCheckedID(): string', '获取建模查询列表未选记录 ID。'],
  ['getUnCheckedIDWithDetail', 'getUnCheckedIDWithDetail(): object[]', '获取查询列表未选记录及其明细信息。'],
  ['setAllChecked', 'setAllChecked(): void', '选中查询列表全部记录。'],
  ['clearChecked', 'clearChecked(): void', '清空查询列表选择。'],
  ['getCustomID', 'getCustomID(): string', '获取当前查询列表 customId。'],
  ['getCustomIdWithModeIDAndFormID', 'getCustomIdWithModeIDAndFormID(): object', '获取包含 modeId、formId 的查询标识信息。'],
  ['getFormID', 'getFormID(): string', '获取当前查询列表 formId。'],
  ['getModeID', 'getModeID(): string', '获取当前查询列表 modeId。'],
  ['getTableDatas', 'getTableDatas(): object[]', '获取当前查询列表表格数据。'],
  ['getTableDatasWithSpan', 'getTableDatasWithSpan(): object[]', '获取包含合并单元格信息的表格数据。'],
  ['reloadTable', 'reloadTable(): void', '刷新当前查询列表。'],
  ['reloadTableAll', 'reloadTableAll(): void', '刷新查询列表及相关统计信息。'],
  ['getBatchEditDatas', 'getBatchEditDatas(): object', '获取查询列表批量编辑数据。'],
  ['getHighSearchDatas', 'getHighSearchDatas(): object', '获取查询列表高级搜索条件。'],
  ['getTopSearchDatas', 'getTopSearchDatas(): object', '获取查询列表顶部搜索条件。'],
  ['showMessage', 'showMessage(message: string, type?: number, seconds?: number): void', '显示建模查询列表系统消息。'],
  ['showConfirm', 'showConfirm(message: string, onOk: () => void, onCancel?: () => void, otherInfo?: object): void', '显示建模查询列表确认框。'],
  ['slideOpenModal', 'slideOpenModal(visible: boolean, url: string, percent?: number): void', '从建模查询列表侧滑打开页面。'],
];

const FORM_CONSTANTS: ApiDefinition[] = [
  ['OPER_SAVE', 'OPER_SAVE: string', '保存操作的拦截事件常量。', 'OPER_SAVE', 'property'],
  ['OPER_SUBMIT', 'OPER_SUBMIT: string', '提交或批准操作的拦截事件常量。', 'OPER_SUBMIT', 'property'],
  ['OPER_REJECT', 'OPER_REJECT: string', '退回操作的拦截事件常量。', 'OPER_REJECT', 'property'],
  ['OPER_ADDROW', 'OPER_ADDROW: string', '添加明细行操作常量，使用时需拼接明细序号。', 'OPER_ADDROW', 'property'],
  ['OPER_DELROW', 'OPER_DELROW: string', '删除明细行操作常量，使用时需拼接明细序号。', 'OPER_DELROW', 'property'],
  ['ACTION_ADDROW', 'ACTION_ADDROW: string', '添加明细行完成后的动作常量。', 'ACTION_ADDROW', 'property'],
  ['ACTION_DELROW', 'ACTION_DELROW: string', '删除明细行完成后的动作常量。', 'ACTION_DELROW', 'property'],
];

function createEntries(
  object: EcodeApiObject,
  definitions: ApiDefinition[],
): EcodeApiEntry[] {
  return definitions.map(([name, signature, description, snippet, kind = 'method']) => {
    const parameters = kind === 'method'
      ? parseSignatureParameters(signature).map(parameter => ({
        ...parameter,
        description: parameterDescription(object, name, parameter.name),
      }))
      : [];
    return {
      object,
      name,
      signature,
      description,
      parameters,
      snippet: snippet ?? `${name}($0)`,
      kind,
      officialUrl: ECODE_DOCUMENTATION_URLS[object],
    };
  });
}

export const ECODE_API_ENTRIES: readonly EcodeApiEntry[] = [
  ...createEntries('ecodeSDK', ECODE_SDK_DEFINITIONS),
  ...createEntries('ModeForm', [...SHARED_FORM_DEFINITIONS, ...MODE_FORM_DEFINITIONS, ...FORM_CONSTANTS]),
  ...createEntries('ModeList', MODE_LIST_DEFINITIONS),
  ...createEntries('WfForm', [...SHARED_FORM_DEFINITIONS, ...WF_FORM_DEFINITIONS, ...FORM_CONSTANTS]),
];

const ENTRY_LOOKUP = new Map(
  ECODE_API_ENTRIES.map(entry => [`${entry.object}.${entry.name}`, entry]),
);

export function getApiEntries(object?: EcodeApiObject): readonly EcodeApiEntry[] {
  return object
    ? ECODE_API_ENTRIES.filter(entry => entry.object === object)
    : ECODE_API_ENTRIES;
}

export function getApiEntry(
  object: EcodeApiObject,
  name: string,
): EcodeApiEntry | undefined {
  return ENTRY_LOOKUP.get(`${object}.${name}`);
}

export function getApiObjectInfo(
  object: EcodeApiObject,
): EcodeApiObjectInfo | undefined {
  return OBJECT_LOOKUP.get(object);
}

export function parseCompletionContext(
  textBeforeCursor: string,
): { object: EcodeApiObject; prefix: string } | undefined {
  const match = /(?:window\.)?(ecodeSDK|ModeForm|ModeList|WfForm)\.([A-Za-z_$][\w$]*)?$/
    .exec(textBeforeCursor);
  if (!match) {
    return undefined;
  }
  return {
    object: match[1] as EcodeApiObject,
    prefix: match[2] ?? '',
  };
}

export function findApiReferenceAt(
  text: string,
  offset: number,
): EcodeApiEntry | undefined {
  if (offset < 0 || offset > text.length) {
    return undefined;
  }
  let start = offset;
  let end = offset;
  while (start > 0 && /[\w$]/.test(text[start - 1])) {
    start -= 1;
  }
  while (end < text.length && /[\w$]/.test(text[end])) {
    end += 1;
  }
  const name = text.slice(start, end);
  const objectMatch = /(?:window\.)?(ecodeSDK|ModeForm|ModeList|WfForm)\.\s*$/
    .exec(text.slice(Math.max(0, start - 64), start));
  return objectMatch
    ? getApiEntry(objectMatch[1] as EcodeApiObject, name)
    : undefined;
}

export function findApiObjectReferenceAt(
  text: string,
  offset: number,
): EcodeApiObjectInfo | undefined {
  if (offset < 0 || offset > text.length) {
    return undefined;
  }
  const pattern = /(?:window\.)?(ecodeSDK|ModeForm|ModeList|WfForm)\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const object = match[1] as EcodeApiObject;
    const objectOffset = match.index + match[0].lastIndexOf(object);
    if (offset >= objectOffset && offset <= objectOffset + object.length) {
      return getApiObjectInfo(object);
    }
  }
  return undefined;
}

export function parseCallContext(
  textBeforeCursor: string,
): {
  entry: EcodeApiEntry;
  activeParameter: number;
  activeArgumentText: string;
} | undefined {
  const openParenthesis = findLastUnclosedParenthesis(textBeforeCursor);
  if (openParenthesis < 0) {
    return undefined;
  }
  const match = /(?:window\.)?(ecodeSDK|ModeForm|ModeList|WfForm)\.([A-Za-z_$][\w$]*)\s*$/
    .exec(textBeforeCursor.slice(Math.max(0, openParenthesis - 96), openParenthesis));
  if (!match) {
    return undefined;
  }
  const entry = getApiEntry(match[1] as EcodeApiObject, match[2]);
  if (!entry || entry.kind !== 'method') {
    return undefined;
  }
  const argumentsText = textBeforeCursor.slice(openParenthesis + 1);
  const commaIndexes = topLevelCommaIndexes(argumentsText);
  return {
    entry,
    activeParameter: commaIndexes.length,
    activeArgumentText: argumentsText.slice((commaIndexes.at(-1) ?? -1) + 1),
  };
}

export function parseSignatureParameters(
  signature: string,
): Array<Omit<EcodeApiParameter, 'description'>> {
  const start = signature.indexOf('(');
  const end = signature.lastIndexOf(')');
  if (start < 0 || end <= start + 1) {
    return [];
  }
  return splitTopLevel(signature.slice(start + 1, end))
    .map(label => {
      const match = /^([A-Za-z_$][\w$]*)(\?)?\s*:\s*(.+)$/.exec(label);
      return match
        ? {
          name: match[1],
          label,
          type: match[3],
          required: match[2] !== '?',
        }
        : undefined;
    })
    .filter((parameter): parameter is Omit<EcodeApiParameter, 'description'> =>
      parameter !== undefined);
}

function parameterDescription(
  object: EcodeApiObject,
  method: string,
  parameter: string,
): string {
  return PARAMETER_DESCRIPTION_OVERRIDES[`${object}.${method}`]?.[parameter]
    ?? PARAMETER_DESCRIPTION_OVERRIDES[method]?.[parameter]
    ?? PARAMETER_DESCRIPTIONS[parameter]
    ?? `参数 ${parameter} 的具体约束请以官方在线文档为准。`;
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (const character of value) {
    if ('({[<'.includes(character)) {
      depth += 1;
    } else if (')}]>'.includes(character)) {
      depth = Math.max(0, depth - 1);
    }
    if (character === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

function findLastUnclosedParenthesis(value: string): number {
  const stack: number[] = [];
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if ('\'"`'.includes(character)) {
      quote = character;
    } else if (character === '(') {
      stack.push(index);
    } else if (character === ')') {
      stack.pop();
    }
  }
  return stack.at(-1) ?? -1;
}

function topLevelCommaIndexes(value: string): number[] {
  const commas: number[] = [];
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if ('\'"`'.includes(character)) {
      quote = character;
    } else if ('({[<'.includes(character)) {
      depth += 1;
    } else if (')}]>'.includes(character)) {
      depth = Math.max(0, depth - 1);
    } else if (character === ',' && depth === 0) {
      commas.push(index);
    }
  }
  return commas;
}
