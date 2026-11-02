# 轻作发布与独立插件

底座版本 0.6.16，插件 API / SDK 1.6.1（运行时 API 仍为 1.6.0）。底座发布仓库、应用标识、用户目录和 CommerceTools 制品名称保持兼容。macOS 最低版本为 15（Apple Silicon），Windows 为 10+ x64。

## 分支与合入流程

底座使用 `main` 与 `develop` 双分支。`develop` 是集成分支，功能、修复和发版准备都先合入这里；`main` 是生产主干，只接受来自 `develop` 的合并 PR。两条分支都启用了 GitHub 分支保护，禁止直接推送，必须经 PR 合并并通过 `Branch policy` 检查。

功能分支基于 `origin/develop` 创建，命名为 `codex/<type>-<name>`，PR 合入 `develop`。发版时在 `codex/release-vX.Y.Z` 上更新版本号与发布日志并合入 `develop`，随后由 `develop` 合入 `main`，再在 `main` 上打版本标签触发自动发版。紧急修复从 `main` 切出 `codex/hotfix-*` 分支，合入 `main` 后必须同步回合入 `develop`。

官网 `site/` 随 `main` 部署，`develop` 上的站点改动不会单独上线。

## 底座

Node 24 和 Rust 构建工作台、Harness 适配和系统沙箱。npm run platform:prepare 会清理旧生成目录，禁止携带编辑器、OCR 模型或业务 Python 后端。

Validate commerce desktop 验证通用契约、沙箱、空工具中心、外部安装包和组件重建。Release commerce desktop 手动运行需要匹配版本，只上传 Commerce-macOS/Commerce-Windows 验收制品；v0.6.0 标签发布安装包和组件，不发布业务插件。正式资源禁止设置 QINGZUO_LOCAL_PREVIEW=1。

插件市场公钥使用 COMMERCE_MARKET_PUBLIC_KEY；桌面组件继续使用既有 COMMERCE_PLUGIN_PUBLIC_KEY/COMMERCE_PLUGIN_SIGNING_KEY。两种用途在生成资源中分开记录。插件发布者不持有这两种私钥。

macOS 新组件仅有 core、electron、dependencies，保留旧组件清单读取兼容性。签名、完整性、差量回退、重启与恢复保持原有流程。Windows 继续使用 electron-updater。

更新器使用 original-fs 读取真实 ASAR 文件，不经过 Electron 的虚拟目录解释。新组件使用版本 2 签名域，同时接受版本 1 旧签名。v0.2.5 的组件读取受 ASAR 虚拟文件系统影响，因此它会在组件签名检查阶段安全转入完整 ZIP 升级，避免开始错误的组件重建；升级到 v0.2.7 后恢复组件更新。此兼容回退不是迁移过渡版。

## SDK 与插件

sdk-v1.1.0 首次发布后，测试辅助入口的可见视图修正以 sdk-v1.1.1 发布，不覆盖原制品；运行时 API 仍为 1.1.0。两个版本设置 latest=false，不干扰桌面升级。独立插件用固定 sdk-v1.1.1 Release URL 和 lockfile integrity 安装 SDK。

sdk-v1.2.0 增加 AI 权限、共享图片模型、目录授权、后台批次和助手接口；sdk-v1.2.1 补齐浏览器权限校验与浏览器桥接接口，同样设置 latest=false。AI 批图仓库固定其 Release 字节，发布流水线核对 SHA-256，并核对 v0.3.0 底座发布运行的提交与正式标签后使用安装制品验收。sdk-v1.3.0 增加页面自动化、页面来源白名单、资源转存、签名与自定义请求头、插件持久化存储；sdk-v1.4.0 增加插件文本 AI 模型目录与补全接口；sdk-v1.5.0 允许文本补全携带图片片段（https 或 png/jpeg/webp 的 base64 data URL，单条最多 4 张）；sdk-v1.6.0 增加只有提示词、不带原图的文生图批次，均设置 latest=false。sdk-v1.6.1 修正测试辅助入口查找的工具中心按钮名，运行时 API 仍为 1.6.0，同样设置 latest=false。市场验证器先升级 SDK 并注册发布者；新版本由客户端从插件 Release 读取，市场只验证来源和兼容快照。

插件源码、Python/模型/字体、业务测试和打包在各自仓库完成。插件 CI 必须提供成功的底座验收运行 ID，从该运行下载对应平台安装制品并在真实沙箱中验收，不能借用底座源码依赖。

## 市场

qingzuo-market 的目录条目记录固定 GitHub Release 来源；桌面端直接从插件 Release 读取最新版本，插件发版不依赖市场目录提交。市场验证工作流只检查已登记仓库的正式 Release，不再改写版本条目。旧 market/catalog.json 中的版本、制品和 Ed25519 签名继续供旧客户端兼容使用。

市场定时从 GitHub Release API 汇总各插件正式版本双平台制品的累计下载数，写入目录的可选 `stats.downloads` 字段。它只作为产品展示数据，不用于计费、唯一用户或安装成功率判断。

插件安装和更新由主进程后台任务执行，短内核请求只确认任务已开始。界面显示下载字节、进度、包校验、安装和内核同步状态，切换页面不影响任务。同插件更新期间禁止重复提交、启停、恢复、卸载和本地导入；退出时取消下载，等待已进入安装事务的任务完成。下载持续传输时重置 120 秒无响应超时，最长允许 30 分钟；来源、大小、HTTPS、摘要和 API 验证保持有效。安装已提交但同步失败时，重试只补做同步。

市场定时验证只读取正式发布，不需要写入权限或跨仓库凭据。新目录地址为 https://raw.githubusercontent.com/ZhiPenTu/qingzuo-market/main/catalog.json。

## 用户迁移与验收边界

新用户空工具中心可直接浏览市场或本地导入。旧用户原内置 LabelEdit 需联网重新安装一次；已安装新版不覆盖，停用状态保留，卸载记录不恢复，凭据、配置与用户文件保留。提示处理结果保存到原用户目录。

双平台 CI、真实 remove.bg 计费调用、最低系统实机安装升级分别记录；不得将 CI 结果当作后两项验收。
