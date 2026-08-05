# Ecode Local Agent CLI

基础命令：

```text
node .ecode-local/common/ecode-ai/skills/ecode-local/scripts/ecode-agent.cjs <action> [参数]
```

CLI 自动使用活动环境。可选通用参数：`--workspace <目录>`、`--environment-directory <目录>`、`--timeout <秒>`。路径使用 `/` 分隔，且相对于活动环境源码目录。CLI 的标准输出是结构化结果；最终 `status` 为 `succeeded`、`partial`、`cancelled`、`rejected` 或 `failed`，交互请求刚提交时为 `pending`。

工作区至少配置一个 Ecode 环境后才会生成并允许使用 CLI。首次配置必须从 VS Code 的 Ecode 侧边栏完成；未配置工作区不会生成 `.ecode-local`。

以下 action 必须先在当前任务中取得用户对具体操作和目标的明确授权，再添加无值标记 `--confirmed`：

`switchEnvironment`、`deleteEnvironment`、`push`、`rollbackPushFile`、`deletePushRecord`、`revertChange`、`resolveConflict`、`applyChangeSet`、`deleteChangeSet`、`removeAiSupport`。

VS Code 不会为 Agent CLI 重复弹出确认框。没有明确授权时先询问用户，不得预先添加、默认添加或复用 `--confirmed`。`pull` 无需确认且不接受该标记。

超时输出 `status: "unknown"` 和请求 ID。不要重新执行状态变更，使用以下命令续查：

```text
node .ecode-local/common/ecode-ai/skills/ecode-local/scripts/ecode-agent.cjs wait --request-id <ID>
```

`configure`、`addEnvironment`、`searchDocumentation`、`openOnlineDocumentation` 提交后立即返回 `pending`，不会占用 CLI 进程等待人工操作。原请求保留一小时；用户在 VS Code 中提交、选择或取消后，继续使用同一请求 ID 续查。

## 只读操作

| Action | 参数 | 结果 |
| --- | --- | --- |
| `getState` | — | 配置、活动环境、基线、各状态计数和非 `clean` 变更 |
| `refreshChanges` | — | 重新扫描本地与远端并返回变更；只记录冲突，不应用源码 |
| `listPushRecords` | — | 活动环境推送记录 |
| `listChangeSets` | — | 工作区变更集 |
| `getKnowledge` | — | 指南、Skill 和 CLI 路径 |

## 环境与同步

| Action | 参数 | 说明 |
| --- | --- | --- |
| `configure` | — | 打开当前环境连接配置表单 |
| `addEnvironment` | — | 打开新增环境表单 |
| `switchEnvironment` | `--environment-id <ID> --confirmed` | 先取得对目标环境的授权 |
| `deleteEnvironment` | `--environment-id <ID> --confirmed` | 删除非最后一个环境的配置、源码、本地状态和凭据；不修改远端代码或公共历史记录 |
| `pull` | — | 直接执行，无需确认 |
| `push` | 一个或多个 `--path <路径>`、`--confirmed` | 每次推送都需要单独授权 |

## 变更与冲突

| Action | 参数 | 说明 |
| --- | --- | --- |
| `openDiff` | `--path <路径>` | 打开当前差异 |
| `revertChange` | `--path <路径> --confirmed` | 授权后恢复至基线 |
| `resolveConflict` | `--path <路径> --resolution <值> --confirmed` | 授权具体解决方式 |

普通冲突的 resolution 使用 `acceptRemote` 或 `markMerged`；`remoteDeletedLocalModified` 使用 `acceptRemoteDeletion` 或 `keepLocal`；`localDeletedRemoteModified` 仅支持 `acceptRemote`。

## 推送记录与变更集

| Action | 参数 | 说明 |
| --- | --- | --- |
| `rollbackPushFile` | `--push-record-id <ID> --path <路径> --confirmed` | 授权后仅回退本地文件 |
| `renamePushRecord` | `--push-record-id <ID> --name <名称>` | 修改记录名称 |
| `deletePushRecord` | `--push-record-id <ID> --confirmed` | 授权后删除记录 |
| `openPromotionDiff` | `--record-type <pushRecord\|changeSet>`、对应记录 ID、`--path <路径>` | 记录 ID 使用 `--push-record-id` 或 `--change-set-id` |
| `createChangeSet` | 一个或多个 `--push-record-id <ID>`、`--name <名称>` | 合并选定推送记录 |
| `applyChangeSet` | `--change-set-id <ID> --confirmed` | 授权后应用到活动环境 |
| `deleteChangeSet` | `--change-set-id <ID> --confirmed` | 授权后删除记录 |

## 文档与 AI 支持

| Action | 参数 | 说明 |
| --- | --- | --- |
| `searchDocumentation` | 可选 `--query <关键词>` | 打开开发文档搜索 |
| `openOnlineDocumentation` | — | 打开在线文档选择器 |
| `refreshAiSupport` | — | 重新生成知识、Skill、CLI 和 AGENTS 区块 |
| `enableAiSupport` | — | 配置被关闭但 CLI 仍存在时重新启用并生成内容 |
| `openAiGuide` | — | 打开生成的指南 |
| `removeAiSupport` | `--confirmed` | 授权后移除生成内容；CLI 也会被移除，之后从 Ecode 侧边栏执行“启用 AI Coding 支持” |
