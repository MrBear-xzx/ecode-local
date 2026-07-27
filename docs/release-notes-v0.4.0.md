# Ecode Local v0.4.0

本版本将扩展内置的 Ecode API、参数和组件知识转换为通用 AI Coding 工具可读取的工作区支持包，同时统一源码目录并完善旧配置的安全迁移。

## 主要变化

### AI Coding 支持包

- 在工作区根目录生成 `.ecode-ai/`，包含 Ecode 全局 API、方法签名、完整参数说明、嵌套参数、`ecCom/antd` 组件 props 和项目组件注册关系。
- 自动维护根目录 `AGENTS.md` 中的 Ecode 标记区块，向通用 Agent 说明平台定位、运行时全局对象、Babel 兼容范围、目录边界和修改规则。
- API 和组件声明直接由扩展现有知识库生成；不能可靠判断的类型使用 `unknown`，原始文档类型保留在 JSDoc 中。
- 不创建或修改业务项目的 `jsconfig.json`、`tsconfig.json`、Git 配置或忽略规则。

### 工作区组件索引

- 语言服务和 AI 支持服务共享 `WorkspaceComponentRegistry`。
- `workspace-components.md` 仅记录固定 `ecode/` 目录内静态字符串形式的 `ecodeSDK.setCom/getCom` 调用。
- VS Code 运行期间，命令行、Codex 或其他外部 Agent 直接修改文件也会触发防抖更新。
- 手动刷新会重新扫描整个 `ecode/`，可清理已删除文件或目录留下的旧组件记录。

### 固定源码目录与安全迁移

- Ecode 源码目录固定为工作区根目录下的 `ecode/`，新连接不再询问本地目录。
- 原目录已是 `ecode/` 的 v2 配置会无感迁移到 v3。
- 原目录为其他自定义目录时会暂停同步和监听，等待用户明确确认。
- 迁移过程不会移动、复制、覆盖或删除旧源码；密码和 Cookie 仍按服务器及用户名复用。
- `.ecode-ai/` 和 `AGENTS.md` 始终与 `ecode/` 平级，不进入 Ecode 同步范围。

### 界面与命令

- Ecode 视图标题栏仅保留全量拉取、刷新变更和选择并推送三个高频操作。
- 配置连接、开发文档和 AI Coding 维护命令移入标题栏 `...` 更多操作，并按用途分区。
- 新增刷新、打开及移除 AI Coding 支持，以及确认固定源码目录迁移的命令。

## 升级提示

- 升级前建议自行备份重要源码。
- 旧同步目录已经是 `ecode/` 时无需操作。
- 使用其他自定义目录时，根据侧边栏提示执行 `Ecode: 确认迁移到固定源码目录`。
- 新的 `ecode/` 已有内容时，扩展会再次确认是否将其作为新的同步源码，不会自动覆盖。
- VS Code 关闭期间不会后台生成 AI 资料；重新打开工作区或执行刷新命令后会重新核对。

## 兼容范围与限制

- VS Code 1.93.0 或更高版本。
- 已在泛微 E-cology 9 Ecode 环境中验证。
- 支持 JavaScript、JSX、TypeScript 和 TSX。
- 内置知识可能与不同 Ecology 9、KB 或组件库版本存在差异，实际行为以目标环境和官方文档为准。
- `setCom/getCom` 组件关系仅识别静态字符串形式的 `appId` 和组件名。

## 验证结果

- TypeScript 严格类型检查：通过
- VS Code Extension Host 测试：93 项通过
- 生产构建：通过
- VSIX 打包：通过
- 差异格式检查：通过
- 使用 Codex 在查询报表中增加新建按钮并跳转到流程：生成代码正确，实际功能验证正常

## 发布附件

- 文件：`ecode-vscode-0.4.0.vsix`
- 大小：540366 字节（约 527.70 KB）
- SHA-256：`6A80ABED6B1D3940A13DD4C6A225D3880E0633F7C6F73940290F7AEC1FCD0403`
