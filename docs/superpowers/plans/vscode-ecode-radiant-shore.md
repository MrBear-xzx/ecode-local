# VSCode Ecode 插件实现计划

## 背景与目标

泛微（Weaver）Ecode 是嵌入在 E-cology 9 OA 系统中的在线前端低代码开发平台。开发者在浏览器编辑器中编写代码，使用自定义的模块系统（`ecodeSDK.imp/exp` 代替 `import/export`），所有开发依赖在线环境，无法离线编辑，也没有 Git 版本控制集成。

本插件目标是：
1. **保存即同步（核心体验）**：本地编辑 JS/CSS/MD 文件，Ctrl+S 保存时自动推送到 Ecode 服务器，无需任何手动命令
2. **智能解析**：解析 Ecode 特有语法（`ecodeSDK.imp/exp`、组件引用、异步加载等）
3. **语言服务**：提供组件定义跳转、代码补全、悬停提示、错误诊断等，覆盖 PC/Mobile 全部全局组件库
4. **Git 集成**：支持 GitHub 分支合并后自动推送代码到 Ecode 服务器（CI/CD）

---

## Ecode 全局组件库全景

Ecode 基于 **React 16.x**，所有第三方库在运行时全局可用，**不需要也不允许** `import`。PC 端和移动端使用不同的路由版本和组件库。

### PC 端全局库（6 个）

| 全局变量 | 对应库 | 版本 | 说明 |
|---------|--------|------|------|
| `React` | react | 16.x | React 核心 |
| `antd` | antd | **1.x**（非最新版） | Ant Design 组件库 |
| `ecCom` | Ecology 封装 | — | 120+ PC 组件（WeaTop, WeaInput, WeaTable, WeaTablePage, WeaTableNew, WeaTableEditable 等） |
| `mobx` | mobx | — | 状态管理 |
| `mobxReact` | mobx-react | — | MobX React 绑定（observer, Provider, inject） |
| `ReactRouterDom` | react-router | **v3**（PC 端） | 路由（withRouter 等） |

**组件依赖链：** `comsMobx` → `ecCom` → `antd` → `React`

### 移动端全局库（4 个）

| 全局变量 | 对应库 | 版本 | 说明 |
|---------|--------|------|------|
| `WeaverMobile` | 移动端基础组件 | — | 90+ 组件（Button, Tools, WingBlank 等） |
| `WeaverMobilePage` | 页面级组件 | — | AtSomeone 等页面组件 |
| `mobxReact` | mobx-react | — | observer, inject, Provider |
| `ReactRouterDom` | react-router | **v4**（移动端） | withRouter, BrowserRouter, Route, Link |

### 模块系统 API

| 语法 | 用途 | 作用域 |
|------|------|--------|
| `ecodeSDK.exp(Component)` | 导出组件 | 同一发布文件夹内 |
| `ecodeSDK.imp(Component)` | 导入组件 | 同一发布文件夹内 |
| `ecodeSDK.setCom(appId, name, Com)` | 全局注册组件 | 跨文件夹/跨模块 |
| `ecodeSDK.getCom(appId, name)` | 获取全局组件 | 任意位置 |
| `ecodeSDK.getAsyncCom({appId, name, ...})` | 异步加载组件 | 前置脚本中 |
| `ecodeSDK.load({id, noCss, cb})` | 外部加载模块 | 表单/建模代码 |

### 组件复写 API

| API | 用途 |
|-----|------|
| `ecodeSDK.overwritePropsFnQueueMapSet(name, option)` | 复写 PC 组件 props |
| `ecodeSDK.overwriteClassFnQueueMapSet(name, option)` | 完全替换 PC 组件 |
| `ecodeSDK.overwriteMobilePropsFnQueueMapSet(name, option)` | 复写移动端组件 props |
| `ecodeSDK.overwriteMobileClassFnQueueMapSet(name, option)` | 完全替换移动端组件 |

### API 拦截 API

| API | 用途 |
|-----|------|
| `ecodeSDK.rewriteApiDataQueueSet(fn)` | 修改 API 响应数据 |
| `ecodeSDK.rewriteApiParamsQueueSet(fn)` | 修改 PC API 请求参数 |
| `ecodeSDK.rewriteMobileApiParamsQueueSet(fn)` | 修改移动端 API 请求参数 |

