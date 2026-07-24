# 仓库指南

## 项目结构与模块组织

本仓库是使用 TypeScript 开发的 VS Code 扩展。`src/extension.ts` 负责扩展激活、命令注册和 VS Code 生命周期；`src/domain/` 包含不依赖 VS Code 或网络的同步模型、文本处理和路径安全逻辑；`src/sync/` 负责 Ecode 鉴权、API 适配、JavaScript 编译和同步编排；`src/storage/` 管理连接配置、同步清单、快照、冲突与恢复副本；`src/ui/` 提供侧边栏和虚拟差异文档。Mocha 测试位于 `src/test/suite/`。

`out/`、`dist/`、`node_modules/` 和生成的 `.vsix` 均为构建产物，不要手工修改或提交。

## 构建、测试与本地开发

- `npm run build`：使用 esbuild 将入口打包为 `out/extension.js`，并生成 source map。
- `npm run watch`：持续监听并重新构建；配合 VS Code 的 **Run Extension** 配置或 F5 调试。
- `npx tsc --noEmit`：执行 esbuild 不包含的严格类型检查。
- `npm test`：编译测试入口，再通过 `@vscode/test-electron` 启动扩展宿主并运行测试。
- `npm run package`：生成经过压缩的生产版 `.vsix`。

使用现有 `package-lock.json` 和 npm 工作流。虽然 `package.json` 声明了 `npm run lint`，但仓库目前没有 ESLint 配置，因此该命令暂不能作为有效验证步骤。

## 编码风格与命名约定

遵循现有 TypeScript 风格：两个空格缩进、单引号、分号，以及多行结构的尾随逗号。保持严格类型，优先使用 `unknown` 并显式缩小类型，避免 `any`。类及对应文件使用 `PascalCase`，如 `AuthManager.ts`；函数和变量使用 `camelCase`；常量使用 `UPPER_SNAKE_CASE`。API 响应兼容处理应保留在 `src/sync/api/`，不要散落到 UI 层。

## 测试规范

测试使用 Mocha TDD 接口和 Node `assert`。测试文件命名为 `*.test.ts`，统一放在 `src/test/suite/`。修改命令注册、鉴权边界、路径安全、同步状态计算、推送校验或冲突保护时，应添加聚焦的回归测试。仓库当前未配置覆盖率阈值，但行为变更应尽可能配套测试。

## Commit 与 Pull Request 规范

提交遵循 Conventional Commits，使用简洁的中文摘要，例如 `feat(sync): 增加推送前远端校验` 或 `docs: 更新使用说明`。类型使用 `feat`、`fix`、`docs`、`test` 或 `chore`，可添加聚焦的 scope。每个提交只处理一个主题。PR 应说明用户可见变化、关联相关 Issue 并列出实际验证结果；涉及侧边栏或状态栏变更时附截图。禁止提交真实凭据，密码和 Cookie 必须存放在 VS Code `SecretStorage` 中。

## 文档与发布

`README.md` 面向扩展使用者，应包含从 GitHub Release 安装 VSIX、首次配置、日常同步、冲突处理、兼容范围和当前限制。修改用户可见行为时，同步更新相关说明。

发布版本时，确保 `package.json` 中的版本号与 Git 标签 `vX.Y.Z` 一致。使用 `npm run package` 生成 VSIX，将其作为 GitHub Release Asset 上传，不要提交到源码仓库。Release Notes 应说明用户可见变化、兼容范围、已知限制、实际验证结果和 VSIX 的 SHA-256 校验值。
