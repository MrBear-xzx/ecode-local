# Ecode Local

泛微 Ecode 在线开发平台的 VSCode 本地开发插件。

## 功能

- **保存即同步**：本地编辑 JS/CSS 文件，Ctrl+S 保存时自动推送到 Ecode 服务器
- **代码同步**：从 Ecode 平台拉取代码到本地，支持 ZIP 补丁导入/导出
- **智能解析**（规划中）：解析 `ecodeSDK.imp/exp` 等 Ecode 特有语法
- **语言服务**（规划中）：组件定义跳转、代码补全、悬停提示
- **Git 集成**（规划中）：GitHub 分支合并自动部署到 Ecode

## 开发

```bash
# 安装依赖
npm install

# 编译
npm run build

# 监听模式
npm run watch

# 打包
npm run package
```

按 F5 启动扩展开发主机调试。
