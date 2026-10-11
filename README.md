# 轻作桌面端底座 (qingzuo-desktop)

轻作是基于 Electron、DeepSeek Harness 和系统沙箱的插件桌面工作台。v0.2.7 起安装包只包含底座（`qingzuo-desktop`），业务工具从独立插件市场按需安装。

- LabelEdit: https://github.com/ZhiPenTu/qingzuo-plugin-labeledit
- AI 抠图: https://github.com/ZhiPenTu/qingzuo-plugin-removebg
- AI 批图: https://github.com/ZhiPenTu/qingzuo-plugin-ai-image
- 市场: https://github.com/ZhiPenTu/qingzuo-market

## 开发与验证

需要 Node 24、Rust；macOS 需要 Xcode 命令行工具。原生构建工具可能需要 Python，但底座不安装业务 Python/OCR 依赖。

运行 npm ci --ignore-scripts、node node_modules/electron/install.js、npm run build:harness-native、npm run build:sandbox、npm run build、npm run platform:prepare，然后 npm run desktop:dev。

验证使用 npm test、npm run test:platform、npm run test:desktop。npm run build:desktop 生成纯底座安装包。

SDK 源码位于 packages/plugin-sdk，版本 1.2.0，运行时 API 1.2.0。插件 API、独立测试入口和发布说明见 docs/plugin-development.md 和 docs/release-guide.md。

v0.3.0 起支持 macOS 15+ Apple Silicon、Windows 10+ x64。内置 CLIProxyAPI v8.0.23 官方制品要求 macOS 15，旧系统请保留 v0.2.9。Harness 固定 0.2.1-alpha.1，插件代码运行在隔离上下文中。
