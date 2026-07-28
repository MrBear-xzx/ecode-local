# Ecode Local v0.5.0

本版本增加基于 Ecode 表单元数据的字段联想、悬停说明与代码跳转，并将扩展生成的 AI 资料和同步状态统一迁移到工作区 `.ecode-local/` 目录。

## 主要变化

### 表单字段智能

- 全量拉取时静态分析业务入口中的表单守卫和被实际引用的公共配置，建立源码文件与工作流 `formId` 的关联。
- 从文件详情响应中兼容提取 `tableInfo/fieldinfomap`；能够确定工作流 `formId` 时，通过字段列表与表数据接口补充主表及明细字段。
- 为 `WfForm`、`ModeForm` 的已知字段参数、明细参数和字段映射对象键提供 `field110`、纯数字字段 ID、数据库字段名和 `detail_1` 联想。
- `convertFieldNameToId` 未传第二个参数时只使用主表，传入静态 `detail_N` 时只使用对应明细表。
- 支持在字段语义位置按 F12 或 Ctrl+单击打开只读元数据文档；鼠标悬停可查看字段中文名、ID、数据库字段名、所属表、类型和表单上下文。
- 对 `const fieldId = WfForm.convertFieldNameToId(...)` 形式的静态赋值，变量声明和后续引用也会追加字段中文说明。

### 离线缓存与同步安全

- 表单元数据按服务器指纹和远端文件路径隔离，仅保存字段结构，不保存表单业务数据、密码、Cookie 或其他凭据。
- 元数据只随未取消的全量拉取刷新；打开扩展、切换文件、输入代码、补全、悬停和跳转不会联网。
- 全量拉取成功后原子更新缓存，并清理远端已删除或明确无元数据的条目。
- 拉取取消、文件详情请求失败或元数据格式异常时保留旧缓存；元数据问题不会阻断源码同步。

### `.ecode-local` 工作区目录

- AI Coding 资料由 `.ecode-ai/` 迁移到 `.ecode-local/ecode-ai/`，新增 `workspace-form-metadata.md` 供通用 Agent 离线读取表单字段。
- 同步清单、表单缓存、源码快照、冲突和恢复副本迁移到 `.ecode-local/storage/`。
- 根目录 `AGENTS.md` 保留原位置，继续作为 Codex 等通用 Agent 的发现入口。
- 检测到工作区由 Git 管理时，扩展会保留现有规则并向根目录 `.gitignore` 补充 `/.ecode-local/`；已有等价规则时不会重复写入。
- 首次使用新目录时会复制旧扩展存储作为迁移，旧数据继续保留作为兜底；旧 `.ecode-ai/` 中的自定义文件不会被删除。

## 使用方式

1. 安装 VSIX 并重新加载 VS Code。
2. 打开已经配置 Ecode 连接的工作区。
3. 执行一次 `Ecode: 全量拉取`，建立或刷新文件级表单元数据缓存。
4. 在 `WfForm` 或 `ModeForm` 的字段参数中输入数据库字段名、`field` 标识或 `detail_N`。
5. 将鼠标悬停在字段字符串或静态转换后的变量上查看中文说明；按 Ctrl+单击或 F12 打开完整字段文档。
6. AI Coding 工具可读取 `.ecode-local/ecode-ai/workspace-form-metadata.md` 获取当前工作区的表单字段上下文。

## 兼容范围与限制

- 支持 VS Code 1.93.0 或更高版本，以及 JavaScript、JSX、TypeScript 和 TSX。
- 已在泛微 E-cology 9 Ecode 环境中验证。
- 表单字段智能继续受 `ecode.intelligence.enabled` 控制，不新增独立刷新命令。
- 仅识别可静态求值的 API 语义位置、表单守卫和数值配置；动态计算、异步取得或存在多个冲突值时不会猜测。
- JavaScript 标识符及数据库字段名按大小写精确匹配；源码中的非标准别名不会自动映射为元数据字段名。
- 建模表单只有在文件详情响应附带兼容的 `tableInfo/fieldinfomap` 时才能建立完整字段上下文。
- 本地新建且尚未通过全量拉取建立远端文件关联的源码暂不提供字段建议。

## 验证结果

- TypeScript 严格类型检查：通过
- 生产构建：通过
- VS Code Extension Host 测试：119 项通过
- VSIX 打包：通过
- 差异格式检查：通过

## 发布附件

- 文件：`ecode-vscode-0.5.0.vsix`
- 大小：554984 字节（约 541.98 KB）
- SHA-256：`1292A2427987D7E972011A3CBEDF93BA76FE457E0C2988F0AF2EF589E22A9B59`
