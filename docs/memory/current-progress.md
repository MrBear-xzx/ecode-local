---
name: current-progress
description: 当前已实现功能进度（v0.1.0）
metadata:
  type: project
---

Ecode Local v0.1.0 已实现功能一览。

## 鉴权子系统

- [x] `RSACrypto.ts` — Weaver 自定义 RSA 加密（240 字符分块、rsa_code 加盐、rsa_flag 连接）
- [x] `TokenStore.ts` — VSCode SecretStorage 封装（Cookie + 密码持久化）
- [x] `AuthManager.ts` — 登录流程（RSA 公钥获取 → 凭据加密 → checkLogin → Cookie 存储）
- [x] 自动登录 — 启动时 Cookie 有效则直接使用，过期则自动密码登录

## HTTP & 文件 API

- [x] `EcodeApiClient.ts` — HTTP 客户端（Cookie 鉴权、30s 超时、JSON/文本解析、401 检测）
- [x] `FileApi.ts` — 文件树（listTree）、文件内容（viewFile）、文件上传（upload/FormData）

## 同步引擎

- [x] `EcodeSyncEngine.ts` — 递归全量拉取（system + typeList 分类 → 目录树遍历） + 冲突保护
- [x] `SyncStateStore.ts` — 本地同步状态清单（SHA-256 哈希基线 + diff）
- [x] 手动推送 — 版本比对 + 增量推送（仅推送有变更的文件）
- [x] 取消支持 — pull 过程支持 CancellationToken

## UI

- [x] `SetupPanel.ts` — Webview 配置向导（表单 + 连接测试 + 凭据保存）
- [x] 状态栏 — 右下角图标 + 悬停菜单（配置、拉取、推送入口）

## 配置项

- [x] `ecode.server.url` / `username` / `appId`
- [x] `ecode.localDir` / `server.autoConnect`

## 待实现

- [ ] 文件删除同步

## 分支状态

当前在 `main` 分支，提交 `77a5572 feat: 实现 Ecode Local 核心功能（鉴权、同步拉取、配置向导）`。

**Why:** 记录已完成功能和待开发项，确保进度可追踪。
**How to apply:** 新功能开发时更新此文件的状态。
