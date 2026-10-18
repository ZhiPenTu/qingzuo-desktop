# 插件开发

底座运行官方 Harness Profile/Bundle。第三方的界面和处理代码始终位于隔离进程；内核只加载本项目受信任的声明式 Cordis 适配器。v0.2.7 的插件 API 为 1.1.0、SDK 为 1.1.1，兼容声明 ^1.0.0 的旧插件，插件版本和底座版本独立。

## 快速创建

在仓库运行 `npm ci --ignore-scripts`。SDK 也可以用 `npm pack --workspace @commerce/plugin-sdk` 生成独立 npm 包，安装该包后使用 `commerce-plugin` 命令。

```sh
npm run plugin -- create my-tool
npm run plugin -- create my-native-tool --native
npm run plugin -- validate my-tool
npm run plugin -- pack my-tool my-tool.ecplugin
```

在插件管理中导入 ZIP 格式的 `.ecplugin`。导入时显示本地来源和隔离说明。无需重新构建或发布底座。模板包含已构建网页和 SDK 副本；普通用户无需安装开发运行时。Native 模板由底座内置 Node 运行，采用逐行 JSON RPC。生产环境不运行包内 npm/Python 安装脚本，依赖须由开发者构建到 UI/worker 制品内；`node_modules` 和 `.env*` 不会被打包。

`package.json.commerce` 声明 `manifestVersion: 1`、全局唯一 `id`、`title`、`description`、`api: ^1.0.0`、相对 `ui`、可选 `settings`、`permissions`、`services.provides/requires` 与 `backend`。本地程序以 `backend.entry.darwin-arm64` / `win32-x64` 声明入口。禁止绝对路径、符号链接、目录穿越、系统插件 ID、安装脚本执行和同名服务覆盖。

原生构建工具生成的库和框架别名需在打包前转成普通文件及目录。LabelEdit 构建脚本只复制 PyInstaller 输出目录内部的资源，逐层校验目录别名；外部链接、循环链接及无效链接会使构建失败。安装器继续拒绝所有 ZIP 符号链接。

SDK 提供文件选择/读取/保存、凭据设置/状态/清除、受控网络请求、服务调用、工具/设置贡献、取消和清理。凭据读取仅存在于可信代理，插件页面无法读取已保存密钥。界面通过 `createPluginClient()` 获得 API；类型见 `packages/plugin-sdk/index.d.ts`。普通网络请求支持 HTTPS 的 GET/POST/PUT/PATCH/DELETE、JSON 内容及按引用注入 Bearer/X-Api-Key，响应为状态、MIME 和 Base64 数据。remove.bg 另提供受控文件上传适配器，返回可保存文件令牌。代理锁定已解析目标，禁止私网、重定向及未声明来源；公共域名兼容系统 TUN 的 198.18/15 映射，并始终验证该域名的 TLS 证书。任务取消会停止调用方本地进程并终止在线请求；失败请求不会自动重发。

浏览器联动需要在清单中显式声明 `permissions.browser`，可申请 `detect` 和 `download`。宿主只向插件发送脱敏的候选 ID、标题、类型、来源页和状态；媒体地址、Cookie、签名参数和浏览器会话始终留在主进程。插件通过 `createPluginClient().browser` 读取候选、请求重新扫描、创建下载任务和接收状态事件，不能直接访问浏览器 DOM 或会话。

插件生成的文件通过 `client.files.create({ data, filename, mime })` 建立私有文件令牌，`data` 为 Base64；再调用 `client.files.save(token.token, filename)` 打开系统保存对话框。需要声明 `permissions.files`，其他插件无法读取该令牌；生成内容建议不超过 25 MB。LabelEdit 的 PDF 导出直接使用这条通道，不依赖浏览器下载事件。

插件页面的网络隔离同时使用 CSP、请求拦截、不可达 SOCKS 代理及 WebRTC 禁止非代理连接策略，包含回环地址；配置校验失败时页面不会启动。插件的 HTTP 和 WebRTC 连接不能绕过 `client.network.request()`；页面无需自行配置代理。

本地程序只可读取插件制品和必要运行时，写入私有任务目录。文件选择器由宿主授权，文件字节由文件令牌或受控 RPC 传入。输出由选择器保存。直接联网、访问其他插件数据与系统凭据、启动其他程序均被系统沙箱阻止；沙箱不可用时拒绝运行。

## 市场发布与升级

### API 1.2 本地预览

SDK 1.2.0 新增 `files.pickMany()`、`files.pickDirectory()`；目录仅返回不透明令牌和名称，不返回路径。`ai.batch.create/get/list/revise/start/cancel/preview` 用于宿主持有的批图任务，`ai.assistant.send/status/cancel` 与 `ai.onEvent()` 用于共享文本助手。类型定义见 SDK `index.d.ts`。

