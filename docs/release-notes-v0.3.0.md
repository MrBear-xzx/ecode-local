# Ecode Local v0.3.0

本版本在原有安全同步、差异预览、冲突保护和选择性发布能力之上，新增面向泛微 Ecode 的本地代码智能。

## 主要变化

### Ecode API 智能

- 支持 `ecodeSDK`、`ModeForm`、`ModeList`、`WfForm` 成员联想和常用代码片段。
- 收录 167 个方法、属性或常量，以及 222 个方法参数说明。
- 提供参数签名、类型、是否必填、含义、悬停说明及内置快速文档。
- Ctrl+单击或 F12 API 对象名可查看全部成员；单击成员名可查看参数与二级参数说明。

### PC 组件智能

- 收录 90 个 `ecCom` 组件、37 个 Ecology 9 内置 `antd` 组件和 1911 条 props 记录。
- 支持组件成员、JSX 标签和 props 联想，以及命名导入、解构、赋值和 `window.*` 形式。
- 支持 `WeaBrowser.tabs`、`WeaTable/antd.Table.columns`、`filters`、`rowSelection` 等嵌套参数。

### `setCom/getCom` 跨文件导航

- 根据静态字符串形式的 `appId + 组件名` 建立工作区索引。
- 在 `setCom/getCom` 组件名参数中提供联想。
- 支持从 `getCom` 跨文件跳转到 `setCom`，并查找全部注册与获取位置。
- 索引启动后后台预热，后续文件变化采用单文件增量更新。

### 文档入口

- 新增 `Ecode: 搜索开发文档`。
- 新增 `Ecode: 打开官方文档`。

## 兼容范围

- VS Code 1.93.0 或更高版本。
- 已在泛微 E-cology 9 Ecode 环境验证。
- 支持 JavaScript、JSX、TypeScript 和 TSX。

## 已知限制

- API 与组件库会随 Ecology 9、KB 和组件版本变化，实际能力以目标环境及泛微官方文档为准。
- `setCom/getCom` 跨文件关联仅支持静态字符串形式的 `appId` 和组件名，不推断动态变量或运行时拼接。
- 大型工作区首次激活时需要后台预热组件注册索引。
- 同步功能仍仅支持 UTF-8 文本源码，不支持二进制资源和 JAR。

## 验证结果

- TypeScript 严格类型检查：通过
- VS Code Extension Host 测试：83 项通过
- 生产构建：通过
- VSIX 打包：通过
- 差异格式检查：通过

## 发布附件

- 文件：`ecode-vscode-0.3.0.vsix`
- 大小：530287 字节（约 517.86 KB）
- SHA-256：`D554DC4B0411A8FFE06415390EC0EF75ED0363E54C9B7F415F333B5C2A166F34`
