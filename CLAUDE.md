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
extension.ts (入口)
  ├── sync/auth/        鉴权子系统（Weaver RSA + Cookie 会话）
  │   ├── RSACrypto.ts    Weaver 自定义 RSA 加密
  │   ├── AuthManager.ts  登录 + 会话管理
  │   └── TokenStore.ts   VSCode SecretStorage 持久化 Cookie
  ├── sync/api/
  │   ├── EcodeApiClient.ts   HTTP 客户端（Cookie 鉴权）
  │   └── FileApi.ts          Ecode 文件 CRUD
  ├── sync/EcodeSyncEngine.ts  同步编排器（pull + auto-push）
  └── ui/webview/SetupPanel.ts 配置向导 Webview
```

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
- `.vscode/ecode.json` — project settings (future)
- VSCode settings: `ecode.server.url`, `ecode.server.username`, `ecode.localDir`, `ecode.sync.autoPushOnSave`
- Secrets via `vscode.SecretStorage` — Cookie storage

## Reference Implementation

`reference/extension/dist/extension.js` — minified reference from `github.com/wes-lin/ecology-9-ecode`.
API patterns and crypto implementation were derived from this. The directory is `.gitignore`'d.

## Git Workflow
- 按 `chore/*` / `feature/*` / `fix/*` 分支开发
- 每个功能独立分支，commit 前展示改动摘要并确认
- Commit 标题中文：`<type>(<scope>): <中文说明>`

## Test Server
- `http://localhost:8099/` — local E-cology E9
- Admin credentials provided separately (not in code)
