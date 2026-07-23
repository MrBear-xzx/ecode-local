# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Ecode Local — 泛微 Ecode VSCode 本地开发插件，将 E-cology 9 OA 系统中的 Ecode 在线代码同步到本地编辑。核心功能：**手动推送**本地代码到服务器。

- 技术栈：TypeScript + esbuild + VSCode Extension API
- 目标 VSCode 版本：^1.93.0
- esbuild target: node18, format: cjs, external: vscode

## Build & Test

```bash
npm run build          # esbuild 打包（开发模式，含 sourcemap）
npm run watch          # 监听模式（F5 调试用，配合 .vscode/launch.json）
npx tsc --noEmit       # 仅类型检查（esbuild 不做类型检查，CI 前必须跑）
npm run test           # 集成测试（需先 build，通过 @vscode/test-electron 启动扩展宿主）
npm run package        # 打包 .vsix（自动使用 --production 模式，minify + 无 sourcemap）
```

- F5 调试：`launch.json` 有两个配置 — "Run Extension"（手动测试）和 "Extension Tests"（跑集成测试）
- 测试文件：`src/test/suite/extension.test.ts`（Mocha + assert，当前仅验证扩展激活和命令注册）
- **注意**：`npm run lint` 命令在 `package.json` 中定义了，但项目根目录缺少 ESLint 配置文件，该命令当前无法正常运行

## Architecture

```
extension.ts (入口 — activate/deactivate + 命令注册 + 状态栏)
  ├── sync/
  │   ├── auth/
  │   │   ├── RSACrypto.ts      Weaver 自定义 RSA 加密
  │   │   ├── AuthManager.ts    登录 + 会话管理 + 自动登录
  │   │   └── TokenStore.ts     VSCode SecretStorage 持久化 Cookie/密码
  │   ├── api/
  │   │   ├── EcodeApiClient.ts   HTTP 客户端（Cookie 鉴权 + 超时控制 + fetch 封装）
  │   │   ├── FileApi.ts          Ecode 文件 CRUD（tree/view/upload）
  │   │   └── types.ts            API 类型定义（部分类型如 RegistResponse 未使用，属历史遗留）
  │   ├── EcodeSyncEngine.ts     同步编排器（递归 pull + 手动 push + 版本比对）
  │   └── SyncStateStore.ts      本地同步状态清单（SHA-256 基线 + diff）
  ├── constants.ts                固定配置常量（本地同步目录名）
  └── ui/webview/SetupPanel.ts  配置向导 Webview（表单 + 连接测试）
```

### 延迟初始化模式

- `AuthManager` 持有 `EcodeApiClient | null`，`getClient()` 方法按需创建
- `EcodeSyncEngine` 持有 `FileApi | null` 和 `SyncStateStore | null`，分别通过 `getFileApi()` 和 `getStateStore()` 懒加载
- `SyncStateStore` 的 manifest 也是懒加载（`load()` 首次调用时读盘），持久化路径：`<workspace>/.ecode/sync-state.json`

### 启动流程

1. `activate()` → 注册命令、创建 OutputChannel、初始化 AuthManager 和 SyncEngine
2. 检查 SecretStorage 是否有 Cookie → 有则验证有效性（调 `/api/ecode/type/tree` 判 `status === true`）
3. Cookie 有效 → 自动登录成功；无效/无 → 检查是否有密码
4. 有密码+服务器地址 → 自动 RSA 登录
5. 无凭据 → 弹出 Setup 配置向导
6. 配置向导完成后自动触发一次全量 pull

### 命令注册

三个命令均注册在 `extension.ts` 中（非 `package.json` 声明即自动注册）：
- `ecode.setup` — 打开 Webview 配置面板
- `ecode.menuPull` — 状态栏拉取（手动触发全量下载）
- `ecode.menuPush` — 状态栏推送（对比变更 → 确认 → 增量上传）

**注意**：当前没有 `onDidSaveTextDocument` 监听器，"保存即自动推送" 尚未实现。

