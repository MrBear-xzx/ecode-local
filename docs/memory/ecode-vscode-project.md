---
name: ecode-local-project
description: Ecode Local 项目概述
metadata:
  type: project
---

Ecode Local — 泛微 Ecode 本地开发 VSCode 插件，将在线代码同步到本地编辑。

## 项目定位
- 仓库：`d:\workspace\AiCoding\ecode-local`
- 远程：`git@github.com:MrBear-xzx/ecode-local.git`
- 分支策略：`chore/*` / `feature/*` / `fix/*` → PR → `main`

## 核心目标（按优先级）
1. **保存即同步**：Ctrl+S 自动推送代码到 Ecode 服务器
2. **Git 集成**：GitHub 分支合并 → 自动部署到 Ecode
3. **智能解析**：ecodeSDK.imp/exp 等语法解析（后置）
4. **语言服务**：组件定义跳转、代码补全等（后置）

## 技术栈
- TypeScript + esbuild
- tree-sitter (tree-sitter-javascript WASM) — 语法解析
- node-rsa — Ecode 鉴权
- VSCode Extension API（非 LSP）

## 测试环境
- Ecode 服务器：`http://localhost:8099/`
- 管理员账号密码：待提供

**Why:** 泛微 Ecode 仅支持浏览器在线编辑，无本地 IDE 支持和版本控制。
**How to apply:** 按 Phase 0→1→2→3 顺序开发，优先交付同步功能。
