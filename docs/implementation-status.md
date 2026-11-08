# 实施状态与验收证据

任务依据：`commerce-plugin-platform-taskbook.md`。[轻作 Qingzuo v0.2.4 已在 GitHub 发布](https://github.com/ZhiPenTu/LabelEdit/releases/tag/v0.2.4)，新增差量下载、断点续传和 macOS 签名组件复用，继续支持应用内下载进度、校验及自动安装重启。本文件区分发布完成与真实验收，未经验证的能力不能勾选。

| 范围 | 当前证据 |
| --- | --- |
| 官方 Harness 内核 | 固定 0.2.2-alpha.2；真实 Profile 启动、7 个系统服务、插件工具描述符与沙箱服务路由、工具服务调用和生命周期释放通过 Node 测试 |
| Electron 自有界面 | v0.2.2 使用 shadcn/ui + Base UI + Tailwind CSS 统一工具中心、市场、管理、设置、更新和编辑器；浅色/深色及 1440×1000、390×844 布局通过界面检查。macOS arm64 与 Windows x64 CI 中独立 WebContentsView 标签页及本地服务运行时的新工具页面通过真实应用和 Playwright Electron 测试；两平台完整打包应用的自有 UI、内核连接、沙箱 OCR 与 PDF 保存通过；未加载上游 UI |
| 工具中心 | 已安装与全部合并为一个页面，页签在左、状态与操作在右，卡片按图标标题、说明、状态、操作重排；网格宽度自适应，1440/1920/2560/2957 窗口分别为 4/5/7/7 列，说明最多三行且不截断，浅色与深色布局通过界面检查；真实应用 Playwright Electron 流程 20/20 通过 |
| 插件安装和恢复 | 本地安装/持久化/启停/卸载/升级恢复，损坏与恶意 ZIP、签名校验、版本和依赖拒绝通过测试；真实 Electron 的签名市场安装/更新、错误签名保留原版及内核崩溃恢复通过（使用测试目录与制品） |
| 插件页面自动化与存储（API 1.3） | 平台契约测试覆盖页面来源白名单、快照脱敏、操作校验、资源转存与请求签名、存储隔离与配额；真实 Electron 测试完成打开页面、拍快照、点击、转存、重启后读取和宿主侧签名。真实第三方站点采集与线上店铺发品仍待人工验收 |
| 插件文本 AI（API 1.4） | 平台契约测试覆盖完整模型目录、文本模型过滤、单模型文本补全测试、补全请求组装、输入上限与失败映射；底座连接服务时不指定模型，AI 设置展示服务返回的全部模型并可对文本模型发起最小补全测试，插件申请 `permissions.ai: ['text']` 后通过 `ai.textModels()` 读取目录并自行选择 `ai.complete({ model })`，密钥不出主进程。真实第三方模型服务联调待人工验收 |
| 插件图像 AI 与共享图像服务 | AI 设置展示 Google、OpenAI 共享服务和兼容服务返回的图片模型目录，并标注来源；兼容目录支持常见图片类型及别名，不混入文本补全测试。平台契约与真实 Electron 流程覆盖官方密钥、兼容连接、目录刷新、模型展示及密钥不出主进程。真实第三方图片生成调用待人工验收 |
| macOS 沙箱 | 当前 macOS 27.0.1 arm64 真实进程阻止目录外读写、符号链接、直接联网和启动其他程序；不可用时拒绝运行 |
| Windows 沙箱 | Windows Server 2025 x64 CI 中真实 AppContainer 与 Job Object 进程阻止目录外读写、符号链接、直接联网和未授权程序；系统凭据直接读取被拒绝，低完整性工作目录及 SID ACL 清理回归通过；Windows 10 最低系统验收待进行 |
| LabelEdit | 构建输出的内部库及 Python 框架别名转为普通文件/目录，逐层拒绝外部、循环及损坏链接，保持插件 ZIP 不含链接；独立 ZIP 打包/解包后在真实沙箱中完成 PDF 上传、RapidOCR、文字修改、预览、导出尺寸与源文件不变回归；桌面导出保存通过 |
| 自制工具 | SDK 网页/本地模板在运行中的底座导入并完成调用，无需重编译底座；页面无法使用 Node；独立会话强制不可达代理并禁用非代理 WebRTC，真实 TCP/TURN 与 UDP/STUN 哨兵验证未收到插件连接；网络配置校验失败时阻止页面打开 |
| 凭据 | macOS 使用应用数据目录内 `0600` 权限的本地凭据文件，Windows 使用 Credential Manager；所有写入统一使用 Electron `safeStorage` 的 `enc:v1:` 信封，实测写入、读取、跨插件隔离及删除通过。实际沙箱进程无法读取宿主凭据，测试拒绝超时、崩溃及非凭据 API 错误的假阳性；macOS 开发构建、应用身份变化或钥匙串状态变化时可能重新询问钥匙串授权 |
| AI 抠图 | 模拟 API 测试通过缺少密钥、额度不足、取消、无自动重试、PNG 预览与保存；真实 remove.bg 调用待用户配置 |
| 市场 | v0.2.4 正式目录包含 LabelEdit 0.1.1 和 AI 抠图 0.1.0 的 macOS arm64 / Windows x64 制品，四个公开文件的 SHA-256 与生产 Ed25519 签名全部通过；客户端默认目录同步发布制品。目录并入工具中心的「全部」页签，与已安装工具共用同一套卡片，分类、搜索、展开版本说明、安装/更新/已安装状态及加载失败重试保持可用，并阻止将较新的已安装插件降级 |
| GitHub 更新和发布 | v0.2.4 双平台验证与正式发布通过，21 个公开文件的 SHA-256 全部匹配，插件及组件生产签名通过；macOS 隔离安装副本从公开 v0.2.3 实际下载、安装和自动重启至 v0.2.4，通过离线 OCR 与 PDF 导出。新增差量、续传和组件复用，首次升级仍完整下载。默认不要求 Apple/Windows 发布者证书。最低支持系统和 Windows 真实安装升级验收仍待进行；详见下方发布记录 |
| 上游升级 | 2026-11-01 在隔离候选完成 0.2.1-alpha.1→0.2.2-alpha.2 的整组依赖、公开导出、Node/Electron 原生加载器、UI 构建、会话恢复、插件确认和取消契约验证；其中会话与审批契约已于 2026-11-08 移除，安装包的两平台验收仍待进行 |

## 第一方插件拆分（本地开发验收）

2026-11-03 在 `codex/first-party-plugin-split` 完成三档信任层、市场契约、SDK/API 1.10.0、凭证与下载器平台归类、AI 助手插件和诊断插件的第一方拆分。本节记录本地实现与测试证据；提交、CI、合并和发布状态以对应 Git 记录为准。

> 历史记录：本节中的工作台对话、审批、AI DTO 与会话恢复行为已于 2026-11-08 移除，保留作为当时的验收证据。

- 市场注册表升级为 schema v2，repository 与 `{ id, tier }` 双向唯一；目录保持 schema v1，条目显式提供 `tier` 和一致投影 `official = tier !== 'community'`。`official.credentials`、`official.downloader`、`official.ai-assistant`、`official.diagnostics` 为 `platform`，其余九个现有条目为 `official`。发布片段只能更新版本、展示信息和制品字段，信任、来源、统计与校验字段在市场和桌面两端均被拒绝。
- 市场目录可以为未在插件包内声明 `icon` 的条目提供审核后的展示图标；插件包已声明图标时，市场条目与包内图标必须一致。四个 `platform` 条目已在目录中登记图标，桌面同时为 AI 助手与日志调试内置了同一套图标资源。
- 桌面安装记录将来源 `bundled / market / local` 与信任层分开处理。本地导入固定为 `community`；市场安装必须携带目录显式 `tier` 并保存内部 `artifactSha256`；旧安装缺少 tier 时先按 `community` 处理，只有加载审核目录并同时匹配版本和两端制品摘要后才迁移。更早的安装没有记录制品摘要，桌面会在审核目录提升其信任层时重新获取目录、下载当前版本并逐文件比对已安装内容，完全一致后才补记摘要并升级；不匹配时保持 `community`，降级仍按审核目录直接生效。回滚只保留当前与目标版本中较低的信任层，不会因当前版本为 `platform` 而提升较低信任的旧制品。
- `firstParty.*` 未加入公开 SDK 客户端。AI 助手、设置和诊断桥均要求精确 ID、市场来源、`platform` tier、已启用状态和无缺失依赖，并由宿主白名单限制到方案列出的方法。AI DTO 已移除审批、工具参数和内部结果；密钥通过原生输入框直接交给宿主；审批仍由宿主独占。
- AI 助手插件 `official.ai-assistant` 与诊断插件 `official.diagnostics` 已在独立仓库完成实现和双平台同字节制品打包。主壳 `/chat`、`/ai`、`/logs` 页面已移除，侧栏入口仅在对应可信插件安装并启用时显示。设置页保留未安装时的市场安装入口和已安装时的插件设置入口。
- 日志入口统一脱敏密钥、Bearer/Basic 令牌、JWT、常见 API key、password/token/secret/signature 字段、URL 用户信息和敏感查询参数。诊断授权绑定插件 ID、版本、制品摘要、API 范围和能力；升级、重装或撤销后重新询问，卸载时清除。日志批次带单调递增 `seq`，可检测缺口并避免重复。
- 浏览器面板原生视图位置在入场动画结束后重新上报，修复完整 Electron 回归中 2 像素位置偏差。

已实际执行的本地验证：

- `npm run build`：通过。
- `npm test`：9 个文件、87 个测试通过。
- `npm run test:platform`：293 个测试通过。
- `npm run test:kernel`：1 个真实 Harness 启动与生命周期测试通过。
- `npm run test:harness-contract`：Node 契约 39 个测试及 UI 15 个测试通过。
- `npm run test:desktop`：完整 Electron 流程 23/23 通过，包括真实市场信任安装、原生密钥输入、宿主独占审批、重启会话恢复、共享凭证授权与撤销、下载器暂停/继续/重启恢复、诊断授权和日志脱敏落盘。
- qingzuo-market：`npm test` 23/23 通过，`npm run validate` 通过；`npm run verify:release` 已单独验证 9 个插件仓库的双平台制品，`official.labeledit` 的大文件下载验证仍待完成。
- 两个插件仓库：AI 助手 `npm test` 15/15、诊断 `npm test` 17/17；`npm run pack` 均生成双平台字节一致的 `.ecplugin`、对应 release fragment 和制品摘要。`test:host` 因未设置真实宿主可执行文件而跳过。

尚未完成或不得宣称完成：

- 干净用户目录的离线首次启动、在线安装四个插件后断网冷启动及四个插件的真实市场端到端安装仍需在发布候选版本验收。
- 尚未在真实打包的 API 1.10 桌面版本和 Windows 实机验证新插件；现有 Electron 证据来自本地宿主构建。
- [`sdk-v1.10.0`](https://github.com/ZhiPenTu/qingzuo-desktop/releases/tag/sdk-v1.10.0) 已发布，市场仓库已使用该 Release 的固定制品和 integrity；`npm ci --ignore-scripts`、24 个市场测试、目录校验和现有 10 个插件的发布验证通过。
- 市场 tier 数据、校验规则和 SDK 锁定已合入 `qingzuo-market` 的 `main`。新插件发布必须使用成功的桌面 Release 运行制品完成真实宿主验收；市场只登记已经发布并通过来源校验的版本。

## 第一方信任层目录修正（本地开发验收）

2026-11-04 修正 `official.ai-assistant` 与 `official.diagnostics` 的市场信任层：两个插件此前以 `official` 登记，而 `firstParty.*` 桥与侧栏入口都要求 `platform`，导致已安装插件在 AI 设置页提示「当前桌面版本暂不支持这项操作」。目录与注册表改为 `platform` 后，仍需让已安装的旧记录跟随审核目录升级：

- 市场目录加载时按审核目录同步信任层：版本与两端制品摘要一致时允许升级，降级（吊销）始终生效；摘要缺失时重新拉取目录并下载审核制品逐文件核对，一致后才补记摘要并升级，发布清单不可用或内容不一致时失败关闭。旧安装的修复在启动时只在检测到缺少摘要的市场安装后触发一次后台目录刷新，并采用十分钟失败冷却，避免反复下载。
- 第一方桥接在授权失败时按单个插件 ID 重新拉取目录并重试一次，避免用户必须打开市场「全部」页签才触发同步；同步成功会通知渲染端刷新状态。
- 仅复核过 `qingzuo-market` 目录与注册表、`marketTierUpdate` 单测、平台与前端测试；尚未在真实打包版本上复验升级与侧栏入口。

## v0.2.9 准备与发布

针对应用内更新时出现的 `ENOTDIR: not a directory, open .../app.asar/desktop/mac-install.sh` 报错完成彻底修复与版本发布：
- 修复 `desktop/mac-update.mjs` 中安装脚本加载逻辑，通过安全内部资源加载器读取并提供内置模板完整兜底，消除 `original-fs` 穿透 asar 导致的 ENOTDIR 异常。
- 兼容 `qingzuo-desktop` 与 `LabelEdit` 仓库发布制品与组件清单校验。
- 补充安装脚本加载与兜底回归测试，全量平台与桌面测试验证通过。

## v0.2.8 准备

用户已授权发布补丁版本 `v0.2.8`：
- 插件市场增加更新/安装动态进度动画、微光流光效果与按钮加载状态反馈，支持 prefers-reduced-motion 无障碍适配。
- 清理历史升级累积的冗余无用文件，包括已分离插件的历史 OCR/PDF 引擎文档、废弃调试与演练脚本、未使用的 shadcn/ui 组件与工具函数。
- 版本元数据、发布指南与发布说明（`docs/releases/v0.2.8.md`）已准备完毕，完整回归测试通过。

## v0.2.6 准备

用户已授权发布补丁版本 `v0.2.6`，修复插件卸载后重新安装出现工具服务不可用（`Error: 工具服务不可用。`）的缺陷，以及 macOS 应用更新清理抛出 `ENOTEMPTY` 导致更新中断的缺陷。底座内核 `reconcile` 完整等待 Fiber 挂载完成，工具同步完成前延迟发送 `changed` 通知并在 `loadView` 期间协调等待同步完成。macOS 更新适配器及下载流程增加 `withNoAsar` 与 `safeRm`，规避 Electron asar 虚拟文件拦截导致的目录清理失败并保障降级回退。版本元数据与发布说明已准备。

## v0.2.5 准备

用户已授权发布补丁版本 `v0.2.5`，移除 LabelEdit 编辑器顶部冗余的主题切换功能，统一由系统设置“外观”选项管理。版本元数据与发布说明已准备。

## v0.2.4 差量与组件更新发布

2026-10-10 按用户授权发布补丁版本 `v0.2.4`，标签指向 `474660a3e96bb51c4074e8318ebe9c0112382cb9`；未提升主版本号或次版本号。[main 双平台验证](https://github.com/ZhiPenTu/LabelEdit/actions/runs/37960422229) 与 [正式发布](https://github.com/ZhiPenTu/LabelEdit/actions/runs/37960426702) 全部成功。两平台各通过 13 个前端测试和 4 个 Electron 流程；Mac 平台测试 53 项通过，Windows 41 项通过、12 项平台专属测试跳过，两平台均无失败。完整打包应用在源码目录外的真实内核、离线 OCR 和 PDF 保存检查通过，Mac 生产签名组件的重建应用也通过该检查。

公开 Release 包含 21 个文件：完整安装包、blockmap、更新清单、六类组件 ZIP、生产签名组件清单、四个插件包、SDK 和市场目录。已下载所有文件并逐一比对 GitHub SHA-256；`latest.yml` / `latest-mac.yml` 的版本、大小和 SHA-512 与实际文件一致。四个插件包的生产 Ed25519 签名、组件清单的独立域签名及 22,534 个组件数据文件的哈希全部通过。`market/catalog.json` 已同步本次公开目录。两平台更新检查确认 v0.2.3 能发现 v0.2.4，v0.2.4 返回已是最新版。

使用未修改的公开 v0.2.3 Mac 应用，在源码目录外建立安装副本和独立用户目录。真实更新界面从 GitHub 下载 464,080,045 字节的完整 ZIP，经校验后解压、替换应用并自动重启到 v0.2.4；用户目录内预先写入的验证文件保留，安装错误记录为空。更新后的应用再次通过严格代码签名、独立 Harness、沙箱离线 OCR 和 PDF 导出检查。未替换用户正在使用的安装实例。

由实际升级所得的完整应用与公开生产签名组件清单逐文件核对通过，全部 Mach-O 的 macOS 14 部署目标检查通过。随后只修改一次性副本的应用代码，通过真实 GitHub 组件 URL 请求清单和 core ZIP，总 HTTP 有效载荷为 17,036,333 字节，其中清单 9,271,341 字节、core 7,764,992 字节，复用 1,144,331,056 字节的已安装文件；重建后代码签名、内核、离线 OCR 和 PDF 保存通过。这是受控代码变化的组件演练，后续更新流量取决于实际变化的组件与缓存。

v0.2.3 客户端首次升级至 v0.2.4 仍完整下载；新的差量和组件能力由 v0.2.4 客户端用于后续版本。公开组件版本间升级仍待下一补丁版本验收；macOS 14 / Windows 10 最低支持系统的实际安装升级，以及 Windows 实机升级仍待完成。

## v0.2.3 应用内更新发布

按用户要求，更新页已改为下载进度条、已下载大小，以及下载完成后的自动安装重启。下载任务在主进程独立运行，不受 Harness RPC 的 30 秒超时或页面切换影响；下载和校验失败保留当前应用，允许重试。

本机 macOS arm64 验证了流式下载完整性、真实 ZIP 解压/签名检查、独立安装助手等待退出、应用替换、实际启动测试应用、替换失败恢复及配置保留。Electron 测试使用真实主进程/RPC/界面和可控下载/安装适配器，验证进度、页面切换、失败重试与自动进入安装；不会替换用户正在使用的应用。Windows 静默安装参数与事件处理通过适配器测试，真实 Windows 安装升级仍待该平台验收。[v0.2.3 已正式发布](https://github.com/ZhiPenTu/LabelEdit/releases/tag/v0.2.3)。此前 v0.2.0–v0.2.2 仍使用原手动更新方式，需先安装一次 v0.2.3。

发布源码提交 `d255623`，补丁版本 `v0.2.3`；未提升主版本号或次版本号。[双平台验证](https://github.com/ZhiPenTu/LabelEdit/actions/runs/37940067181) 与 [正式发布](https://github.com/ZhiPenTu/LabelEdit/actions/runs/37940071640) 均成功，macOS 和 Windows 的构建、平台测试、4 项 Electron 测试以及源码目录外完整打包应用的内核/OCR/PDF 导出通过。公开 Release 包含 14 个文件；两平台更新检查确认 v0.2.2 能发现 v0.2.3，v0.2.3 返回已是最新版。

公开 Mac ZIP 与 Windows EXE 已下载并通过 GitHub SHA-256 摘要校验。Mac ZIP 解压后通过 ad-hoc 签名校验，再由 `scripts/test-packaged-desktop.mjs` 复制到源码目录外，以隔离用户目录启动，真实内核、离线 OCR 与 PDF 保存通过；未替换用户当前安装的应用。

发布后的 `latest.yml` / `latest-mac.yml` 版本、文件大小与 SHA-512 均与实际下载文件一致；四个公开插件包的 SHA-256 与生产 Ed25519 签名全部通过，`market/catalog.json` 已同步本次发布生成的目录。

## 差量与组件更新开发验收

`codex/differential-component-updates` 已实现 macOS ZIP blockmap 差量、校验缓存复用、HTTP Range 断点续传与安全完整下载回退；Windows 保留 electron-updater/NSIS 差量通道。第二阶段将完整 Mac 应用分为应用代码、独立 Electron framework、依赖、OCR 运行时、模型和插件代码（界面与冻结程序入口），签名清单按文件哈希选择需要下载的组，重建完整应用并沿用原安装/重启/恢复助手。Release 工作流已加入独立组件制品生成、签名与重建应用的离线运行检查。

本机通过真实 HTTP 测试验证完整/差量/组件续传、缓存损坏、不可用 Range、差量重建哈希失败的回退、组件缺失/损坏、签名与产品/平台/版本约束、目录越界与链接、单文件哈希拒绝。完整应用重新打包后复制到源码目录外，真实 Harness、沙箱离线 OCR 与 PDF 保存通过；真实 Electron 更新界面验证差量进度、复用大小、页面切换和失败重试。

完整组件演练仅修改一次性安装副本的应用代码，通过本地 HTTP 下载 7,760,746 字节的 core ZIP，复用 1,137,643,759 字节的本地应用文件，重建后 codesign、独立内核、离线 OCR 和 PDF 导出通过。清单流量另计，体积是这次演练的结果，不代表所有版本更新固定只有此大小。公开 v0.2.3 ZIP 对比本地候选 ZIP 的真实 blockmap 演练下载 291,825,675 字节的变化数据，复用 170,083,798 字节，最终 SHA-256 与候选 ZIP 一致；索引计入后 HTTP 总流量为 292,300,230 字节。GitHub 的实际 v0.2.3 ZIP 已验证支持精确 HTTP 206 Range。

该实现已随 v0.2.4 公开发布并完成上述制品及 Mac 实际升级校验。v0.2.3 不含新差量/组件能力，首次升级到 v0.2.4 仍需完整下载；依赖迁移及 Electron/Python/模型变化可能仍需较大下载。依赖拆分仅用于 macOS，Windows 保持原安装包布局并由双平台 CI 回归；公开组件版本间的升级、macOS 14 / Windows 10 最低系统安装验收和 Windows 实机升级仍待完成。

2026-10-10，[双平台制品验收](https://github.com/ZhiPenTu/LabelEdit/actions/runs/37956473148) 在实现提交 `963922c` 上全部通过。Mac 完整应用和生产 Ed25519 签名组件的重建应用分别通过源码目录外的真实内核、离线 OCR 和 PDF 保存检查；53 项平台测试、前端和 Electron 回归通过。Windows 完整安装包构建及独立应用运行通过。组件演练中签名清单为 9,271,341 字节，core ZIP 为 7,764,982 字节，总 HTTP 有效载荷为 17,036,323 字节，复用 1,144,331,056 字节的已安装文件。两平台验收制品均上传成功，publish 任务跳过，公开 v0.2.3 仍保留原 14 个文件。Mac 签名工具的二进制检测已限制为 32 个并发读取，低至 256 文件句柄环境的真实扫描及打包通过，避免大量依赖展开后发生 EMFILE。

## 已通过的本地命令

### v0.2.2 轻作界面与发布

[改版 PR #7](https://github.com/ZhiPenTu/LabelEdit/pull/7) 已合并，版本标签指向 `d6c938a369f170a1b5a9af24e5479234fba2ee54`。[PR 双平台验证](https://github.com/ZhiPenTu/LabelEdit/actions/runs/37927695110)、[合并后验证](https://github.com/ZhiPenTu/LabelEdit/actions/runs/37928575721) 和 [v0.2.2 正式发布](https://github.com/ZhiPenTu/LabelEdit/actions/runs/37928653951) 全部成功。公开 Release 包含 14 个文件，安装后应用名称为 Qingzuo；沿用应用身份、用户数据目录和插件 ID，安装包仍使用 CommerceTools 文件名以兼容旧版更新检查。Windows 用户目录比较通过真实路径规范化，兼容 Electron 返回的短路径别名。

本机通过 13 个前端测试、11 个 Python 测试及 4 个子测试、28 个平台测试、3 个 Electron 流程和 295 个 Mach-O 的 macOS 14 部署目标检查。IAB 与原生 Electron 检查浅色、深色、搜索与清空、真实市场目录、1440×1000 桌面和 390×844 窄屏；没有相关控制台错误或横向溢出。真实示例标签识别出 41 个文字区域，选择 Batch Number 后属性面板同步。布局、主要文案、字体、配色与表面、图标与插画、编辑器与响应式六项与设计概念核对通过；实际目录内容和 PDF 样例采用真实数据。[设计与资源记录](design/qingzuo.md) 保留视觉规则和生成提示词。

发布后从公开 Release 下载四个插件包，SHA-256、GitHub 制品摘要和生产 Ed25519 签名全部匹配，默认目录采用生成的 `commerce-market.json`，保留原始签名与校验值。公开 Mac ZIP 的 SHA-256 为 `e2ef0453d6792115c5468a7444bd129d48794001409588f674c590198a36b913`，与 GitHub 摘要一致；解压后通过 `scripts/test-packaged-desktop.mjs` 再复制到源码目录外，以隔离用户目录启动，完成真实 Harness 内核、沙箱离线 OCR 和 PDF 保存。macOS arm64、Windows x64 的 v0.2.1 更新检查均返回 v0.2.2 和本版日志，v0.2.2 返回已是最新版。

### v0.2.1 内核启动修复

v0.2.0 从 `/Applications` 启动时已复现 `ERR_MODULE_NOT_FOUND: @deepseek-ai/cordis-plugin-group`。生产打包漏掉 Harness 启动所需的 peer dependencies，其中还包括 `dsh-scope`；原先从源码目录启动的打包测试借用了开发依赖，不能证明独立安装可用。此前的打包启动记录存在这一局限。

v0.2.1 显式声明固定版本的启动运行依赖；内核模块在初始化处理器中加载，缺失模块错误通过 IPC 返回。打包测试将完整应用复制到源码目录外，清除 Node 依赖环境变量并使用独立工作目录启动。本机新测试通过真实内核、离线 OCR 和 PDF 保存；28 项平台测试（含缺失启动模块的子进程回归）、13 项前端测试、3 项 Electron 测试及 295 个 Mach-O 的最低系统检查通过。

[修复 PR #6](https://github.com/ZhiPenTu/LabelEdit/pull/6) 已合并；[双平台验证](https://github.com/ZhiPenTu/LabelEdit/actions/runs/37921232929) 和 [v0.2.1 正式发布](https://github.com/ZhiPenTu/LabelEdit/actions/runs/37921410975) 全部成功。本机 `/Applications` 中的修复版使用现有用户数据完成七个内核服务和离线 OCR 检查，普通启动也显示内核已连接；原 v0.2.0 应用已备份，用户数据未清除。

v0.2.1 发布后，从 GitHub 下载实际 Mac ZIP，文件哈希与 Release 提供的 SHA-256 一致；解压后再次复制到独立临时目录，真实内核、离线 OCR 和 PDF 导出通过。四个公开插件制品的哈希和生产签名通过，客户端默认市场目录与发布目录一致；两平台 v0.2.0 更新检查返回 v0.2.1 及本版日志，v0.2.1 返回已是最新版。v0.2.0 发布页已注明使用修复版。

- `npm run build`
- `npm test`：13 个前端测试。
- `python -m pytest -q`：11 个测试及 4 个子测试，包含 Python 框架资源转换与越界/循环链接拒绝。
- `npm run build:sandbox`，Windows `cargo check --target x86_64-pc-windows-gnu`。
- `npm run test:platform`：28 个测试：真实内核、缺失模块诊断、进程沙箱、系统凭据、包管理、代理、打包 RPC、可选代码签名及 GitHub 手动更新回归。
- `node scripts/test-plugin-navigation.mjs`：不接入调试器的真实应用检查，连续并发打开网页工具，在本地服务运行时再打开工具，验证同一插件只有一个页面、WebRTC 的真实 TCP/UDP 请求被阻止及关闭后释放处理进程；Windows 额外检查桌面可执行文件 ACL 不受插件影响。
- `npm run test:desktop`：3 个测试：真实 Electron 导入、隔离（含 WebRTC TCP/UDP 探测）、标签页、离线 PDF 保存、模拟抠图保存、卸载凭据清理、市场恢复及未签名底座的最新日志/GitHub 下载页/拒绝自动安装/检查失败重试。
- `node scripts/test-packaged-desktop.mjs`：复制分发应用到源码目录外并独立启动，验证工具中心、真实 Harness 内核、沙箱 OCR 与 PDF 保存；验证和正式发布 CI 都运行此检查。
- 2026-10-09 的未签名分发调整：在没有发布者证书的情况下生成 macOS arm64 DMG/ZIP；实际签名为 `adhoc`、无 Team ID。295 个随包 Mach-O 的 macOS 14 部署版本检查、生产市场公钥/更新模式/打包源码一致性检查，以及完整打包应用的手动更新页、内核、OCR 与 PDF 保存通过。本项不等于最低系统的用户安装验收。

## 尚未完成的用户验收

macOS 14 与 Windows 10 最低支持系统的沙箱、安装及 GitHub 手动更新回归尚未完成。v0.2.0 已按用户 2026-10-09 的发布指令公开，两平台 CI 的最新系统测试不等于最低系统验收。当前 GitHub 分发不要求 Apple Developer ID、notarization 或 Windows 发布者签名；remove.bg 真实 API 与额度验收暂缓。正式签名和标准自动更新仍是后续可选能力，不能将它们或真实 API 验收标记为已完成。

发布证据：[v0.2.0 工作流](https://github.com/ZhiPenTu/LabelEdit/actions/runs/37918154199) 的 macOS、Windows 打包和 publish 三个任务全部成功；公开 Release 包含 14 个文件，版本标签指向 `0d0c703`。后续市场目录独立维护，不修改已发布标签。

发布后验证：从公开 Release 下载四个插件制品，SHA-256 和生产 Ed25519 签名全部匹配；默认线上目录与发布目录一致，两平台更新检查能读取真实 v0.2.0 日志。实际 macOS 打包应用完成线上市场加载、签名 AI 抠图插件安装、页面打开、最新版本检查和卸载，未出现页面异常，未调用 remove.bg API。公开 SDK 压缩包与独立安装、模板创建、校验和打包测试使用的制品逐字节一致。

## 旧代码清理

已移除 Tauri Rust 工程与依赖、旧更新器界面和测试、旧 HTTP/uvicorn 服务、重复开发/打包/冒烟脚本。PDF/OCR 文档操作提取到 `backend/document_service.py`，唯一入口为沙箱 RPC；Electron 最初复用原图标，v0.2.2 已替换为轻作工具盒图标。按用户补充决定移除旧公开下载与更新清单，旧源码文档与截图均移除。本地旧构建、旧版安装包、对比报告和临时目录也已清理。

## macOS 14 运行资源

当前独立 Python/OCR 运行资源的 267 个 Mach-O、完整 `.app` 的 295 个 Mach-O 部署版本检查通过，均支持部署目标 macOS 14.0。Electron 固定 44.0.0，与上游原生加载适配器支持的运行时指纹一致；原生适配器固定官方 0.1.9，macOS 从固定上游提交编译未修改源码，部署目标 14.0。该检查不等于在真实 macOS 14 上完成安装和沙箱验收。

完整安装包的 CI 构建暴露了 Python framework 普通资源布局无法重新 codesign 的问题。macOS 打包改用独立 CPython 3.12.11（uv 0.11.6 管理），打包入口提前拒绝 framework Python。临时构建环境使用真实解释器路径及链接，避免复制 standalone 可执行文件后无法定位 libpython；最终插件资源仍转为普通文件。插件制品不接受符号链接，不通过忽略运行资源签名绕过此问题。

## 2026-11-08 对话与 Agent 运行时移除

- 移除完整 `@deepseek-ai/dsh` CLI 元包和 Agent 运行时（`llm`、`session`、`session-projection`、`tools`、`tool-executor-native`、`agent`、`agent-loop`、`jobs-local`、`session-persistence-jsonl`、`system-prompt`）。内核只通过 `@deepseek-ai/dsh-app-boot` 组合 Profile，继续加载 7 个受保护系统服务。
- 移除工作台对话 IPC、`firstParty.assistant.chat`、`ai.assistant.*`、插件工具审批卡与 assistant 事件。保留 `ai.complete()`、`ai.models()`、`ai.batch.*`、批次事件和 `firstParty.assistant.settings`。
- 删除死代码 `AIChat`、`AISettings`、`HarnessPresentation`、`harness-client` 及对应测试与会话夹具；设置页保留「AI 服务」入口并指向 `official.ai-assistant` 的插件设置页，该页面仍通过第一方设置桥工作，对话入口不再提供。
- 生产依赖闭包由 806 降至 167；`@deepseek-ai` 由 334 包 / 620MB 降至 12 包 / 1.5MB。
- 本地验证：`npm run build` 通过；`npm test` 7 个文件 57 个测试通过；`npm run test:platform` 312 个测试通过；`npm run test:harness-contract` 42 个测试通过；`npm run test:kernel` 2 个通过；`npm run upstream:check` 63 项通过；Electron `platform`、`migration`、`tool-surface`、`first-party-settings`、`first-party-tier` 5/5 通过；macOS arm64 打包应用通过 `scripts/test-packaged-desktop.mjs` 验收并在本机安装启动。
- 尚未验证：Windows 实机；`official.ai-assistant` 的 settings-only 0.2.0 仍在本仓库外的 `codex/remove-chat-page` 分支，需审查合并并发布市场后才能替换线上 0.1.2。
