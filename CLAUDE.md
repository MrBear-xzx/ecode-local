# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Ecode Local — 泛微 Ecode VSCode 本地开发插件，将 E-cology 9 OA 系统中的 Ecode 在线代码同步到本地编辑。核心功能：**保存即自动同步**到服务器。

- 技术栈：TypeScript + esbuild + VSCode Extension API
- 目标 VSCode 版本：^1.93.0

## Build & Test

```bash
npm run build          # esbuild 打包
npm run watch          # 监听模式（F5 调试用）
npx tsc --noEmit       # 仅类型检查（esbuild 不做类型检查）
npm run test           # 运行集成测试（需编译后）
npm run package        # 打包 .vsix
```

## Architecture

```
extension.ts (入口 — activate/deactivate + 命令注册 + 状态栏)
  ├── sync/auth/        鉴权子系统（Weaver RSA + Cookie 会话）
  │   ├── RSACrypto.ts    Weaver 自定义 RSA 加密
  │   ├── AuthManager.ts  登录 + 会话管理 + 自动登录
  │   └── TokenStore.ts   VSCode SecretStorage 持久化 Cookie/密码
  ├── sync/api/
  │   ├── EcodeApiClient.ts   HTTP 客户端（Cookie 鉴权 + 超时控制）
  │   └── FileApi.ts          Ecode 文件 CRUD（tree/view/upload）
  ├── sync/EcodeSyncEngine.ts  同步编排器（递归 pull + save→push）
  └── ui/webview/SetupPanel.ts 配置向导 Webview（表单 + 连接测试）
```

### 启动流程

1. `activate()` → 注册命令、启用自动同步
2. 检查 SecretStorage 是否有 Cookie → 有则验证有效性
3. Cookie 有效 → 自动登录成功；无效/无 → 检查是否有密码
4. 有密码+服务器地址 → 自动 RSA 登录
5. 无凭据 → 弹出 Setup 配置向导

## Key Technical Details

### Weaver RSA Login (NOT standard token auth)

- GET `/rsa/weaver.rsa.GetRsaInfo` → `{rsa_pub, rsa_code, rsa_flag}`
- POST `/api/hrm/login/checkLogin` (form-urlencoded) — RSA 加密的 loginid + userpassword
- Auth: Cookie `ecology_JSessionid`, NOT Bearer token

### RSA Encryption (Weaver-specific)

- 240-char chunking → per-chunk `encrypt(chunk + rsa_code) + rsa_flag`
- Standard RSA PKCS1 padding via Node.js built-in `crypto.publicEncrypt`
- Key normalization: base64 DER → PEM (64-char line wrapping)

### Ecode API Endpoints

- `GET /api/ecode/type/tree` — file tree
- `GET /api/cloudstore/ecode/one?id=X` — file content
- `POST /api/ecode/upload` (FormData: path, file) — upload
- `POST /api/ecode/download` (body: {path}) — download

### Configuration

- `ecode.server.url` — E-cology 服务器地址
- `ecode.server.username` — 登录用户名（默认 sysadmin）
- `ecode.server.appId` — Ecode App ID（可选，UUID）
- `ecode.localDir` — 本地代码目录（默认 ecode）
- `ecode.server.autoConnect` — 启动时自动连接（默认 true）
- `ecode.sync.autoPushOnSave` — 保存自动推送（默认 true）
- `ecode.sync.debounceMs` — 推送防抖延迟（默认 300ms）
- Secrets via `vscode.SecretStorage` — Cookie 和密码持久化

### Current Status (v0.1.0)

**已实现：**
- Weaver RSA 登录（Cookie 会话鉴权）
- 全量递归文件树拉取
- 保存文件自动推送到服务器（FormData upload）
- Webview 配置向导
- 状态栏快捷操作（拉取/推送入口）

**待实现：**
- 手动推送命令（菜单入口已预留，逻辑未实现）
- 增量同步 / 差异对比
- 文件删除同步

## Git Workflow

- 按 `chore/*` / `feature/*` / `fix/*` 分支开发
- 每个功能独立分支，commit 前展示改动摘要并确认
- Commit 标题中文：`<type>(<scope>): <中文说明>`

## Test Server

- `http://localhost:8099/` — local E-cology E9
- Admin credentials provided separately (not in code)
