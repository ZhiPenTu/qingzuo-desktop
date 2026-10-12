# Harness 整组依赖升级流程

Harness 的版本、直接包族、公开导出、历史会话样本和原生加载器审查记录统一保存在
`desktop/upstream/harness.json`。运行时通过 `desktop/harness-version.mjs` 读取同一版本。
这些文件随安装包分发；候选准备不会改动当前运行的轻作或其用户配置。

## 检查当前固定版本和上游发布

```sh
node scripts/harness-upstream.mjs check --report output/upstream/harness-current.json
node scripts/harness-upstream.mjs check-upstream --report output/upstream/harness-check.json
```

`check` 不访问网络，检查所有直接和间接 `@deepseek-ai/dsh` / `dsh-*` 包的固定版本、
根 lockfile、platform-bundle 的 peer、npm tarball 地址与 SHA-512 SRI、Cordis 实际解析范围、
原生加载器 override、源代码 commit / SHA-256，以及 Electron 固定版本。
运行脚本只需要已有项目依赖中的 `semver`，不需要已安装 Harness 包。
SRI 记录检查与下载校验分开：后续候选 `npm ci` 才会实际校验 tarball 字节。

`check-upstream` 只读取 npm 元数据，按配置的发布通道报告候选。
当前通道为 `alpha`；`latest` 可能指向比当前固定版更早的 RC，因此不能盲目安装 `latest`。
控制台显示简短结果，完整检查和未完成验收项写入 `--report` 指定的 JSON。
`checked` 只表示静态依赖一致，不能据此发布候选。

## 准备可审阅的候选

```sh
node scripts/harness-upstream.mjs prepare \
  --version 0.2.1-alpha.2 \
  --directory output/upstream/harness-alpha2 \
  --report output/upstream/harness-alpha2-prepare.json
```

必须传入精确版本。任何直接包尚未发布该版本都会停止整组准备。
脚本读取候选的 npm dependencies / peerDependencies，分别求解 Cordis 和各 Cordis 插件的版本；
Cordis 的独立版本号不跟随 dsh 包族版本号。求解会审查 group、include、loader 等兄弟包的
实际约束，并在不兼容时停止。完整 npm 解算结果还会再次按 lockfile 审查。

候选目录必须不存在。脚本把当前 Git 工作区的源码（包括正在审阅的修改）复制到持久目录，
排除生产 profiles、环境变量文件、npm 认证配置、密钥、依赖目录和生成物，然后在那里一起
修改根 manifest、platform-bundle peer、canonical metadata 和 lockfile。
唯一的 npm 准备命令是 `install --package-lock-only --ignore-scripts`，不会向当前工作区安装依赖。
候选自己的 HOME、临时目录、npm 缓存和空 npmrc 均位于 `.validation/`。
不继承 API key、Harness HOME、Codex HOME、代理认证或发布签名环境。

准备结果在候选中的 `harness-prepare-report.json`；失败也会写报告。
报告路径不能与源码或候选的 manifest、lockfile、上游固定版本或候选标记重合；
大小写和符号链接别名也会在执行前拒绝，失败报告不能覆盖这些输入。
不要把候选 `node_modules` 链接到当前工作区，这会绕过候选验证。

## 原生加载器是硬性升级门槛

当前加载器固定为 `node-addon-require-builtin@0.1.6`，使用 metadata 中记录的官方源码
commit 与 SHA-256。`scripts/build-harness-native.mjs` 从同一 metadata 读取构建记录。
如果候选包要求不同范围，脚本会在复制和安装前停止，不能通过改一个 override 绕过。
必须先审查新的官方源代码、归档校验值、目标系统、N-API、Node 和 Electron 运行时，再更新
完整原生审查记录及对应测试。

2026-10-11 的 npm 检查发现 `0.2.1-alpha.2`，但该版本要求加载器 `^0.1.9`。
候选准备已按这个门槛阻止升级；当前仍保持 `0.2.1-alpha.1` 与已审查的 `0.1.6`。
上游发布发现与候选通过验证是两件独立的结果。

## 执行候选验证

```sh
node scripts/harness-upstream.mjs validate \
  --directory output/upstream/harness-candidate \
  --report output/upstream/harness-candidate-validation.json
```

