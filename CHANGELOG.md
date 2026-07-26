# 更新日志

## 0.3.0 - 2026-07-26

### 新增

- 为 JavaScript、JSX、TypeScript 和 TSX 增加 Ecode 代码智能，收录 `ecodeSDK`、`ModeForm`、`ModeList`、`WfForm` 共 167 个方法、属性或常量，以及 222 个参数说明。
- 增加成员联想、代码片段、参数签名、悬停说明、对象总览，以及成员和对象级 F12 / Ctrl+单击文档跳转。
- 内置泛微 PC 组件知识：覆盖 90 个 `ecCom` 组件、37 个 Ecology 9 内置 `antd` 组件和 1911 条 props 参数记录。
- 为 JSX 组件提供 props 联想，并支持命名导入、解构、赋值及 `window.ecCom/window.antd` 形式。
- 增加对象和数组项的二级参数联想，覆盖 `WeaBrowser.tabs`、`WeaTable/antd.Table.columns`、`filters`、`rowSelection`，以及 `WfForm`、`ModeForm`、`ecodeSDK` 常用对象参数。
- 增加 `ecodeSDK.setCom/getCom` 工作区组件名联想、跨文件定义跳转和引用查找。
- 增加“搜索开发文档”和“打开官方文档”命令。

### 优化

- `setCom/getCom` 索引在启动后后台预热，并在编辑、保存、新增或删除文件时进行单文件增量更新，避免 Ctrl+单击触发全工作区重建。
- API 成员只使用 VS Code 定义跳转能力，未按 Ctrl 时不会常驻显示链接下划线。
- 补齐 API 参数类型、是否必填、含义及已整理对象参数的二级说明。

### 兼容性与限制

- 支持 VS Code 1.93.0 或更高版本，以及泛微 E-cology 9 Ecode。
- 内置知识来自当前已整理的泛微官方文档；不同 Ecology 9、KB 或组件库版本可能存在差异。
- `setCom/getCom` 跨文件关联仅支持静态字符串形式的 `appId` 和组件名。

### 验证

- `node_modules/.bin/tsc --noEmit`
- `npm test`：83 项通过
- `npm run build`
- `npm run package`
- `git diff --check`

## 0.2.3 - 2026-07-24

### 修复

- 修复启用统一认证时，登录接口刷新 `ecology_JSessionid` 后扩展仍使用旧会话，导致登录成功但读取远端文件树提示“登录信息超时”的问题。
- 登录过程中会持续接收 RSA 和登录响应返回的最新 session Cookie，并将最终认证会话保存到 VS Code `SecretStorage`。

### 兼容性

- 支持 VS Code 1.93.0 或更高版本，以及泛微 E-cology 9 Ecode。
- 其他 E-cology 或 Ecode 版本尚未验证。

### 验证

- `node_modules/.bin/tsc --noEmit`
- `npm test`：61 项通过
- `npm run package`

## 0.2.2 - 2026-07-24

### 新增

- 支持双向同步文件删除：本地删除可选择推送到远端，远端删除可在全量拉取时安全应用到本地。
- 支持目录删除同步：本地整个目录被删除且目录内所有远端文件均通过安全校验时，会调用 Ecode 目录删除接口；远端目录删除后，会清理本地已经为空的对应目录。
- 增加“回退本地变更”命令，可回退尚未推送的本地新增、修改和删除。
- 增加远端删除冲突处理，可选择接受远端删除，或保留本地内容并转为待推送的新增文件。

### 调整

- 本地文件保存或删除后的自动变更刷新延迟由 5 秒缩短为 2 秒。

### 安全保护

- 推送本地删除前会重新检查远端文件标识和内容是否仍与同步基线一致。
- 只有目录内所有远端文件都被选中删除，且没有远端新增或修改内容时，才会删除整个远端目录；否则降级为逐文件处理。
- 应用远端删除前会保存本地恢复副本；本地存在未同步修改时会转为冲突，不会直接删除。
- 删除成功后会重新读取远端父目录进行验证，验证失败时不会提前清除本地同步基线。

### 验证

- `node_modules/.bin/tsc --noEmit`
- `npm test`：60 项通过
- `npm run package`