## Key Technical Details

### Weaver RSA Login (NOT standard token auth)

- GET `/rsa/weaver.rsa.GetRsaInfo` → `{rsa_pub, rsa_code, rsa_flag}`
- POST `/api/hrm/login/checkLogin` (form-urlencoded) — RSA 加密的 loginid + userpassword
- Auth: Cookie `ecology_JSessionid`，NOT Bearer token
- 登录前先 GET 首页获取初始 session cookie（服务器可能通过 set-cookie 下发）

### RSA Encryption (Weaver-specific)

- 240-char chunking → per-chunk `encrypt(chunk + rsa_code) + rsa_flag`
- Standard RSA PKCS1 padding via Node.js built-in `crypto.publicEncrypt`
- Key normalization: base64 DER → PEM (64-char line wrapping)
- `RSACrypto.encryptWithRsa()` 是入口，`encryptBlock()` 处理单块加密

### Ecode API Endpoints

- `GET /api/ecode/type/tree?folderId=X&typeId=Y` — 文件树（folderId 和 typeId 互斥）
- `GET /api/cloudstore/ecode/one?id=X` — 文件内容（响应结构为 `{data: {content: "..."}}` 或 `{content: "..."}`）
- `POST /api/ecode/upload` (FormData: path, file) — 上传文件
- `POST /api/ecode/download` (body: {path}) — 下载（已定义未使用）

### API 响应约定

- 统一包装 `ApiResponse<T>`：`{status: boolean, msg?: string, data?: T}`
- 注意字段名：`status` 不是 `success`，`msg` 不是 `message`
- 服务器响应结构不一致（有时 data 嵌套在 `{data: {data: ...}}` 中），`EcodeApiClient.request()` 和 `FileApi.viewFile()` 分别做了多层兼容解析

### 同步状态管理

- Manifest 文件：`<workspace>/.ecode/sync-state.json`（JSON，version 1）
- 每条记录：`{hash: SHA-256, remoteId?: string, syncedAt: ISO-8601}`
- `diff()` 算法：遍历本地文件 → 与 manifest 比对 → 输出 added/modified/deleted
- pull 冲突保护：下载前比对本地文件 SHA-256 与 manifest 基线，不一致则跳过（记录到 `conflicts`），避免覆盖未推送的本地修改
- push 后自动更新 manifest 基线

### Configuration

- `ecode.server.url` — E-cology 服务器地址
- `ecode.server.username` — 登录用户名（默认 sysadmin）
- `ecode.server.appId` — Ecode App ID（可选，UUID）
- `ecode.server.autoConnect` — 启动时自动连接（默认 true）
- Secrets via `vscode.SecretStorage` — Cookie、密码持久化（key: `ecode.auth.cookie`, `ecode.auth.password`）

## Current Status

**已实现：**
- Weaver RSA 登录（Cookie 会话鉴权，自动登录 + 过期自动重登）
- 全量递归文件树拉取（带 SHA-256 冲突保护）
- 手动推送（增量：仅推送变更文件，推送前展示 diff 摘要并确认）
- Webview 配置向导
- 状态栏快捷操作（悬停菜单含拉取/推送/配置入口）

**待实现：**
- 文件删除同步到服务器
- 保存时自动推送（`onDidSaveTextDocument`）
- 文件监听 + 自动 diff

**注意**：`package.json` 声明了 `adm-zip`、`simple-git` 依赖，当前源码中未使用，属预留依赖。README.md 中描述的 `ecode.sync.autoPushOnSave` 等配置项尚未在 `package.json` 中定义，README 描述的是目标状态而非当前实现。

## Git Workflow

- 按 `chore/*` / `feature/*` / `fix/*` 分支开发
- 每个功能独立分支，commit 前展示改动摘要并确认
- Commit 标题中文：`<type>(<scope>): <中文说明>`

## Test Server

- `http://localhost:8099/` — local E-cology E9
- Admin credentials provided separately (not in code)