---

## 架构决策

### 1. 技术选型
| 决策点 | 选择 | 理由 |
|--------|------|------|
| 语言服务实现 | VSCode 原生 Provider API | Ecode 本质是 JavaScript，不需要 LSP 的跨编辑器能力 |
| 语法解析 | tree-sitter (tree-sitter-javascript WASM) | 需要真实 AST 来解析各种 `ecodeSDK.*` 调用模式 |
| 构建工具 | esbuild | VSCode 插件标准方案，快速打包 |
| 代码同步 | 三层策略（REST API > ZIP > 手动）+ Git CI/CD | 多策略兜底，Git 集成实现自动化部署 |
| 鉴权加密 | node-rsa + VSCode SecretStorage | 实现 Ecode Token 鉴权流程 |
| Git 集成 | GitHub Actions workflow 模板 + VSCode 命令 | 代码合并即部署 |

### 2. 不使用 LSP 的理由
Ecode 语言就是 JavaScript + 特殊的全局函数调用。所有语言功能在单文件分析 + 工作区符号索引即可完成，无需 LSP 的 JSON-RPC 传输层和独立进程。未来如需迁移到 LSP，ParserEngine 和 ComponentResolver 可以直接抽离。

---

## 项目结构

```
ecode-local/
├── src/
│   ├── extension.ts                # 入口：activate/deactivate
│   ├── constants.ts                # 全局常量
│   │
│   ├── data/                       # 静态数据（全局库成员定义）
│   │   ├── pc-libs.ts              # antd、ecCom、mobx、mobxReact、ReactRouterDom(v3) 成员
│   │   ├── mobile-libs.ts          # WeaverMobile、WeaverMobilePage、mobxReact、ReactRouterDom(v4) 成员
│   │   └── ecode-sdk.ts            # ecodeSDK 完整 API 签名定义
│   │
│   ├── sync/                       # 代码同步子系统
│   │   ├── EcodeSyncEngine.ts      # 同步编排器
│   │   ├── auth/
│   │   │   ├── AuthManager.ts      # Token 生命周期管理
│   │   │   ├── RSACrypto.ts        # RSA 加解密
│   │   │   └── TokenStore.ts       # SecretStorage 封装
│   │   ├── api/
│   │   │   ├── EcodeApiClient.ts   # HTTP 客户端
│   │   │   ├── FileApi.ts          # 文件 CRUD API
│   │   │   └── types.ts
│   │   └── transport/
│   │       ├── FileIndexer.ts      # 本地/远程文件索引与 diff
│   │       ├── Downloader.ts       # 批量下载
│   │       ├── Uploader.ts         # 批量上传
│   │       └── ZipHandler.ts       # ZIP 补丁导入/导出
│   │
│   ├── parser/                     # 语法解析子系统
│   │   ├── ParserEngine.ts         # tree-sitter 初始化、解析、缓存
│   │   ├── queries/
│   │   │   ├── impQuery.ts         # ecodeSDK.imp() 模式
│   │   │   ├── expQuery.ts         # ecodeSDK.exp() 模式
│   │   │   ├── getComQuery.ts      # ecodeSDK.getCom/setCom 模式
│   │   │   ├── loadQuery.ts        # ecodeSDK.load/getAsyncCom 模式
│   │   │   ├── overwriteQuery.ts   # overwritePropsFnQueueMapSet 等模式
│   │   │   └── globalLibQuery.ts   # 全局库解构引用模式
│   │   ├── resolvers/
│   │   │   ├── ComponentResolver.ts   # imp/getCom → 文件路径解析
│   │   │   ├── GlobalLibResolver.ts   # 全局库成员解析（查 data/ 定义表）
│   │   │   └── OverwriteResolver.ts   # 组件复写目标解析
│   │   └── types.ts
│   │
│   ├── features/                   # 语言服务 Provider
│   │   ├── DefinitionProvider.ts   # 跳转到定义
│   │   ├── CompletionProvider.ts   # 代码补全
│   │   ├── HoverProvider.ts        # 悬停提示
│   │   ├── DiagnosticProvider.ts   # 错误/警告诊断
│   │   ├── SignatureHelpProvider.ts # 函数参数提示（ecodeSDK API）
│   │   └── ReferenceProvider.ts    # 查找引用
│   │
│   ├── project/                    # 项目管理
│   │   ├── ProjectManager.ts       # 多项目配置管理
│   │   └── ConfigLoader.ts         # .vscode/ecode.json 读写
│   │
│   ├── git/                        # Git 集成子系统
│   │   ├── GitIntegration.ts       # Git 集成入口
│   │   ├── GitHubActions.ts        # GitHub Actions workflow 生成与管理
│   │   ├── BranchSyncConfig.ts     # 分支→Ecode 映射配置
│   │   └── templates/
│   │       └── deploy.yml.hbs      # GitHub Actions workflow 模板
│   │
│   ├── ui/
│   │   ├── tree/
│   │   │   ├── SyncTreeProvider.ts
│   │   │   └── BranchTreeProvider.ts  # 分支同步状态树
│   │   └── webview/
│   │       └── SyncPanel.ts
│   │
│   └── test/
│       ├── fixtures/               # Ecode .js 测试文件
│       └── suite/
│
├── .github/                        # 插件自身的 CI（非模板）
│   └── workflows/
│       └── ci.yml
├── syntaxes/
│   └── ecode.tmLanguage.json       # TextMate 语法注入
├── schemas/
│   └── ecode-config.schema.json    # .vscode/ecode.json 的 JSON Schema
├── templates/                      # 用户可用的模板
│   └── github-deploy.yml           # 分发用的 GitHub Actions 模板
├── package.json
├── tsconfig.json
├── esbuild.mjs
└── README.md
```