清单声明 `permissions.ai: ['assistant', 'image-edit']`，批次还需文件权限。官方图像编辑需声明服务 network origin 和插件隔离凭据 `google-image` / `openai-image`。`ai.models({ source: 'proxy' })` 读取共享代理图片目录，`ai.batch.create({ source: 'proxy', ... })` 固定图片来源、型号与参数；无 source 的旧调用仍使用官方 API。代理图片支持 GPT Image 的 `/v1/images/edits`、Gemini 的 `/v1beta/models/{id}:generateContent` 和目录中 `type: openai-image` 的兼容别名。未知能力不展示推测参数，目录缺失型号不会回退；外部代理兼容模型需配置 `image: true`。切换代理地址后旧批次禁止改投新来源，但已生成结果仍可重新保存。凭据不会返回插件；上传和大响应由可信适配器处理，不放宽通用网络接口限制。模型发现只是读取目录，不验证账户图像权限，也不发送付费生成请求。外部代理的上游重试策略由其管理端配置，轻作本身不重发图片请求。

`batch.create` 固定输入副本和有效提示词，创建草稿而非提交请求。`revise` 使用 revision 检查；`start` 必须携带用户选定的 directoryToken 和当前 revision。重复 start 不重复生成；恢复不重发 unknown 项。`retryFailed: true` 仅显式重试 failed 项，对 save-failed 项只重新保存。关闭工具视图不取消批次，停用和卸载才取消所属任务。

本地预览固定 SDK 压缩包和底座制品测试，不使用未发布的公共版本；暂不签名上架。旧底座通过 `api: '^1.2.0'` 拒绝安装并提示升级。

业务插件在独立仓库构建、测试和发布，底座不再构建业务制品。使用 sdk-v1.1.1 Release 中的固定 npm 压缩包与 lockfile，API 契约仍是 1.1.0。测试辅助入口 @commerce/plugin-sdk/testing 的 launchPluginTestHost 接受 executablePath、artifactPath 和 pluginId，在独立用户目录启动指定底座制品、导入并打开插件，返回 app/page/plugin/close。开发验收依赖 @playwright/test，运行插件不需要测试依赖。

API 1.1 增加 files.url(token) 与 files.release(token)。URL 只在插件自身隔离会话中有效；其他插件不能读取令牌。network.request 支持 multipart.fields 和 multipart.files（field/token），不能与 json 同时使用；上传总量最多 25 MB。responseType: file 返回 status/mime/file，普通响应返回 status/mime/data；响应上限分别为 64 MB 和 8 MB。HTTP 错误状态由插件解释，凭据注入、网络边界和取消由底座执行，失败不会自动重试。

目录维护位于 ZhiPenTu/qingzuo-market。发布者生成双平台目录片段，市场验证原始 Release 制品后签名并提出 PR，合并后上架。目录条目的 api 是可选兼容范围，旧条目默认 ^1.0.0，不兼容插件在界面和安装入口均被阻止。

官方制品需 Ed25519 签名与 SHA-256。使用 `COMMERCE_PLUGIN_SIGNING_KEY` 环境变量运行 `npm run plugin -- sign <artifact>`，不要将私钥写入源码或插件包。目录每个条目仅保留最新版本及其变更日志；每个平台记录 URL、哈希和签名。示例结构由 `scripts/market-artifacts.mjs` 生成。

将经过验收的 `commerce-market.json` 内容更新到 `market/catalog.json` 并提交即可更新在线目录；它不依赖底座安装包重发。开发者自助发布、支付和账号不属于首版范围。市场下载会校验签名、平台、身份和版本；本地包同样进入暂存校验与启动探测。失败恢复原版本，插件管理可显式恢复上一版本。

停用/卸载时 Cordis 服务注销、视图关闭、文件令牌失效、任务取消并清理进程。不同调用方访问同一服务时使用各自的进程实例，避免共享另一工具的文档状态。

## AI 对话调用插件（API 1.2 本地预览）

宿主「AI 对话」通过 Harness 发现已启用插件。所有插件支持确认后打开工具或设置；AI 批图还有可信宿主提供的批次工具。其他本地插件可在清单新增 `assistant.tools`，每个工具包含 `name`、`title`、`description`、`service`、`method` 和 `parameters`。`service` 必须已列入 `services.provides`，且有 backend。参数采用受限 JSON Schema：object/array/string/integer/number/boolean、properties/required、enum 与长度/数值范围；对象必须 `additionalProperties: false`，不接收密钥、密码、令牌或文件路径。最多 16 个工具；保留名称不能覆盖。

例如服务 `local.echo` 可声明 `echo` 方法，参数 `{ "type": "object", "properties": { "text": { "type": "string", "maxLength": 100 } }, "required": ["text"], "additionalProperties": false }`。只有用户确认该插件与参数后，宿主才在独立 OS 沙箱调用 backend。返回值也会发给文本模型，不应包含凭据或其他插件的私有数据。不要用工具描述请求 AI 绕过确认。调用取消或超时不表示所有外部副作用都已回滚。

上游 UI 复用范围、安全边界和版本升级契约见 [Harness 适配文档](harness-integration.md)。当前只打包本地预览，不发布 SDK 或插件市场更新。