`validate` 只接受 `prepare` 生成的标记目录。使用 Node 24，在 macOS arm64 或 Windows x64
运行。它会在候选目录执行 `npm ci --ignore-scripts`，对照候选 lockfile 检查已安装的直接及
间接 Harness / Cordis / 原生包名称与版本，并拒绝解析到目录外的包。
随后构建固定官方原生源码（macOS），在 Node 和 Electron 中实际获取内部模块加载器，
检查公开根导出、执行 TypeScript / Vite 构建，以及以下本地契约：

- 受保护的七个宿主系统服务、AI 服务加载与内核清理。
- 官方 Agent 工具调用、插件身份隔离、确认/拒绝与取消。
- 流式文字、推理、usage、SSE 分块和异常；截断响应不会执行未完成工具。
- 冻结的 alpha.1 JSONL 继续对话、历史工具结果、已完成调用不重放。
- 旧会话执行中断后的状态、真正等待确认的旧引擎日志、重启后重新授权。
- 公共 UI 组件根导出、会话界面与 Markdown / JSON / 活动组件构建。

HTTP fixture 只监听 `127.0.0.1`，模型、token、图片和插件执行均使用合成数据。
不会访问生产会话，也不会发起付费模型请求。由于 `npm ci` 禁用所有安装脚本，验证只会显式
运行固定 Electron 包的官方下载脚本以获得运行时，并显式运行受审查的原生源码构建。
如果这些前置条件缺失，结果为 `failed`，不会跳过后宣称通过。

需要无网络复查时，使用已完成安装且原生源码已缓存的同一候选：

```sh
node scripts/harness-upstream.mjs validate \
  --directory output/upstream/harness-candidate \
  --offline --report output/upstream/harness-candidate-offline.json
```

无网络验证仍对照 lockfile 检查实际安装版本；旧版本 `node_modules` 无法让新候选误判通过。
缺少该候选的依赖、固定源码缓存或 Electron 二进制都会明确失败。
每一步日志保存在 `.validation/logs/`，结果也保存为 `harness-validation-report.json`。
`validated` 表示这些契约通过，仍会列出 macOS 15 / Windows 10 安装包验收。

## 采用候选与保留回退

先审阅候选 manifest、lockfile、metadata、Cordis 约束和报告，再把这组文件一起纳入工作分支。
同步第三方声明，运行发布所需的完整测试和安装包验收；不要仅复制某个 dsh 包的版本号。
首次安装前备份 `harness/ai`、`harness/ai-session-logs`、`ai-batches` 与代理配置。
会话格式变化需要另行审查迁移，不能用生产日志做自动试迁移。
保留旧固定版本、旧安装包和数据备份，候选失败时恢复整组 manifest / lockfile / metadata。

此流程发现和验证上游发布，不会自动更新用户安装的 Harness，也不会自动发布轻作版本。

## 应用内检查与安装语义

设置页“运行环境”中的 Harness 版本是 `desktop/upstream/harness.json` 的固定版本，
表示当前安装包实际审核过的整组依赖，不是用户目录中的可替换 npm 版本。当前应用内的
“检查轻作更新”检查轻作自己的正式发布；发现更新后，下载、校验、安装和重启的是签名的
轻作安装包（macOS 可使用已签名的组件清单和组件包），不会在线执行 npm 安装，也不会只
替换 Harness 的某一个包。更新状态中的 `mode=components` 只表示应用更新传输采用了
组件复用，不能解释为 Harness 已经独立更新。

当前 `status` IPC 只公开轻作安装包的 `update` 状态，没有可触发 Harness 替换的
`componentUpdates` 接口。若未来增加组件检查状态，应将其作为只读、可增量的候选信息
（当前版本、候选版本、阶段、进度、错误和兼容性结论），不得把本地路径、下载地址或
未验证的 npm 元数据发送给界面；“可用”也只能表示候选已发现，不能表示可以跳过整组
Harness 验证直接安装。

因此，Harness 上游候选只能在本项目的隔离候选目录完成整组准备和兼容性验证后，随新的
轻作版本发布。候选失败时继续运行当前安装包；用户会话、`harness/ai-session-logs`、
`ai-batches` 和代理配置留在用户目录，由新版本启动时按会话兼容契约读取。除非另行设计
签名运行时包、双槽切换、内核重启健康检查和失败回滚，否则不应在设置页提供“独立更新
Harness”操作。