---

## 核心交互模型：保存即同步

**这是整个插件的核心设计理念。** 用户在 VSCode 中编辑 `.js`、`.css`、`.md` 文件，按下 `Ctrl+S` —— 除此之外什么都不用做：

```
用户编辑代码 → Ctrl+S 保存 → 插件自动推送至 Ecode 服务器 → 服务器即时生效
```

### 自动同步流程

```
VSCode onDidSaveTextDocument 事件
        ↓
检查文件是否属于 Ecode 项目（.vscode/ecode.json 管理的目录）
        ↓
将文件加入推送队列（Debounce 300ms，合并连续保存）
        ↓
EcodeSyncEngine.pushFile(uri)
        ↓
  ┌─ Tier 1: REST API 推送（优先）
  │   POST /api/ec/dev/app/{appId}/file → 服务器更新
  │
  └─ Tier 2: ZIP 推送（兜底）
      打包变更文件 → POST ZIP → 触发扫描部署
        ↓
状态栏即时反馈：✓ 已同步 / ⚠ 同步失败（可点击查看详情）
```

### 手动命令（仅用于特殊场景）

| 命令 | 使用场景 |
|------|---------|
| `Ecode: Pull Code` | 首次从服务器拉取全部代码 |
| `Ecode: Force Push All` | 批量推送（非保存触发的全量同步） |
| `Ecode: Resolve Conflicts` | 极少发生：本地和远程同时修改时的冲突处理 |
| `Ecode: Import ZIP` | 离线导入补丁包 |

---

## 代码同步策略（四层）

### Tier 1: REST API 推送（保存时自动触发，优先方案）
- 利用 Ecode Token 鉴权体系（`/api/ec/dev/auth/regist` + `/api/ec/dev/auth/applytoken`）
- 单文件推送：`POST /api/ec/dev/app/{appId}/file?path=...`
- 轻量、快速，适合高频保存触发

### Tier 2: ZIP 补丁推送（API 不可用时的兜底）
- 将变更文件打包为 Ecode 标准补丁 ZIP → POST 到服务器
- 触发 `/api/ecode/scanUpgradePackage` 使服务器扫描部署

### Tier 3: ZIP 导入（手动，离线/初次导入场景）
- 解析 Ecode 标准补丁 ZIP 格式（`ecology/cloudstore/autorelease/{appId}.zip`）
- 本地上传 ZIP → 网页端导入

