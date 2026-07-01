# Ecode Local

泛微 Ecode 在线开发平台的 VSCode 本地开发插件。将 E-cology 9 OA 系统中的 Ecode 代码同步到本地编辑，**保存即自动推送**到服务器。

## 当前功能

- **配置向导**：通过 Webview 表单配置服务器地址、账号密码、本地目录
- **全量拉取**：从 Ecode 服务器递归下载所有代码文件到本地，带进度提示
- **保存即同步**：本地编辑文件 Ctrl+S 保存时，自动推送到 Ecode 服务器
- **状态栏快捷操作**：右下角状态栏提供拉取、推送、配置入口

## 命令

| 命令 | 说明 |
|------|------|
| `Ecode: Setup` | 打开配置向导，连接服务器并保存凭据 |

## 配置项

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `ecode.server.url` | — | E-cology 服务器地址 |
| `ecode.server.username` | `sysadmin` | 登录用户名 |
| `ecode.server.appId` | — | Ecode App ID（可选） |
| `ecode.localDir` | `ecode` | 本地代码存放目录 |
| `ecode.server.autoConnect` | `true` | 启动时自动连接服务器 |
| `ecode.sync.autoPushOnSave` | `true` | 保存文件时自动推送到服务器 |
| `ecode.sync.debounceMs` | `300` | 推送防抖延迟 |

## 开发

```bash
npm run build          # esbuild 打包
npm run watch          # 监听模式（F5 调试）
npx tsc --noEmit       # 仅类型检查
npm run test           # 集成测试
npm run package        # 打包 .vsix
```

按 F5 启动扩展开发主机调试。
