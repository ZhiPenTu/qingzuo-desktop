# AGENTS.md

本文件是 `qingzuo-desktop` 的协作与验证指南。更深层目录中的 `AGENTS.md`（如果以后新增）优先于本文件。

## 项目边界

- 这是 Electron + Vite + React + TypeScript 的桌面底座，不是业务插件仓库。
- `src/` 是渲染进程界面；`desktop/` 是 Electron 主进程、Harness 适配和沙箱编排；`native/sandbox/` 是 Rust 沙箱；`packages/plugin-sdk/` 是独立插件 SDK；`packages/platform-bundle/` 是底座运行时补丁。
- `scripts/` 保存构建、打包、上游版本检查和验收脚本；`tests/platform/` 测试平台与服务契约，`tests/electron/` 测试真实 Electron 流程。
- 插件业务代码、插件市场目录和业务 Python/OCR 依赖在独立仓库维护，不要把它们重新加入底座构建。

## 开发环境

- 使用 Node 24 和 Rust stable。macOS 开发需要 Xcode Command Line Tools。
- 首次安装和构建可执行：

  ```sh
  npm ci --ignore-scripts
  node node_modules/electron/install.js
  npm run build:harness-native
  npm run build:sandbox
  npm run build
  npm run platform:prepare
  ```

- `npm run desktop:dev` 会启动 Vite 和 Electron 开发环境；只在需要真实 Electron 行为时使用它。
- 不要把 `node_modules/`、`output/`、`release/`、`native/sandbox/target/` 或其他 `.gitignore` 生成物提交进 Git。

## 常用验证

按改动范围选择最小充分的检查，并在报告中写明实际执行的命令：

```sh
npm run build                         # TypeScript 与 Vite 构建
npm test                              # 前端 Vitest
npm run test:platform                 # 平台、内核、插件和安全契约
npm run test:sandbox                  # Rust 沙箱回归
npm run test:kernel                   # 内核启动与生命周期
npm run test:harness-contract         # Harness/AI 契约
npm run test:desktop                  # Playwright Electron 流程
npm run upstream:check                # 固定上游包与 lockfile 一致性
```

改动涉及打包或发布时，再运行 `npm run build:desktop`，并根据平台补充 `node scripts/test-packaged-desktop.mjs`、`node scripts/test-windows-installer.mjs` 或 `node scripts/test-component-update.mjs`。完整 CI 顺序以 `.github/workflows/validate.yml` 和 `.github/workflows/release-commerce.yml` 为准。

仓库没有配置独立 lint 脚本；以 TypeScript 严格检查、构建和对应测试作为静态验证。不要为了通过检查而放宽 `tsconfig.json` 的 `strict`、`noUnusedLocals` 或 `noUnusedParameters`。

## 实现约定

- 优先使用现有模块、类型和公开接口；不要直接修改 `node_modules`，也不要从 Harness 的内部 `lib/`、`src/` 路径导入。
- Harness 版本由 `desktop/upstream/harness.json` 固定。升级必须同步包族、lockfile、公开导出检查和 Harness 契约测试；不要使用浮动 `latest` 或运行时下载依赖。
- 插件代码是不受信任代码。文件、凭据、网络、服务调用和进程生命周期必须通过 SDK、主进程 IPC 和 OS 沙箱边界完成；不要把密钥、令牌、文件路径或其他插件私有数据传给插件页面或 AI 工具。
- 变更网络代理、更新器、签名、沙箱或插件安装流程时，同时检查失败恢复、取消、重启和旧数据兼容性，不要只验证成功路径。
- 保持用户数据目录、应用标识、插件 ID、更新组件格式和兼容版本契约；需要改变这些内容时，先阅读 `docs/release-guide.md`、`docs/plugin-development.md` 和相关迁移测试。
- SDK 或插件 API 的改动要同步 `packages/plugin-sdk/index.d.ts`、运行时实现、manifest 校验、测试和文档。插件市场发布仍在独立仓库完成。

## 上游与发布

- 上游候选版本使用 `npm run upstream:harness -- prepare ...` 和 `validate ...` 在隔离目录验证，不能覆盖当前固定依赖。
- 正式发布前必须通过 `scripts/release-preflight.mjs`。发布签名密钥只从环境变量读取，不能写入源码、日志或制品。
- `QINGZUO_LOCAL_PREVIEW=1` 只能用于本地预览，不能用于正式发布。除非用户明确要求，不要创建 Release、上传制品或修改线上市场目录。
- `docs/implementation-status.md` 记录的是已有验收证据；新增能力只有在实际验证后才能声称已完成。

## 变更流程

1. 先阅读受影响模块及对应文档、测试和工作流，确认数据流与安全边界。
2. 让改动保持局部，沿用现有命名、错误处理和用户可见文案风格；不要顺手重构无关代码。
3. 先运行与改动直接相关的测试，再按需要运行 `npm run build`、`npm test` 和平台/Electron 测试。
4. 检查 `git diff`、`git status` 和生成物，确认没有凭据、临时文件或不相关的本地改动。
5. 最终说明改动文件、验证命令及任何未完成的真实平台验收；不要把 CI 或模拟服务结果描述成最低系统、真实签名或真实付费 API 验收。