### Tier 4: Git CI/CD 自动部署（团队协作场景）
- **场景**：代码在本地编辑 → `git push` 到 GitHub → 创建 PR → 合并到目标分支 → **自动触发 Ecode 更新**
- 插件生成 GitHub Actions workflow 文件（`.github/workflows/ecode-deploy.yml`）
- Workflow 在 PR 合并到指定分支后：
  1. 收集变更文件
  2. 通过 API（或 ZIP）将变更推送到 Ecode 服务器
  3. 触发 `/api/ecode/scanUpgradePackage` 使服务器扫描部署
- 分支映射配置示例：
```json
{
  "git": {
    "provider": "github",
    "branchMappings": [
      { "branch": "main",     "ecodeEnv": "production",  "autoDeploy": true },
      { "branch": "develop",  "ecodeEnv": "staging",     "autoDeploy": true },
      { "branch": "feature/*","ecodeEnv": "dev",         "autoDeploy": false }
    ]
  }
}
```

---

## 语法解析设计

### 核心查询模式

| Ecode 语法 | tree-sitter 模式 | 解析结果 |
|-----------|-----------------|---------|
| `ecodeSDK.imp(Component)` | `call_expression` + 成员表达式匹配 | 组件名 → 查找 exp 定义 |
| `ecodeSDK.exp(Component)` | 同上 | 注册为符号定义 |
| `ecodeSDK.setCom(appId, name, Com)` | 同上 | 全局组件注册 |
| `ecodeSDK.getCom(appId, name)` | 同上 | 跨文件夹组件引用 |
| `ecodeSDK.getAsyncCom({appId, name, ...})` | 同上（对象参数） | 异步组件引用 |
| `ecodeSDK.load({id, noCss, cb})` | 同上（对象参数 + 回调） | 异步模块加载 |
| `ecodeSDK.overwritePropsFnQueueMapSet(name, {...})` | 同上 | 组件复写注册 |
| `ecodeSDK.overwriteClassFnQueueMapSet(name, {...})` | 同上 | 组件替换注册 |
| `const {Button} = antd` | 对象解构模式 + 全局变量名检查 | 全局库成员引用 |
| `antd.Button` 直接属性访问 | 成员表达式 + 全局变量名检查 | 全局库成员引用 |

### 全局库成员解析

插件的 `src/data/` 目录维护静态定义表，记录每个全局库的已知成员：

```typescript
// src/data/pc-libs.ts — 示例结构
export const GLOBAL_LIBS = {
  antd: {
    version: '1.x',
    docUrl: 'https://1x.ant.design/components/',
    members: {
      Button: { kind: 'Component', props: ['type', 'size', 'icon', 'loading', 'ghost', 'onClick'] },
      Table:  { kind: 'Component', props: ['columns', 'dataSource', 'pagination', 'rowSelection', 'onChange'] },
      Modal:  { kind: 'Component', props: ['title', 'visible', 'onOk', 'onCancel', 'footer'] },
      // ... 完整 antd 1.x 组件列表
    }
  },
  ecCom: {
    version: 'ec9',
    docUrl: 'https://cloudstore.e-cology.cn/#/pc/doc/common-index',
    members: {
      WeaTop:      { kind: 'Component', desc: '顶部工具栏' },
      WeaInput:    { kind: 'Component', desc: '输入框组件' },
      WeaTable:    { kind: 'Component', desc: '普通列表' },
      WeaTablePage:{ kind: 'Component', desc: '分页列表' },
      WeaTableNew:  { kind: 'Component', desc: '分页数据列表（MobX）' },
      WeaTableEditable: { kind: 'Component', desc: '可编辑列表' },
      WeaSelect:   { kind: 'Component', desc: '下拉选择' },
      WeaBrowser:  { kind: 'Component', desc: '浏览对话框' },
      WeaReqTop:   { kind: 'Component', desc: '流程表单顶栏按钮区' },
      WeaTools:    { kind: 'Utility',  desc: '工具函数（callApi 等）' },
      // ... 120+ 组件
    }
  },
  mobx: {
    members: {
      observable: { kind: 'Function' },
      computed:   { kind: 'Function' },
      action:     { kind: 'Function' },
      toJS:       { kind: 'Function' },
      // ...
    }
  },
  mobxReact: {
    members: {
      observer: { kind: 'Function' },
      Provider: { kind: 'Component' },
      inject:   { kind: 'Function' },
    }
  },
  ReactRouterDom: {
    version: 'v3', // PC 端
    members: {
      withRouter:     { kind: 'HOC' },
      Link:           { kind: 'Component' },
      Route:          { kind: 'Component' },
      browserHistory: { kind: 'Utility' },
      hashHistory:    { kind: 'Utility' },
    }
  },
  React: {
    version: '16.x',
    members: {
      Component:   { kind: 'Class' },
      PureComponent: { kind: 'Class' },
      useState:    { kind: 'Hook' },     // 注意：16.8+ 才有 Hooks
      useEffect:   { kind: 'Hook' },
      createElement: { kind: 'Function' },
      Fragment:    { kind: 'Component' },
      // ...
    }
  }
};
```

