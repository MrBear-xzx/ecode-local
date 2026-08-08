# Ecode Local Agent CLI

基础命令：

```text
node .ecode-local/common/ecode-ai/skills/ecode-local/scripts/ecode-agent.cjs <action> [参数]
```

CLI 自动使用活动环境。可选通用参数：`--workspace <目录>`、`--environment-directory <目录>`、`--timeout <秒>`。路径使用 `/` 分隔，且相对于活动环境源码目录。CLI 的标准输出是结构化结果；最终 `status` 为 `succeeded`、`partial`、`cancelled`、`rejected` 或 `failed`，交互请求刚提交时为 `pending`。

工作区至少配置一个 Ecode 环境后才会生成并允许使用 CLI。首次配置必须从 VS Code 的 Ecode 侧边栏完成；未配置工作区不会生成 `.ecode-local`。

以下 action 必须先在当前任务中取得用户对具体操作和目标的明确授权，再添加无值标记 `--confirmed`：

`switchEnvironment`、`deleteEnvironment`、`push`、`setPreload`、`setPreloadOrder`、`setFolderRelease`、`rollbackPushFile`、`deletePushRecord`、`deleteLifecycleRecord`、`revertChange`、`resolveConflict`、`applyChangeSet`、`deleteChangeSet`。

VS Code 不会为 Agent CLI 重复弹出确认框。没有明确授权时先询问用户，不得预先添加、默认添加或复用 `--confirmed`。`pull` 无需确认且不接受该标记。

超时输出 `status: "unknown"` 和请求 ID。不要重新执行状态变更，使用以下命令续查：

```text
node .ecode-local/common/ecode-ai/skills/ecode-local/scripts/ecode-agent.cjs wait --request-id <ID>
```

`configure`、`addEnvironment` 提交后立即返回 `pending`，不会占用 CLI 进程等待人工操作。原请求保留一小时；用户在 VS Code 中提交或取消后，继续使用同一请求 ID 续查。

## 只读操作

| Action | 参数 | 结果 |
| --- | --- | --- |
| `getState` | — | 配置、活动环境、基线、各状态计数和非 `clean` 变更 |
| `getLifecycleState` | — | 系统信息、接口能力、项目分类、文件前置加载状态和根文件夹发布状态 |
| `refreshChanges` | — | 重新扫描本地与远端并返回变更；只记录冲突，不应用源码 |
| `listPushRecords` | — | 活动环境推送记录 |
| `listLifecycleRecords` | — | 活动环境中回读验证成功的生命周期变更记录 |
| `listChangeSets` | — | 工作区变更集 |
| `getKnowledge` | — | 指南、Skill 和 CLI 路径 |

`getLifecycleState` 的外层结果骨架为 `{"status":"succeeded","data":{...}}`。生命周期数据位于 `data`：`data.capabilities`（可用读取能力）、`data.systemInfo`、`data.categories[{ id, path, appId?, preStateOrder? }]`、`data.files[{ id, path, fileType, preloadState, canPreload }]` 和 `data.folders[{ id, path, appId?, rootFolder, released?, preStateOrder? }]`。根文件夹的 `preStateOrder` 是 Ecode 前置加载顺序。问号字段缺失表示服务端没有返回可读状态，不能自行猜测。

## 环境与同步

| Action | 参数 | 说明 |
| --- | --- | --- |
| `configure` | — | 打开当前环境连接配置表单 |
| `addEnvironment` | — | 打开新增环境表单 |
| `switchEnvironment` | `--environment-id <ID> --confirmed` | 先取得对目标环境的授权 |
| `deleteEnvironment` | `--environment-id <ID> --confirmed` | 删除非最后一个环境的配置、源码、本地状态和凭据；不修改远端代码或公共历史记录 |
| `pull` | — | 直接执行，无需确认 |
| `push` | 一个或多个 `--path <路径>`、`--confirmed` | 每次推送都需要单独授权 |

## Ecode 生命周期

先调用 `getLifecycleState`，使用 `categories`、`files` 或 `folders` 返回的精确 `path`。目标已是期望状态时跳过。生命周期写操作彼此独立，没有事务、自动回滚或隐式拉取/推送；每项都需要当前任务明确授权。

### 运行时语义

- **发布**以分类下的根文件夹为应用边界。普通代码生成到 `ecology/cloudstore/release/{appId}/index.js`、`index.css`，由业务通过 `ecodeSDK` 按需加载。发布只改状态，不会执行 `push`。
- **前置加载**仅适用于 JS/CSS，早于系统和组件执行，并合并到 `ecology/cloudstore/dev/init.js`、`init.css`（设置生效范围时路径会细分）。其影响较广，不应只为“让文件可加载”而开启。
- 发布、文件前置状态和根文件夹顺序相互独立。需要代码生效时分别检查 `released` 与 `preloadState`，不得自动补做另一项。文件所属应用只从 `data.folders` 中的 `rootFolder: true` 项判断：按路径段前缀选择唯一的最长匹配；无匹配或并列时停止。
- 顺序是根文件夹属性，数值越小越先执行，默认值为 `10000`。不要依赖相同值的先后关系或负数、零的跨版本行为，优先沿用现值或用户指定值。
- `config.js`、`config_default.js`、`configLoad.js`、`configLoad_default.js` 有特殊默认生效及优先级规则。默认不得调用 `setPreload`；只有用户点名文件并明确接受改变加载语义的风险时才能尝试。

