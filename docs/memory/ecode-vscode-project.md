---
name: ecode-local-project
description: Ecode Local 项目概述
metadata:
  type: project
---

Ecode Local — 泛微 Ecode 本地开发 VSCode 插件，将 E-cology 9 OA 系统中的 Ecode 在线代码同步到本地编辑。

## 项目定位
- 仓库：`d:\workspace\AiCoding\ecode-local`
- 远程：`git@github.com:MrBear-xzx/ecode-local.git`
- 分支策略：`chore/*` / `feature/*` / `fix/*` → PR → `main`

## 核心功能
1. **保存即同步**：Ctrl+S 自动推送文件到 Ecode 服务器
2. **全量拉取**：递归下载服务器文件树到本地
3. **配置向导**：Webview 表单配置服务器连接

## 技术栈
- TypeScript + esbuild（打包，不做类型检查）
- Node.js crypto 内置模块（RSA 加密，无 node-rsa 依赖）
- VSCode Extension API（非 LSP）
- VSCode SecretStorage（凭据持久化）
- target VSCode ^1.93.0

## 测试环境
- Ecode 服务器：`http://localhost:8099/`
- 管理员账号密码：不提交到仓库

**Why:** 泛微 Ecode 仅支持浏览器在线编辑，无本地 IDE 支持和版本控制。
**How to apply:** 按已实现功能维护文档，后续需求按 feature 分支迭代。
