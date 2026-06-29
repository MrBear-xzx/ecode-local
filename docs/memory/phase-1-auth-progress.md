---
name: phase-1-auth-progress
description: Phase 1 鉴权与 HTTP 客户端进度
metadata:
  type: project
---

Phase 1 鉴权模块进度。

## 已完成
- [x] `RSACrypto.ts` — RSA 公钥加密（Node.js 内置 crypto，无额外依赖）
- [x] `TokenStore.ts` — VSCode SecretStorage 封装（token/secret/appId 安全存储）
- [x] `AuthManager.ts` — 三步 Token 鉴权流程（regist → applytoken → store）
- [x] `EcodeApiClient.ts` — HTTP 客户端（401 检测、超时控制、JSON/文本响应）
- [x] `FileApi.ts` — 文件 CRUD API（list/get/upload/delete/scanUpgrade）
- [x] `types.ts` — 鉴权/文件/配置类型定义
- [x] `extension.ts` 命令接入 — login/logout/configure 真实逻辑
- [x] 状态栏联动态 — 未连接/登录中/已连接/Auth Failed
- [x] `ecode.server.appId` 配置项
- [x] TypeScript 类型检查零错误

## 依赖
- 全部使用 Node.js 内置模块（crypto），无额外运行时依赖

## 待验证
- [ ] 连接 `http://localhost:8099/` 测试真实鉴权流程
- [ ] 确认 API 端点实际路径是否匹配

## 当前分支
`feature/auth`

**Why:** Phase 1 实现 Ecode Token 鉴权的完整流程，为 Phase 2 同步引擎提供认证基础。
**How to apply:** F5 启动后执行 Ecode: Configure → Ecode: Login。
