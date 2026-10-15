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

## Worktree 与环境隔离

Codex Desktop 采用多任务工作树机制，每个任务应在独立的 Git Worktree 中进行，保持主干纯净与上下文隔离：

- **分支规范**：禁止在 `main` 分支上直接提交或推送代码，禁止在处于 detached HEAD 状态时盲目提交。所有开发与发布任务必须基于最新的 `origin/main` 创建独立分支，分支命名统一遵循 `codex/<type>-<name>` 或 `codex/<feature-name>`（例如 `codex/optimize-settings-ui`、`codex/release-v0.3.16`）。
- **依赖快速复用**：新建 Worktree 默认不包含忽略的目录。为避免每次重复下载巨大依赖或重复编译 Rust 沙箱，可软链接主工作区的依赖与产物：

  ```sh
  ln -s /Users/tuzhipeng/Documents/qingzuo-desktop/node_modules node_modules
  mkdir -p native/sandbox/target && ln -s /Users/tuzhipeng/Documents/qingzuo-desktop/native/sandbox/target/release native/sandbox/target/release
  ```

- **工作区洁净度**：提交前核对 `git status`，严禁将未跟踪的临时文件、构建产物（`output/`、`release/`）或凭据打入提交。
- **生命周期维护**：PR 成功合并后，应及时清理对应的工作树或调用应用工具进行归档，释放磁盘与分支空间。

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

## PR 提交与代码审查规范

所有变更均需通过 GitHub Pull Request 提交合并，确保主干可追溯且通过自动化验证：

- **提交信息语义化**：遵循 Conventional Commits 规范，统一采用 `feat:`、`fix:`、`style:`、`chore:`、`docs:`、`test:`、`refactor:` 前缀，精准描述变更范围。
- **PR 标题与模板**：
  - PR 标题应清晰概括业务或平台意图，与核心提交说明保持一致。
  - PR 正文必须使用项目模板（`.github/pull_request_template.md`），明确填写两项核心内容：
    1. **变更说明**：提炼修改点与业务背景，避免罗列无意义的底层实现。
    2. **本地验证情况**：必须明确记录提交前在本地实际执行并通过的测试命令及数据证据（如 `npm test` 38/38 通过、`npm run test:platform` 139/139 通过、`npm run build` 成功）。严禁无实测数据直接发起 PR。
- **Codex Desktop 联动**：在 Codex Desktop 中使用 `gh pr create` 或应用接口创建 PR 后，调用 `attach_artifact` 挂载生成的 PR URL，保证上下文和审查链路完整闭环。
- **状态流转与合并**：
  - 未完成验证或处于讨论阶段的变更应创建为 Draft PR；
  - 验证充分且准备就绪后标记为 Ready for review，等待 GitHub Actions `Validate commerce desktop` 自动化检查全部通过；
  - 审查确认后合并入 `main`，并清理对应的远端分支。纯文档或网站变更会自动跳过桌面构建耗时步骤以加速合流。

## 上游与版本发布流程

- 上游候选版本使用 `npm run upstream:harness -- prepare ...` 和 `validate ...` 在隔离目录验证，不能覆盖当前固定依赖。
- 正式发布前必须通过 `scripts/release-preflight.mjs`。发布签名密钥只从环境变量读取，不能写入源码、日志或制品。
- `QINGZUO_LOCAL_PREVIEW=1` 只能用于本地预览，不能用于正式发布。除非用户明确要求，不要创建 Release、上传制品或修改线上市场目录。
- `docs/implementation-status.md` 记录的是已有验收证据；新增能力只有在实际验证后才能声称已完成。

### GitHub 版本发布闭环

底座的正式发布遵循统一闭环机制：

1. **发布准备 PR**：在 `codex/release-vX.Y.Z` 分支上同步更新 `package.json`、`package-lock.json` 与 `docs/release-guide.md` 中的版本号，并在 `docs/releases/vX.Y.Z.md` 中编写发布日志。完成本地验证后提交发布 PR。
2. **流水线验收**：PR 触发 `Validate commerce desktop` 工作流，验证双平台契约与打包能力。
3. **主干合并**：PR 通过验收后合并入 `main` 分支。
4. **推送版本 Tag**：在最新的 `main` 提交上创建带注释的 Git 标签并推送到 GitHub：

   ```sh
   git checkout main && git pull origin main
   git tag -a vX.Y.Z -m "轻作 Qingzuo vX.Y.Z"
   git push origin vX.Y.Z
   ```

5. **全自动发版**：`Release commerce desktop` 工作流监听到 `v*` 标签后自动启动：先秒级校验发布日志文件是否存在与签名配置，随后打包 macOS 与 Windows 安装包及更新组件，最后自动创建 GitHub Release 并附带对应版本的发布日志。
6. **SDK 独立发布**：若变更涉及 `@commerce/plugin-sdk`，在更新其 `package.json` 版本号后推送 `sdk-vX.Y.Z` 标签，由 `release-sdk.yml` 自动打包并发布至 GitHub Releases。

## 用户可见文案

界面、官网与安装包里只写用户需要知道的内容。不要把实现说明写进用户看到的文字。

- 不要在界面上解释数据来自哪个文件、仓库或接口，不要说明某个机制如何自动更新，也不要描述内部字段含义、校验流程或架构分层。这类内容属于 `docs/`、代码注释和提交信息。
- 界面在正常状态下保持安静：状态提示只在出错、需要用户操作或用户主动追问时出现。功能正常时不要用文字复述正在做什么。
- 判断标准：把这句话给一个只关心「怎么用」的用户看，他会不会觉得「这是写给开发看的」或「所以呢」。会，就删掉或改写成用户能据此行动的话。
- 需要保留细节时，链接到文档，而不是把文档内容复制进界面。

## 变更流程

1. 先阅读受影响模块及对应文档、测试和工作流，确认数据流与安全边界。
2. 在 Codex Desktop 中基于最新的 `origin/main` 切出独立的 `codex/<type>-<name>` 分支，必要时软链接依赖以快速就绪。
3. 让改动保持局部，沿用现有命名、错误处理和用户可见文案风格；不要顺手重构无关代码。
4. 先运行与改动直接相关的测试，再按改动范围运行 `npm test`、`npm run build` 和 `npm run test:platform`，记录实际测试结果与通过用例数。
5. 检查 `git diff`、`git status` 和生成物，确认没有凭据、临时文件或不相关的本地改动。
6. 提交语义化 Commit，发起 GitHub PR（包含变更说明与本地实测证据），并使用 `attach_artifact` 挂载 PR 链接。
7. 等待 GitHub Actions 自动化检查通过，完成审查并合并入 `main`；若涉及版本发布，合并后在主干创建并推送版本 Tag 触发自动发版。
