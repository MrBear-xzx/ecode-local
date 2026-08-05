# 开发与验证

本文面向扩展开发者。协作规则和代码约定以仓库根目录的 [AGENTS.md](../AGENTS.md) 为准。

## 文档职责

| 文档 | 主要受众 | 应包含的内容 |
| --- | --- | --- |
| `README.md` | 扩展使用者 | 产品定位、安装、首次上手、核心流程和关键限制 |
| `docs/user-guide.md` | 扩展使用者 | 详细操作、安全规则、异常处理和常见问题 |
| `CHANGELOG.md` | 使用者与维护者 | 各版本的用户可感知变化、迁移要求和兼容性调整 |
| `docs/development.md` | 开发者 | 目录结构、构建验证和发布流程 |
| `AGENTS.md` | 开发 Agent | 仓库约束、编码规范、测试要求和提交规则 |
| `resources/skills/ecode-local/` | 用户工作区中的 Agent | CLI 操作接口、授权要求和 Ecode 代码约束 |

同一说明只在最符合其用途的文档中完整维护，其他位置使用链接或简短提示。用户可见行为变化时，优先更新使用指南和更新日志；仅当首次上手或关键限制发生变化时再修改 README。

## 项目结构

- `src/extension.ts`：扩展激活、命令注册和 VS Code 生命周期。
- `src/domain/`：不依赖 VS Code 或网络的同步模型、文本处理和路径安全逻辑。
- `src/sync/`：鉴权、API 适配、JavaScript 编译和同步编排。
- `src/storage/`：环境配置、清单、快照、冲突和恢复数据。
- `src/ui/`：侧边栏和虚拟差异文档。
- `src/test/suite/`：Mocha 扩展宿主测试。
- `resources/skills/ecode-local/`：随扩展生成到用户工作区的 Agent Skill、CLI 和接口参考。

`out/`、`dist/`、`node_modules/` 和 `.vsix` 是构建产物，不应手工修改或提交。

## 常用命令

项目使用现有 `package-lock.json` 和 npm 工作流。

```bash
npm run build
npm run lint
npx tsc --noEmit
npm test
```

- `npm run build`：使用 esbuild 生成 `out/extension.js` 和 source map。
- `npm run watch`：持续构建，配合 VS Code 的 **Run Extension** 或 F5 调试。
- `npm run lint`：检查 `src/` 下的 TypeScript。
- `npx tsc --noEmit`：执行严格类型检查。
- `npm test`：编译测试并启动 VS Code Extension Host。
- `npm run package`：生成生产版 VSIX。

验证时先运行与改动最相关的测试，再根据影响范围运行 Lint、类型检查、构建和完整测试。修改用户可见行为时，应同时更新 README、使用指南或更新日志。

## 发布检查

发布版本时确保 `package.json` 版本号与 Git 标签 `vX.Y.Z` 一致。VSIX 通过 `npm run package` 生成并上传到 GitHub Release，不提交到源码仓库。

Release Notes 应说明用户可见变化、兼容范围、已知限制和实际验证结果，并提供 VSIX 的 SHA-256。
