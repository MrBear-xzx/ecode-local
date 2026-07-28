# Ecode Local

Ecode Local 是面向泛微 E-cology 9 Ecode 的 VS Code 扩展，用于在本地安全编辑和发布 Ecode 源码，并为 VS Code 与通用 AI Coding Agent 提供 Ecode API、组件和工作区上下文。

## 安装

### 从 GitHub Release 安装（推荐）

1. 打开项目的 [Releases](https://github.com/MrBear-xzx/ecode-local/releases) 页面，下载最新版本的 `ecode-vscode-*.vsix`。
2. 在 VS Code 中打开“扩展”视图。
3. 点击扩展视图右上角的 `...`，选择“从 VSIX 安装...”。
4. 选择下载的 `.vsix` 文件，并按提示重新加载 VS Code。

也可以在终端中安装：

```bash
code --install-extension ecode-vscode-0.5.0.vsix
```

安装完成后，VS Code 活动栏中会出现 **Ecode** 图标。

## 兼容性

- VS Code 1.93.0 或更高版本。
- 目前仅在泛微 E-cology 9 Ecode 环境中完成测试和实际使用。
- 支持统一认证在登录过程中刷新 `ecology_JSessionid` 的部署方式。
- 其他 E-cology 或 Ecode 版本尚未验证，不保证兼容。

## 从 0.4.0 升级到 0.5.0

0.5.0 将扩展生成内容统一迁移到工作区根目录的 `.ecode-local/`：

- AI Coding 资料迁移到 `.ecode-local/ecode-ai/`；根目录 `AGENTS.md` 保留原位置。
- 同步清单、字段缓存、源码快照、冲突和恢复副本迁移到 `.ecode-local/storage/`。
- 首次使用新目录时会复制旧扩展存储，旧存储继续保留作为兜底。
- 首次刷新 AI Coding 支持时会清理旧 `.ecode-ai/` 中由扩展管理的文件，用户自定义文件不会被删除。
- Git 工作区会在保留现有规则的前提下向根目录 `.gitignore` 补充 `/.ecode-local/`。

升级并重新加载 VS Code 后，请执行一次 `Ecode: 全量拉取`，以建立或刷新文件与表单字段元数据的关联。

## 从旧版本升级到 0.4.0

0.4.0 将 Ecode 源码目录固定为工作区根目录下的 `ecode/`：

- 原同步目录已经是 `ecode/`：连接配置会无感升级，无需重新输入密码。
- 原同步目录是其他自定义目录：同步和文件监听会暂停，并要求执行
  `Ecode: 确认迁移到固定源码目录`。
- 扩展不会移动、复制、覆盖或删除旧目录；新的 `ecode/` 已有内容时还会要求再次确认。
- 旧同步清单仅在原同步根目录与新 `ecode/` 一致时复用，否则会从空基线重新检查差异。

建议升级前自行备份重要源码。确认迁移后，由用户决定是否拉取远端或使用已有 `ecode/` 内容，扩展不会自动覆盖文件。

## 首次使用

使用前请准备 E-cology 服务器地址，以及具备 Ecode 源码读取和发布权限的账号。

1. 在 VS Code 中打开一个本地文件夹作为工作区。
2. 点击活动栏中的 **Ecode** 图标，再点击“配置连接”。
3. 依次填写：
   - **服务器地址**：包含 `http://` 或 `https://` 的 E-cology 地址，例如 `https://ecology.example.com`。
   - **登录用户名**：用于访问 Ecode 的账号。
   - **密码**：仅保存到 VS Code `SecretStorage`。
4. 连接测试成功后，扩展固定使用工作区根目录下的 `ecode/` 作为源码目录；点击侧边栏标题栏中的“全量拉取”，确认后建立本地文件与远端文件的同步基线。

首次拉取会检查完整远端源码树。已有本地修改不会被静默覆盖；请根据结果处理侧边栏中显示的变更或冲突。

## 日常使用

1. 在工作区根目录的 `ecode/` 中编辑源码。
2. 停止修改 2 秒后，侧边栏会自动刷新变更；也可以执行 `Ecode: 刷新本地变更`。
3. 点击变更文件查看基线、本地和最新远端之间的差异。
4. 点击“选择并推送”，勾选本次要发布的新增、修改或删除文件。
5. 确认目标服务器和文件数量后执行推送。

推送前，扩展会重新检查远端内容；推送新增或修改后，会回读远端内容进行校验；推送删除后，会重新读取远端父目录确认文件已经消失。JavaScript 和 JSX 会使用 Ecode 在线编辑器对应的 Babel 7.5.5 配置生成编译内容。

如果本地删除的是整个目录，请在推送选择框中保留该目录下所有删除文件的勾选。只有目录已在本地消失、目录内全部远端文件都在本次删除范围内，且远端内容仍与同步基线一致时，扩展才会删除远端目录；否则会降级为逐文件处理，避免误删远端新增或已修改的内容。

全量拉取时，如果远端删除了文件或目录，而本地文件仍与同步基线一致，扩展会先保存恢复副本，再删除对应本地文件并清理已经为空的目录。如果本地也修改过文件，则进入冲突状态，不会自动删除本地内容。

要放弃尚未推送的本地新增、修改或删除，可以在变更项上执行 `Ecode: 回退本地变更`。本地新增和修改会在回退前保存恢复副本；本地删除会从同步基线恢复。

## 冲突处理

如果本地和远端相对同步基线都发生了变化，文件会进入“冲突”状态，不会直接覆盖任一侧内容。点击冲突文件可以比较：

- 本地与最新远端；
- 同步基线与本地；
- 同步基线与最新远端。

确认差异后，可以选择：

- **接受最新远端**：先保存本地恢复副本，再使用远端内容替换本地文件。
- **已手工合并，保留当前本地**：把最新远端设为新基线，保留当前本地内容等待后续推送。

删除冲突使用更严格的处理：

- **本地已删除、远端已修改**：可以接受最新远端并恢复本地文件；如仍需删除，请再次删除本地文件并重新推送。
- **远端已删除、本地已修改**：可以备份并接受远端删除，也可以保留本地内容，将其转为待推送的远端新增文件。

## 代码智能

代码智能默认覆盖 JavaScript、JSX、TypeScript 和 TSX，可在 VS Code 设置中通过
`ecode.intelligence.enabled` 统一开关。所有内置知识均随扩展离线提供；表单字段元数据在用户执行全量拉取时更新到本地缓存。打开源码、输入代码和查看提示都不会请求服务器。

### Ecode API

- 收录 `ecodeSDK`、`ModeForm`、`ModeList`、`WfForm` 共 167 个方法、属性或常量，以及 222 个方法参数说明。
- 输入 `WfForm.`、`ModeForm.`、`ModeList.`、`ecodeSDK.` 或对应的 `window.*` 形式时，会提供成员联想和常用代码片段。
- 输入方法参数时会显示签名、当前参数、类型、是否必填和具体含义。
- 悬停成员可快速查看说明；按 F12 或 Ctrl+单击成员名可打开包含参数及二级参数的内置文档。
- 悬停或 Ctrl+单击 API 对象名，可查看该对象的用途以及全部方法、属性、常量和签名。

### 表单字段元数据

- 全量拉取会静态分析业务入口中的表单守卫，例如 `if (formid !== carRequest.WfFormId) return`，并解析 `pageInfo` 等公共配置里的数值常量。能唯一确定工作流 `formId` 时，再通过 `/api/workflow/formSetting/fieldSet/getFieldList` 和 `/api/ec/dev/table/datas` 读取主表及明细字段，按服务器及远端文件路径缓存；缓存只包含字段结构，不包含表单业务数据或凭据。
- `/api/cloudstore/ecode/one?id=...` 只用于读取源码；部分 Ecode 版本可能在响应中附带 `tableInfo/fieldinfomap`，扩展会兼容提取，但不再假设该接口一定返回表单元数据。
- 在 `WfForm`、`ModeForm` 已知的字段参数、明细参数，以及 `initialValues`、`changeDatas`、`changeVariable` 等字段映射对象键中，提供 `field110`、数据库字段名和 `detail_1` 联想。
- `WfForm.convertFieldNameToId("cfdd")` 和 `ModeForm.convertFieldNameToId("field_name", "detail_1")` 会优先联想数据库字段名；第二个参数为静态 `detail_N` 时只展示对应明细表字段。
- 联想项同时显示字段标识、字段名称、数据库字段、所属主表/明细表和类型；多个字段字符串只替换光标所在片段。
- 对这些 API 语义位置中的 `field110`、`field110_行号`、数据库字段名或 `detail_1` 按 F12 / Ctrl+单击，会打开只读元数据文档并定位到对应字段或明细表。
- 鼠标悬停在上述字段或明细标识上，会显示字段中文名、字段 ID、数据库字段名、所属表、类型和表单上下文。
- 对 `const fieldId = WfForm.convertFieldNameToId('数据库字段名')` 这类可静态确定且唯一的赋值，悬停变量声明或后续引用也会追加显示对应字段中文名。
- 表单元数据缺失、格式不兼容或尚未随全量拉取缓存时，不影响源码同步，也不会在普通字符串中提供猜测性建议。

### PC 组件与嵌套参数

- 收录 90 个 `ecCom` 组件、37 个 Ecology 9 内置 `antd` 组件和 1911 条 props 参数记录。
- 支持 `ecCom.`、`antd.`、`window.ecCom.`、`window.antd.` 成员联想，以及命名导入、解构和赋值形成的 JSX 组件别名。
- 在 JSX 标签中提供 props 联想、类型、必填、默认值和说明；悬停或 F12 可查看完整组件文档。
- 支持已整理对象和数组项的二级参数，包括 `WeaBrowser.tabs[].browserProps`、`WeaTable/antd.Table.columns[]`、`filters`、`rowSelection`，以及 `WfForm`、`ModeForm`、`ecodeSDK` 常用对象参数。
- 二级联想会识别当前对象中已经填写的键，避免扩展自身重复建议。

### `setCom/getCom` 跨文件导航

`ecode/` 内使用静态字符串注册的组件会建立增量索引：

```javascript
// components/MyCard.js
ecodeSDK.setCom('my-app-id', 'MyCard', MyCard);

// pages/index.js
const MyCard = ecodeSDK.getCom('my-app-id', 'MyCard');
```

- 在同一 `appId` 的 `setCom/getCom` 第二个参数中联想已注册组件名。
- Ctrl+单击或 F12 `getCom` 组件名，可跨文件跳到对应 `setCom` 注册位置。
- 对组件名执行“查找所有引用”，可查看匹配的注册与获取位置。
- 索引在扩展启动后后台预热；编辑、保存、新增或删除文件时只更新对应文件。

## AI Coding 支持

连接成功后，扩展默认在工作区根目录生成以下资料：

```text
workspace/
├─ ecode/                         # 固定 Ecode 源码目录
├─ .ecode-local/
│  ├─ ecode-ai/
│  │  ├─ ecode-globals.d.ts          # 全局 API、签名、参数和嵌套参数
│  │  ├─ ecode-components.d.ts       # ecCom/antd 组件及 props
│  │  ├─ ecode-ai-guide.md           # 平台约束和生成规则
│  │  ├─ workspace-components.md     # setCom/getCom 组件关系
│  │  ├─ workspace-form-metadata.md  # 文件关联的表单、主/明细表和字段中文名
│  │  └─ manifest.json               # 生成器版本与知识摘要
│  └─ storage/                       # 清单、字段缓存、快照、冲突与恢复副本
└─ AGENTS.md                      # 仅维护 Ecode 标记区块
```

- `.ecode-local/` 与 `ecode/` 平级，不会被拉取、扫描或推送到 Ecode 平台。
- 升级后首次刷新 AI Coding 支持会先在新目录生成完整资料，再清理旧 `.ecode-ai/` 中由扩展管理的文件；旧目录中的自定义文件会保留。
- 类型信息直接由扩展内置 API、参数和组件知识生成；资料不足的类型使用 `unknown`，原始文档类型保留在注释中。
- `workspace-components.md` 只记录 `ecode/` 中的静态 `setCom/getCom` 调用。
- `workspace-form-metadata.md` 按表单上下文列出关联源码、`main/detail_N`、字段 ID、中文名、数据库字段名、类型和查看/编辑/必填属性；全量拉取成功刷新字段缓存后会同步重新生成。
- 已有 `AGENTS.md` 的其他内容会完整保留；扩展只更新
  `<!-- ecode-local:ai-start -->` 与 `<!-- ecode-local:ai-end -->` 之间的内容。
- AGENTS 管理区块会向通用 Agent 说明 Ecode 平台、运行时全局对象、Babel 兼容范围、目录边界和修改前必须读取的知识文件，避免把项目误判为普通 Node.js 或 React 工程。
- 如果 AGENTS 标记残缺、重复、顺序错误或发生嵌套，扩展会停止覆盖并提示修复，不会重写用户的其他内容。
- 可通过 `ecode.aiSupport.enabled` 关闭自动生成。扩展不会创建或修改 `jsconfig.json`、`tsconfig.json`、Git 配置或忽略规则。

### 外部 Agent 修改后的刷新机制

- VS Code 与扩展宿主正在运行时，即使文件由命令行、Codex 或其他通用 Agent 直接修改，工作区文件监听也会检测 `ecode/` 中的新增、修改和删除，并在防抖后刷新组件索引及 `workspace-components.md`。
- 执行 `Ecode: 刷新 AI Coding 支持` 时会重新扫描整个 `ecode/`，因此可以清理已从磁盘删除的文件或目录所留下的旧组件记录。
- VS Code 已关闭或扩展尚未激活时，没有后台进程可以立即更新文件；下次打开工作区并激活扩展，或手动执行刷新命令时会重新核对。
- 生成内容没有变化时不会重写文件，避免产生无意义的文件时间戳变化。

## 文档与维护入口

- 执行 `Ecode: 搜索开发文档`，可按对象名、方法名、组件名或功能描述搜索内置知识。
- 执行 `Ecode: 打开官方文档`，可打开
  [ecodeSDK](https://e-cloudstore.com/doc.html)、
  [ModeForm / ModeList](https://e-cloudstore.com/doc.html?appId=e783a1d75a784d9b97fbd40fdf569f7d)、
  [WfForm](https://e-cloudstore.com/doc.html?appId=98cb7a20fae34aa3a7e3a3381dd8764e)
  或[泛微 PC 组件库](https://cloudstore.e-cology.cn/#/pc/doc/common-index)。
- 视图标题栏只保留拉取、刷新变更和选择并推送三个高频操作；配置连接、文档入口和 AI Coding 维护命令收纳在标题栏的 `...` 更多操作中。

## 功能

- 使用独立同步基线判断本地变更、远端变更和冲突，不依赖 Git。
- 全量拉取 UTF-8 文本源码，并保护已有本地修改。
- 自动刷新本地变更，支持基线、本地和最新远端之间的差异查看。
- 双向同步删除：本地删除可选择推送到远端，远端删除可在拉取时安全应用到未修改的本地文件。
- 选择性推送新增、修改或删除文件，操作前检查远端状态，操作后回读验证。
- 回退未推送的本地新增、修改或删除，并在覆盖或删除现有内容前保存恢复副本。
- JavaScript 和 JSX 使用 Ecode 在线编辑器对应的 Babel 7.5.5 配置生成编译内容。
- 冲突时可接受远端，或在手工合并后重新建立同步基线。
- 提供 Ecode API、PC 组件、嵌套参数和跨文件组件注册的本地代码智能。
- 提供可搜索的内置开发文档和泛微官方文档入口。

## 数据与安全

- 扩展启动时不会自动联网、拉取或推送。
- 密码和 Cookie 保存在 VS Code `SecretStorage`。
- 同步基线、表单字段缓存、内容快照、冲突和恢复副本保存在工作区 `.ecode-local/storage/`；旧版本的 VS Code 扩展存储会在首次使用时复制迁移并保留作为兜底。
- `.ecode-local/storage/` 可能包含源码快照和冲突内容，不应提交到版本库；检测到工作区由 Git 管理时，扩展会保留现有规则并在工作区根目录 `.gitignore` 中补充 `/.ecode-local/`，已有等价规则时不会重复添加。忽略规则写入失败不会阻断同步。
- Ecode 同步源码固定在当前 VS Code 工作区根目录的 `ecode/`。
- AI Coding 资料位于 `.ecode-local/ecode-ai/`；工作区根目录的 `AGENTS.md` 继续作为通用 Agent 的发现入口。两者均不包含连接凭据。
- 密码和 Cookie 始终保存在 VS Code `SecretStorage`，不会写入 `.ecode-local/`。
- 除按上述规则补充工作区根目录 `.gitignore` 外，扩展不会初始化 Git 仓库，也不会切换分支、暂存、提交或推送。

## 升级与卸载

- **升级**：从 [Releases](https://github.com/MrBear-xzx/ecode-local/releases) 下载新版本 VSIX，并按安装步骤再次安装。
- **卸载**：在 VS Code 扩展视图中找到 **Ecode Local**，点击“卸载”。

升级或卸载扩展不会删除工作区中的源码。连接配置与凭据仍由 VS Code 管理；`.ecode-local/storage/` 中的同步基线和恢复副本也不会随卸载自动删除，卸载前如需保留重要内容请先自行备份。

0.4.0 的目录迁移规则见[从旧版本升级到 0.4.0](#从旧版本升级到-040)。

## 命令

| 命令 | 用途 |
| --- | --- |
| `Ecode: 配置连接` | 测试并保存服务器和账号；源码目录固定为 `ecode/` |
| `Ecode: 全量拉取` | 获取完整远端文件树并安全应用远端变化 |
| `Ecode: 刷新本地变更` | 立即比较本地文件和同步基线；自动刷新遗漏时可手动执行 |
| `Ecode: 选择并推送` | 勾选新增、修改或删除文件并安全推送 |
| `Ecode: 查看差异` | 查看基线、本地和最新远端之间的差异 |
| `Ecode: 回退本地变更` | 将本地新增、修改或删除回退到同步基线 |
| `Ecode: 解决冲突` | 接受远端或确认已完成手工合并 |
| `Ecode: 搜索开发文档` | 按对象名、方法名、组件名或功能描述搜索内置 API 与 PC 组件知识 |
| `Ecode: 打开官方文档` | 打开 ecodeSDK、ModeForm/ModeList、WfForm 或 PC 组件库官方文档 |
| `Ecode: 刷新 AI Coding 支持` | 重新生成 `.ecode-local/ecode-ai/` 和 AGENTS 管理区块 |
| `Ecode: 打开 AI Coding 指南` | 打开生成的平台约束和编码指南 |
| `Ecode: 移除 AI Coding 支持` | 删除受管理的 AI 文件和 AGENTS 区块并关闭自动生成 |
| `Ecode: 确认迁移到固定源码目录` | 将旧连接改为固定的 `ecode/`，不移动或删除旧目录 |

代码智能默认启用；如只需同步功能，可在 VS Code 设置中关闭
`ecode.intelligence.enabled`。
AI Coding 支持也默认启用，可通过 `ecode.aiSupport.enabled` 单独关闭。

## 当前限制

- 只支持 UTF-8 文本源码，不支持二进制资源和 JAR。
- 删除同步依赖服务端提供 `/api/cloudstore/ecode/logicalDeleteFile` 和 `/api/cloudstore/ecode/logicalDeleteFolder` 接口。本地整个目录被删除且其中所有远端文件均安全可删时，扩展会同步删除远端目录；不兼容这些接口的 Ecode 版本会返回删除失败，不会提前移除本地同步基线。
- 不支持多服务器同时连接、后台定时同步和自动推送。
- 服务端没有事务、版本号或 ETag 时，推送保护无法完全消除检查与上传之间的竞争窗口。
- 内置 API 与组件说明来自当前已整理的官方文档；Ecology 9、KB 或组件库升级后可能存在新增、删除或行为差异，实际兼容范围以目标环境和官方文档为准。
- `setCom/getCom` 跨文件导航仅索引静态字符串形式的 `appId` 和组件名；动态变量或运行时拼接无法可靠关联。
- 工作流字段绑定目前只识别可静态求值的 `formid` 守卫及数值配置，例如 `formid !== config.WfFormId`；动态计算、接口异步取得或同名配置存在多个值时不会猜测。建模 `modeId` 守卫可以被识别，但目标服务器未确认可在不读取业务表单数据的前提下仅按 `modeId` 获取完整字段结构，因此这类文件只有在文件详情附带兼容的 `tableInfo/fieldinfomap` 时才有 `ModeForm` 字段建议。
- 表单字段联想只在 `WfForm`、`ModeForm` 的静态 API 语义位置生效，JavaScript 标识符和数据库字段名按大小写精确匹配；源码中的非标准别名（例如元数据为 `kssj`、代码写成 `mxkssj`）不会自动猜测映射。本地新增且尚未通过全量拉取建立表单绑定的文件不会获得字段建议。
- 大型工作区首次激活时需要后台预热组件注册索引；预热后文件变化采用单文件增量更新。

## 开发与验证

以下内容仅适用于需要从源码开发或自行构建扩展的贡献者。普通用户应直接从 GitHub Release 下载 VSIX。

```bash
npm install
npm run build
npx tsc --noEmit
npm test
npm run package
```

`npm test` 会启动 VS Code Extension Host。仓库当前没有有效的 ESLint 配置，因此 `npm run lint` 不作为验收命令。
