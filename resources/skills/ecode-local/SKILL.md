---
name: ecode-local
description: 通过插件生成的通用 CLI 查询、编辑及操作 Ecode Local 工作区，并使用生成的 API/组件知识辅助编码。通用编码 Agent 修改 Ecode 源码，或处理环境、同步、冲突、前置加载、文件夹发布、推送记录和变更集时使用。
---

# Ecode Local

调用前阅读 [CLI 操作接口](references/actions.md)。

## 调用扩展

1. 仅通过以下 CLI 调用扩展，不直接读写 `.ecode-local` 内部状态或请求/结果文件：

   ```text
   node .ecode-local/common/ecode-ai/skills/ecode-local/scripts/ecode-agent.cjs <action> [参数]
   ```

2. 使用当前环境中的 `node` 运行 CLI。CLI 自动查找工作区和活动环境，生成内部请求，等待扩展结果，并向标准输出写入 JSON。
3. 本 Skill 只在至少配置一个 Ecode 环境后生成。首次配置必须从 VS Code 的 Ecode 侧边栏完成；CLI 不得为未配置工作区创建 `.ecode-local`。
4. 根据结果的 `status` 判断实际结果；命令退出不代表操作成功。超时时确认 VS Code 中的 Ecode Local 已激活。
5. `configure`、`addEnvironment` 提交后返回 `pending`；等待用户完成 VS Code 表单，再使用返回的 `wait --request-id <ID>` 续查。其他 action 超时表示结果未知，也只能续查原请求，不得用新 ID 重试状态变更。
6. 用户要求只读时仍运行 CLI，但只调用文档列出的只读 action。

## 编辑 Ecode 代码

1. 阅读 `.ecode-local/common/ecode-ai/ecode-ai-guide.md` 和生成的声明文件。
2. 使用表单字段或 `ecodeSDK.getCom` 前，阅读活动环境的 `workspace-form-metadata.md` 和 `workspace-components.md`。
3. 遵循活动环境源码中的既有模式；将 `unknown` 视为知识缺失，不自行猜测。
4. 业务修改限制在活动环境源码目录。`ecodeSDK`、表单 API、`ecCom` 和 `antd` 由 Ecode 提供，不要安装；语法兼容 Babel 7.5.5。

## 保持安全

1. 同步状态变更前先调用 `getState` 或 `refreshChanges`；生命周期状态变更前先调用 `getLifecycleState`，并使用结果中返回的精确路径。
2. 仅执行用户已授权的状态变更；远端推送始终需要当前任务中的单独授权。
3. 对需要确认的 action，先向用户说明具体操作、目标和影响。当前任务中已有明确授权时直接使用；否则先询问，取得授权后才添加 `--confirmed`。
4. 不预先、默认或复用 `--confirmed`。VS Code 不会为 Agent CLI 重复弹出确认框；缺少该标记的请求会被拒绝。
5. `pull` 无需确认，也不得添加 `--confirmed`。不绕过冲突检查、编译/GBK 校验和写后回读验证。
6. 每项生命周期写入后重新调用 `getLifecycleState`；仅外层 `status: "succeeded"` 且 `data.verified === true` 表示扩展已回读确认。无法验证或 CLI 返回非 `succeeded` 时报告并停止后续写入。
7. 发布、前置加载、顺序、根应用归属和特殊 `config*` 文件规则以 [CLI 操作接口](references/actions.md#运行时语义) 为准。顺序越小越先执行，默认 `10000`；`postloaded`、`unknown` 或不可读状态不得直接覆盖。