移动端库同理（`src/data/mobile-libs.ts`）。

### 组件解析流程（含全局库）
```
1. 启动时遍历工作区所有 .js 文件，构建 WorkspaceIndex
2. 对于 ecodeSDK.imp(Component)：
   a. 先在同一个 app 文件夹内查找 ecodeSDK.exp(Component)
   b. 再查找兄弟文件夹
   c. 最后查找全局注册的 setCom(appId, 'Component')
3. 对于 const {X} = antd / antd.X：
   → 查 GLOBAL_LIBS.antd.members[X]，返回类型/文档信息
4. 文件变更时增量更新索引
```

---

## 语言服务功能（含全局库支持）

| 功能 | 触发方式 | 实现要点 |
|------|---------|---------|
| **跳转到定义** | Ctrl+Click / F12 | imp→exp、getCom→setCom、antd.X→库定义/文档 |
| **代码补全** | 输入时触发 | imp( → 已导出组件；getCom( → 全局组件；const { → 全局库成员；antd. → antd 组件 |
| **悬停提示** | 鼠标悬停 | imp → 来源文件+预览；antd.X → 参数列表+文档链接；ecodeSDK API → 参数签名 |
| **签名帮助** | 输入 `(` 时 | ecodeSDK.imp/exp/setCom/getCom/load/overwrite* 等完整 API 签名提示 |
| **错误诊断** | 打开/保存时 | 未解析的 imp、未使用的 exp、未知全局库成员、错误版本的 API 使用 |
| **查找引用** | Shift+F12 | 查找 exp 组件的所有 imp 引用、setCom 的所有 getCom 引用 |
| **语法高亮** | 始终 | TextMate 语法注入：高亮 ecodeSDK.* 调用为关键字风格 |

### 特别注意的版本差异
- `antd` 使用 **1.x** API，补全和悬停提示需使用 1.x 文档
- PC 端 `ReactRouterDom` 是 **v3** API，移动端是 **v4** API
- `React` 16.8+ 支持 Hooks，但部分 Ecology 环境可能仍使用 Class Component 为主

---

## Git 集成设计

### 整体流程
```
开发者本地编辑 → git commit → git push → GitHub PR → 合并到目标分支
                                                          ↓
                                             GitHub Actions 自动触发
                                                          ↓
                                  收集变更文件 → 打包/API 推送 → Ecode 服务器
                                                          ↓
                                              服务器自动扫描部署
```

### 插件提供的 Git 功能

#### 1. 初始化 Git 集成
- 命令：`Ecode: Setup Git Integration`
- 在项目根目录生成 `.github/workflows/ecode-deploy.yml`
- 在工作区 `.vscode/ecode.json` 中添加 `git` 配置段
- 交互式引导：选择 GitHub 仓库、配置分支映射、设置 Secrets

#### 2. 分支同步配置
```json
// .vscode/ecode.json 中的 git 配置段
{
  "git": {
    "enabled": true,
    "provider": "github",
    "repository": "owner/repo",
    "serverUrl": "https://your-oa-server.com",
    "defaultStrategy": "api",        // "api" | "zip"
    "branchMappings": [
      {
        "branch": "main",
        "ecodeEnv": "production",
        "appId": "your-app-uuid",
        "autoDeploy": true,
        "triggerOn": ["push", "pull_request.merged"]
      },
      {
        "branch": "develop",
        "ecodeEnv": "staging",
        "appId": "your-app-uuid",
        "autoDeploy": true
      }
    ],
    "secrets": {
      "ECODE_SERVER_URL": "从 VSCode SecretStorage 获取",
      "ECODE_TOKEN": "从 VSCode SecretStorage 获取",
      "ECODE_APPID": "从 ecode.json 获取"
    }
  }
}
```

#### 3. GitHub Actions Workflow 模板
插件生成的 `.github/workflows/ecode-deploy.yml`：
```yaml
name: Deploy to Ecode
on:
  push:
    branches: [main, develop]
  pull_request:
    types: [closed]
    branches: [main]
jobs:
  deploy:
    if: github.event.pull_request.merged == true || github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Sync to Ecode Server
        uses: ecode-vscode/deploy-action@v1   # 插件提供的配套 GitHub Action
        with:
          server-url: ${{ secrets.ECODE_SERVER_URL }}
          token: ${{ secrets.ECODE_TOKEN }}
          app-id: ${{ secrets.ECODE_APPID }}
          strategy: api
          files: 'src/js/**,src/css/**'
```

#### 4. VSCode 命令
| 命令 | 说明 |
|------|------|
| `ecode.git.setup` | 初始化 Git 集成（生成 workflow） |
| `ecode.git.pushToBranch` | 提交并推送当前更改 |
| `ecode.git.syncBranch` | 手动触发当前分支对应的 Ecode 同步 |
| `ecode.git.showStatus` | 显示分支同步状态（哪些更改待同步） |

---

## 实现阶段（按优先级排序）

> **测试环境**：`http://localhost:8099/`（管理员账号密码待提供）

### Phase 0: 项目脚手架（~1 周）
- [ ] TypeScript + esbuild 的 VSCode 插件骨架
- [ ] `package.json`、`tsconfig.json`、`esbuild.mjs`
- [ ] 基本的 activate/deactivate 生命周期
- [ ] F5 调试配置和测试基础设施

### 🔴 Phase 1: 鉴权与 HTTP 客户端（~2 周）— 最高优先级
- [ ] RSA 加解密（`node-rsa`）
- [ ] Token 鉴权流程（注册 → 申请Token → 续期）
- [ ] `EcodeApiClient` HTTP 客户端（重试、超时、401 自动刷新）
- [ ] `TokenStore`（VSCode SecretStorage）
- [ ] `Ecode: Configure Project` — 配置服务器地址、appId，默认启用保存即同步
- [ ] `Ecode: Login` / `Ecode: Logout` 命令
- [ ] 针对 `http://localhost:8099/` 调试验证

### 🔴 Phase 2: 代码同步引擎（~2 周）— 最高优先级
- [ ] **【核心】保存即自动同步** — 注册 `onDidSaveTextDocument` 监听，Debounce 300ms
- [ ] 推送队列管理 — 合并连续保存，避免重复请求
- [ ] 状态栏即时反馈 — ✓ 已同步 / ⟳ 同步中 / ⚠ 同步失败
- [ ] `EcodeSyncEngine.pushFile(uri)` — 单文件推送（保存时自动触发）
- [ ] `EcodeSyncEngine.pullAll()` — 首次全量拉取
- [ ] `FileIndexer` — 本地/远程文件索引与哈希对比
- [ ] `ZipHandler` — ZIP 补丁导入/导出（API 不可用时的兜底）
- [ ] 冲突检测 — 推送前检查远程是否被他人修改

### 🟡 Phase 3: Git 集成（~2 周）— 次高优先级
- [ ] GitIntegration 模块
- [ ] GitHub Actions workflow 生成器
- [ ] `ecode.git.setup` 交互式配置向导
- [ ] 分支→Ecode 映射配置管理
- [ ] GitHub Secrets 管理集成
- [ ] 配套 GitHub Action（`ecode-deploy-action`）

### 🟢 Phase 4: 语法解析器（~2 周）— 可后置
- [ ] tree-sitter WASM 集成
- [ ] 全局库定义数据文件（`data/pc-libs.ts` + `data/mobile-libs.ts`）
- [ ] 所有 tree-sitter 查询模式
- [ ] ComponentResolver + GlobalLibResolver + OverwriteResolver

### 🟢 Phase 5: 语言服务（~3 周）— 可后置
- [ ] DefinitionProvider / CompletionProvider / HoverProvider
- [ ] SignatureHelpProvider / DiagnosticProvider / ReferenceProvider

### Phase 6: UI 与项目管理（~2 周）
- [ ] 同步状态 TreeView + 同步面板 Webview
- [ ] 状态栏指示器 + TextMate 语法高亮 + 多项目支持

### Phase 7: 测试、文档、发布（~2 周）
- [ ] 测试覆盖率 > 80% + README + 打包发布

**核心路径（Phase 0→1→2→3）：约 7 周可交付可用版本**
**完整路径（含语言服务）：约 15 周**

---

## 关键依赖

### 运行时
- `web-tree-sitter` — WASM 语法解析
- `tree-sitter-javascript` — JS 语法 WASM（~150KB，作为 asset 打包）
- `node-rsa` — RSA 加解密（Ecode 鉴权）
- `adm-zip` — ZIP 文件处理
- `simple-git` — Git 操作（仓库状态检测、分支信息）

### 开发时
- `typescript` ^5.5+
- `esbuild` — 打包
- `@types/vscode` ^1.93+
- `@vscode/test-electron` — 集成测试
- `mocha` — 单元测试

---

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| Ecode 无公开代码同步 API | Tier 1 同步不可用 | Tier 2 ZIP 导入导出确定可行，优先实现和验证 |
| 服务器版本间 API 差异 | 同步/鉴权中断 | API 端点模式可配置，连接时检测版本 |
| antd 1.x 组件 API 文档不完整 | 补全/悬停信息不全 | 从 `1x.ant.design` 爬取或手动维护核心组件列表 |
| ecCom 组件（120+）无完整文档 | IntelliSense 覆盖不全 | 优先覆盖高频组件（WeaTop, WeaTable, WeaInput 等），渐进补充 |
| GitHub Actions 权限/网络限制 | CI/CD 自动部署失败 | 支持自托管 Runner 配置；ZIP 模式作为备用推送方式 |
| tree-sitter WASM 大文件性能 | 编辑器卡顿 | AST 缓存 + 增量更新 |
| 同步并发操作 | 文件损坏 | 同步引擎单锁（mutex），操作排队 |

---

## 验证方法

1. **插件加载**：F5 启动扩展开发主机，确认无报错
2. **鉴权**：配置服务器 → login → 确认 Token 获取和存储
3. **同步（自动）**：
   - 首次 `Ecode: Pull Code` 拉取全量代码到工作区
   - 修改任意 JS/CSS 文件 → Ctrl+S 保存 → 状态栏显示 ✓ 已同步
   - 查看服务器 → 确认文件已更新
   - 若远程被他人修改 → 状态栏提示冲突
4. **解析**：包含所有 ecodeSDK API 调用的测试文件中，AST 节点正确捕获
5. **语言服务**：
   - Ctrl+Click `ecodeSDK.imp(MyComponent)` → 跳转到 exp 文件
   - `ecodeSDK.imp(` 后触发补全 → 列出可导入组件
   - `const {` 后触发补全 → 列出 antd/ecCom/mobx 成员
   - 悬停 `antd.Button` → 显示 1.x API 文档和 props
   - 输入 `ecodeSDK.overwritePropsFnQueueMapSet(` → 显示签名帮助
   - 未解析的 imp → 红色波浪线
6. **Git 集成**：
   - `ecode.git.setup` → 生成正确的 workflow 文件
   - 合并 PR → GitHub Actions 触发 → Ecode 服务器收到更新
7. **性能**：100+ 文件索引 < 2 秒，单文件解析 < 50ms，补全 < 200ms

---

## 讨论项

1. **全局库定义的维护策略**：antd 1.x 组件列表和 ecCom 120+ 组件是手动一次性录入，还是逐步按需添加？
2. **配套 GitHub Action**：`ecode-deploy-action` 是放在插件仓库内还是独立仓库？
3. **测试环境**：是否有可用的 Ecode 服务器用于 API 探测和功能测试？
4. **VSCode 版本**：目标最低版本设为 1.93+ 是否合适？
5. **是否现在开始 Phase 0**（项目脚手架搭建）？