以上语义依据 [泛微 ecode 使用说明](https://e-cloudstore.com/doc.html) 与 [ecode 页面部分功能清单](https://e-cloudstore.com/doc.html?appId=836e12deff924b8a92bb112b2b29b742)。实际行为仍以目标环境和 `getLifecycleState` 为准。

### 状态决策

| 当前状态 | Agent 处理 |
| --- | --- |
| 文件 `canPreload: false` | 不得调用 `setPreload` |
| 文件 `preloadState: preloaded` / `normal` | 状态已符合目标时跳过；否则按授权切换 |
| 文件 `preloadState: postloaded` 或 `unknown` | 不得按普通“开启/取消”意图直接覆盖；说明当前状态以及可能清除其他加载语义，取得针对覆盖该状态的明确授权后才执行 |
| 文件夹 `rootFolder: false` | 不得发布、取消发布或修改前置加载顺序 |
| 发布操作的 `released` 缺失 | 重新查询；仍不可读时说明无法验证，取得针对该风险的授权后才能尝试，不得用 `preStateOrder` 代替 |
| 顺序操作的 `preStateOrder` 缺失 | 重新查询；仍不可读时说明旧值和结果可能无法验证，取得针对该风险的授权后才能尝试，不得用 `released` 代替 |

一次 action 只接受一个目标。批量任务逐项执行、逐项回读；首个非 `succeeded` 或无法验证的结果出现后停止，并汇总已成功、未验证和未执行项。

| Action | 参数 | 说明 |
| --- | --- | --- |
| `setPreload` | `--path <文件路径> --enabled <true\|false> --confirmed` | 设置或取消 JS/CSS 文件的前置加载 |
| `setPreloadOrder` | `--path <根文件夹路径> --order <数字> --confirmed` | 修改根文件夹前置加载顺序；支持整数和最多两位小数 |
| `setFolderRelease` | `--path <文件夹路径> --enabled <true\|false> --confirmed` | 发布或取消发布分类下的根文件夹 |

示例（`path` 必须逐字使用 `getLifecycleState` 返回的相对路径）：

```text
node .ecode-local/common/ecode-ai/skills/ecode-local/scripts/ecode-agent.cjs setPreload --path "普为光电/流程表单/A-行政管理/A002-派车申请/init.js" --enabled true --confirmed
node .ecode-local/common/ecode-ai/skills/ecode-local/scripts/ecode-agent.cjs setPreloadOrder --path "普为光电/流程表单/A-行政管理/A002-派车申请" --order 10000 --confirmed
node .ecode-local/common/ecode-ai/skills/ecode-local/scripts/ecode-agent.cjs setFolderRelease --path "普为光电/流程表单/A-行政管理/A002-派车申请" --enabled true --confirmed
```

取消操作将相应命令的 `--enabled` 改为 `false`。

成功结构为 `{"status":"succeeded","data":{"verified":true,"changed":true|false,...}}`。检查 `data.verified`：只有外层 `status: "succeeded"` 且该字段为 `true` 才表示扩展已回读确认；`changed: true` 时会生成生命周期记录，已经收敛则返回 `changed: false` 且不重复记录。无法回读确认会返回失败并且不生成记录，状态可能已经写入时应重新查询后再决定下一步；后续实时字段符合预期时可报告“已通过独立实时查询确认”，但不会补生成生命周期记录。

## 变更与冲突

| Action | 参数 | 说明 |
| --- | --- | --- |
| `revertChange` | `--path <路径> --confirmed` | 授权后恢复至基线 |
| `resolveConflict` | `--path <路径> --resolution <值> --confirmed` | 授权具体解决方式 |

普通冲突的 resolution 使用 `acceptRemote` 或 `markMerged`；`remoteDeletedLocalModified` 使用 `acceptRemoteDeletion` 或 `keepLocal`；`localDeletedRemoteModified` 仅支持 `acceptRemote`。

## 推送记录与变更集

| Action | 参数 | 说明 |
| --- | --- | --- |
| `rollbackPushFile` | `--push-record-id <ID> --path <路径> --confirmed` | 授权后仅回退本地文件 |
| `renamePushRecord` | `--push-record-id <ID> --name <名称>` | 修改记录名称 |
| `deletePushRecord` | `--push-record-id <ID> --confirmed` | 授权后删除记录 |
| `deleteLifecycleRecord` | `--lifecycle-record-id <ID> --confirmed` | 授权后只删除生命周期历史记录，不修改远端状态 |
| `createChangeSet` | 一个或多个 `--push-record-id <ID>` 和/或 `--lifecycle-record-id <ID>`、`--name <名称>` | 合并所选记录，允许纯生命周期变更集 |
| `applyChangeSet` | `--change-set-id <ID> --confirmed` | 授权后先应用代码，再对齐变更集中明确包含的生命周期状态 |
| `deleteChangeSet` | `--change-set-id <ID> --confirmed` | 授权后删除记录 |

文档搜索、在线文档、差异视图和 AI Coding 支持管理只面向 VS Code 用户，不属于 Agent CLI。Agent 应读取生成知识或直接检查工作区文件，不模拟这些界面操作。
