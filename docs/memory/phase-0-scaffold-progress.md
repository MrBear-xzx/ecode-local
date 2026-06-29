---
name: phase-0-scaffold-progress
description: Phase 0 脚手架搭建进度
metadata:
  type: project
---

Phase 0 项目脚手架进度。

## 已完成
- [x] `package.json` — 插件清单、5 个命令、3 个配置项
- [x] `tsconfig.json` — TypeScript 编译配置
- [x] `esbuild.mjs` — esbuild 打包（支持 --watch / --production）
- [x] `src/extension.ts` — activate/deactivate、命令占位、状态栏
- [x] `src/test/runTest.ts` — 集成测试启动器
- [x] `src/test/suite/index.ts` + `extension.test.ts` — Mocha 测试
- [x] `.vscode/launch.json` / `tasks.json` / `settings.json` — 调试配置
- [x] `.gitignore` / `README.md` — 项目元信息

## 待完成
- [ ] `npm install` — 安全分类器拦截中，需用户手动执行
- [ ] `npm run build` — 验证编译通过
- [ ] F5 调试验证插件加载

## 当前分支
`chore/scaffold`

**Why:** 记录 Phase 0 推进状态，确保所有交付物可追踪。
**How to apply:** npm install 后即可 F5 验证。
