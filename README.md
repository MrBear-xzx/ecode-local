# Ecode Local

Ecode Local 是面向泛微 E-cology 9 Ecode 的 VS Code 扩展，用于在本地安全编辑和发布 Ecode 源码。

## 安装

### 从 GitHub Release 安装（推荐）

1. 打开项目的 [Releases](https://github.com/MrBear-xzx/ecode-local/releases) 页面，下载最新版本的 `ecode-vscode-*.vsix`。
2. 在 VS Code 中打开“扩展”视图。
3. 点击扩展视图右上角的 `...`，选择“从 VSIX 安装...”。
4. 选择下载的 `.vsix` 文件，并按提示重新加载 VS Code。

也可以在终端中安装：

```bash
code --install-extension ecode-vscode-0.3.0.vsix
```

安装完成后，VS Code 活动栏中会出现 **Ecode** 图标。

## 兼容性

- VS Code 1.93.0 或更高版本。
- 目前仅在泛微 E-cology 9 Ecode 环境中完成测试和实际使用。
- 支持统一认证在登录过程中刷新 `ecology_JSessionid` 的部署方式。
- 其他 E-cology 或 Ecode 版本尚未验证，不保证兼容。

## 首次使用

使用前请准备 E-cology 服务器地址，以及具备 Ecode 源码读取和发布权限的账号。

1. 在 VS Code 中打开一个本地文件夹作为工作区。
2. 点击活动栏中的 **Ecode** 图标，再点击“配置连接”。
3. 依次填写：
   - **服务器地址**：包含 `http://` 或 `https://` 的 E-cology 地址，例如 `https://ecology.example.com`。
   - **登录用户名**：用于访问 Ecode 的账号。
   - **密码**：仅保存到 VS Code `SecretStorage`。
   - **本地同步子目录**：相对于当前工作区的目录，默认为 `ecode`；不能指向工作区外部。
4. 连接测试成功后，点击侧边栏标题栏中的“全量拉取”，确认后建立本地文件与远端文件的同步基线。

首次拉取会检查完整远端源码树。已有本地修改不会被静默覆盖；请根据结果处理侧边栏中显示的变更或冲突。

## 日常使用

1. 在配置的本地同步目录中编辑源码。
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
`ecode.intelligence.enabled` 统一开关。所有内置知识均随扩展离线提供，打开源码和查看提示不会请求服务器。

### Ecode API

- 收录 `ecodeSDK`、`ModeForm`、`ModeList`、`WfForm` 共 167 个方法、属性或常量，以及 222 个方法参数说明。
- 输入 `WfForm.`、`ModeForm.`、`ModeList.`、`ecodeSDK.` 或对应的 `window.*` 形式时，会提供成员联想和常用代码片段。
- 输入方法参数时会显示签名、当前参数、类型、是否必填和具体含义。
- 悬停成员可快速查看说明；按 F12 或 Ctrl+单击成员名可打开包含参数及二级参数的内置文档。
- 悬停或 Ctrl+单击 API 对象名，可查看该对象的用途以及全部方法、属性、常量和签名。

### PC 组件与嵌套参数

- 收录 90 个 `ecCom` 组件、37 个 Ecology 9 内置 `antd` 组件和 1911 条 props 参数记录。
- 支持 `ecCom.`、`antd.`、`window.ecCom.`、`window.antd.` 成员联想，以及命名导入、解构和赋值形成的 JSX 组件别名。
- 在 JSX 标签中提供 props 联想、类型、必填、默认值和说明；悬停或 F12 可查看完整组件文档。
- 支持已整理对象和数组项的二级参数，包括 `WeaBrowser.tabs[].browserProps`、`WeaTable/antd.Table.columns[]`、`filters`、`rowSelection`，以及 `WfForm`、`ModeForm`、`ecodeSDK` 常用对象参数。
- 二级联想会识别当前对象中已经填写的键，避免扩展自身重复建议。

### `setCom/getCom` 跨文件导航

工作区内使用静态字符串注册的组件会建立增量索引：

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

### 文档入口

- 执行 `Ecode: 搜索开发文档`，可按对象名、方法名、组件名或功能描述搜索内置知识。
- 执行 `Ecode: 打开官方文档`，可打开
  [ecodeSDK](https://e-cloudstore.com/doc.html)、
  [ModeForm / ModeList](https://e-cloudstore.com/doc.html?appId=e783a1d75a784d9b97fbd40fdf569f7d)、
  [WfForm](https://e-cloudstore.com/doc.html?appId=98cb7a20fae34aa3a7e3a3381dd8764e)
  或[泛微 PC 组件库](https://cloudstore.e-cology.cn/#/pc/doc/common-index)。

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
- 连接配置、同步基线、内容快照和恢复副本保存在 VS Code 扩展存储中。
- 同步目录必须位于当前 VS Code 工作区内。
- 扩展不会初始化、切换、提交或修改 Git 仓库。

## 升级与卸载

- **升级**：从 [Releases](https://github.com/MrBear-xzx/ecode-local/releases) 下载新版本 VSIX，并按安装步骤再次安装。
- **卸载**：在 VS Code 扩展视图中找到 **Ecode Local**，点击“卸载”。

升级或卸载扩展不会删除工作区中的源码。连接配置、同步基线和恢复副本属于 VS Code 扩展存储；卸载前如需保留重要内容，请先自行备份。

## 命令

| 命令 | 用途 |
| --- | --- |
| `Ecode: 配置连接` | 测试并保存服务器、账号和本地目录 |
| `Ecode: 全量拉取` | 获取完整远端文件树并安全应用远端变化 |
| `Ecode: 刷新本地变更` | 立即比较本地文件和同步基线；自动刷新遗漏时可手动执行 |
| `Ecode: 选择并推送` | 勾选新增、修改或删除文件并安全推送 |
| `Ecode: 查看差异` | 查看基线、本地和最新远端之间的差异 |
| `Ecode: 回退本地变更` | 将本地新增、修改或删除回退到同步基线 |
| `Ecode: 解决冲突` | 接受远端或确认已完成手工合并 |
| `Ecode: 搜索开发文档` | 按对象名、方法名、组件名或功能描述搜索内置 API 与 PC 组件知识 |
| `Ecode: 打开官方文档` | 打开 ecodeSDK、ModeForm/ModeList、WfForm 或 PC 组件库官方文档 |

代码智能默认启用；如只需同步功能，可在 VS Code 设置中关闭
`ecode.intelligence.enabled`。

## 当前限制

- 只支持 UTF-8 文本源码，不支持二进制资源和 JAR。
- 删除同步依赖服务端提供 `/api/cloudstore/ecode/logicalDeleteFile` 和 `/api/cloudstore/ecode/logicalDeleteFolder` 接口。本地整个目录被删除且其中所有远端文件均安全可删时，扩展会同步删除远端目录；不兼容这些接口的 Ecode 版本会返回删除失败，不会提前移除本地同步基线。
- 不支持多服务器同时连接、后台定时同步和自动推送。
- 服务端没有事务、版本号或 ETag 时，推送保护无法完全消除检查与上传之间的竞争窗口。
- 内置 API 与组件说明来自当前已整理的官方文档；Ecology 9、KB 或组件库升级后可能存在新增、删除或行为差异，实际兼容范围以目标环境和官方文档为准。
- `setCom/getCom` 跨文件导航仅索引静态字符串形式的 `appId` 和组件名；动态变量或运行时拼接无法可靠关联。
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
