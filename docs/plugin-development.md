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

`package.json.commerce` 声明 `manifestVersion: 1`、全局唯一 `id`、`title`、`description`、`api: ^1.0.0`、相对 `ui`、可选 `icon`、`settings`、`permissions`、`services.provides/requires` 与 `backend`。`icon` 使用不超过 36 KB 的 PNG data URL，由市场、工具中心和插件管理统一显示；未提供时回退到分类图标。本地程序以 `backend.entry.darwin-arm64` / `win32-x64` 声明入口。禁止绝对路径、符号链接、目录穿越、系统插件 ID、安装脚本执行和同名服务覆盖。

原生构建工具生成的库和框架别名需在打包前转成普通文件及目录。LabelEdit 构建脚本只复制 PyInstaller 输出目录内部的资源，逐层校验目录别名；外部链接、循环链接及无效链接会使构建失败。安装器继续拒绝所有 ZIP 符号链接。

SDK 提供文件选择/读取/保存、凭据设置/状态/清除、受控网络请求、服务调用、工具/设置贡献、取消和清理。凭据读取仅存在于可信代理，插件页面无法读取已保存密钥。界面通过 `createPluginClient()` 获得 API；类型见 `packages/plugin-sdk/index.d.ts`。普通网络请求支持 HTTPS 的 GET/POST/PUT/PATCH/DELETE、JSON 内容及按引用注入 Bearer/X-Api-Key，响应为状态、MIME 和 Base64 数据。remove.bg 另提供受控文件上传适配器，返回可保存文件令牌。代理锁定已解析目标，禁止私网、重定向及未声明来源；公共域名兼容系统 TUN 的 198.18/15 映射，并始终验证该域名的 TLS 证书。任务取消会停止调用方本地进程并终止在线请求；失败请求不会自动重发。

浏览器联动需要在清单中显式声明 `permissions.browser`，可申请 `detect`、`download` 和 `automate`。宿主只向插件发送脱敏的候选 ID、标题、类型、来源页和状态；媒体地址、Cookie、签名参数和浏览器会话始终留在主进程。插件通过 `createPluginClient().browser` 读取候选、请求重新扫描、创建下载任务和接收状态事件，不能直接访问浏览器 DOM 或会话；`automate` 只能通过 API 1.3 的结构化快照和受限操作触达清单白名单内的页面。

只申请 `automate` 的插件也可以调用 `browser.status()`，但返回值被裁剪为它自己打开过的标签页，候选、下载任务和其他标签页一律不可见。`browser.rescan()` 与完整状态仍然需要 `detect`。

插件生成的文件通过 `client.files.create({ data, filename, mime })` 建立私有文件令牌，`data` 为 Base64；再调用 `client.files.save(token.token, filename)` 打开系统保存对话框。需要声明 `permissions.files`，其他插件无法读取该令牌；生成内容建议不超过 25 MB。LabelEdit 的 PDF 导出直接使用这条通道，不依赖浏览器下载事件。

插件页面的网络隔离同时使用 CSP、请求拦截、不可达 SOCKS 代理及 WebRTC 禁止非代理连接策略，包含回环地址；配置校验失败时页面不会启动。插件的 HTTP 和 WebRTC 连接不能绕过 `client.network.request()`；页面无需自行配置代理。

本地程序只可读取插件制品和必要运行时，写入私有任务目录。文件选择器由宿主授权，文件字节由文件令牌或受控 RPC 传入。输出由选择器保存。直接联网、访问其他插件数据与系统凭据、启动其他程序均被系统沙箱阻止；沙箱不可用时拒绝运行。

## 第三方界面配色

插件虽然独立渲染，也应像轻作工作台中的一个工具，而不是嵌进来的另一套产品。工作区域在浅色模式下使用纯白 `#ffffff`，通过中性边框、轻量中性表面和清晰排版建立层级；窗口外壳才使用浅灰。墨绿/薄荷绿只承担主操作、当前选择和焦点。插件使用 `--qz-*` 局部语义变量，不假定能读取宿主 CSS 变量。完整规则见 [插件界面视觉规范](design/plugin-ui-guidelines.md)。

当前隔离页面不会继承底座的强制主题，默认使用 `prefers-color-scheme` 跟随系统。宿主后续提供明确的主题值时，插件应优先使用宿主值。

```css
:root {
  color-scheme: light;
  --qz-bg: #ffffff;
  --qz-surface: #ffffff;
  --qz-overlay: #ffffff;
  --qz-surface-subtle: #f8f9f7;
  --qz-canvas: #eef0ec;
  --qz-text: #1f2d26;
  --qz-text-muted: #68756e;
  --qz-primary: #28654a;
  --qz-primary-hover: #1e503a;
  --qz-on-primary: #ffffff;
  --qz-selection: #e7eee8;
  --qz-on-selection: #245a43;
  --qz-muted: #f0f2ef;
  --qz-hover: #edf1ed;
  --qz-border: #e1e5e0;
  --qz-input-border: #d5dcd6;
  --qz-focus: #28654a;
  --qz-danger: #b42318;
  --qz-boundary-strong: #69756e;

  --qz-success: #28654a;
  --qz-success-surface: #e4eee5;
  --qz-warning: #956219;
  --qz-warning-surface: #faf0dd;
  --qz-danger-surface: #f8e9e8;
  --qz-info: #20312a;
  --qz-info-surface: #edf2eb;

  --qz-chart-1: #28654a;
  --qz-chart-2: #956219;
  --qz-chart-3: #466b7a;
  --qz-chart-4: #a14f3f;
  --qz-chart-5: #52645a;
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --qz-bg: #151c18;
    --qz-surface: #1d2621;
    --qz-surface-subtle: #202a24;
    --qz-overlay: #253129;
    --qz-canvas: #111814;
    --qz-text: #edf3ee;
    --qz-text-muted: #a6b5aa;
    --qz-primary: #99d8ad;
    --qz-primary-hover: #b9e6c5;
    --qz-on-primary: #173222;
    --qz-selection: #2c4233;
    --qz-on-selection: #bde6c8;
    --qz-muted: #253029;
    --qz-hover: #2b382f;
    --qz-border: #35433a;
    --qz-input-border: #415246;
    --qz-focus: #99d8ad;
    --qz-danger: #f87171;
    --qz-boundary-strong: #a6b5aa;

    --qz-success: #bde6c8;
    --qz-success-surface: #2c4233;
    --qz-warning: #ebc780;
    --qz-warning-surface: #443821;
    --qz-danger-surface: #36302b;
    --qz-info: #edf3ee;
    --qz-info-surface: #2b382f;

    --qz-chart-1: #99d8ad;
    --qz-chart-2: #ebc780;
    --qz-chart-3: #8eb9c7;
    --qz-chart-4: #e69a86;
    --qz-chart-5: #b2c0b6;
  }
}
```

使用规则：

- 页面和工具内容使用 `--qz-bg`，卡片、列表和面板使用 `--qz-surface`；同一层级不要反复嵌套不同底色。浅色工作区域必须保持纯白，不能用暖白或灰白替代。
- 一个区域只设置一个主操作。次要操作使用边框或幽灵按钮，不要整页铺满绿色按钮。
- 普通卡片使用 `1px solid var(--qz-border)` 和间距分组，不使用装饰性投影、玻璃拟态或多层浮起卡片。
- 卡片圆角保持 `7–9px`，控件和按钮使用 `6px`；不要使用超过 `12px` 的装饰性大圆角。
- 插件最外层页面不需要自行绘制工作区圆角；底座会按当前工作区视觉规范统一裁切原生插件视图。
- 页面留白与控件间距优先收紧；正文和控件保持 `13px` 左右，不能通过缩小字体制造紧凑感。
- 状态必须同时提供图标或文字。信息提示优先使用中性色，不要新增通用蓝色。
- 图表按 `--qz-chart-1` 至 `--qz-chart-5` 顺序取色，并提供直接标签、图例或不同线型；面积填充不超过同色 `16%` 不透明度。
- 键盘焦点使用 `2px` 的 `--qz-focus` 环。输入框不能只靠浅边框识别，应同时有可见标签。
- `--qz-text-muted` 不得直接放在 `--qz-canvas` 或 `--qz-muted` 上；普通文字使用 `--qz-text`。
- 禁止引入紫色、靛蓝、霓虹色或与底座无关的品牌主色。
- 禁止装饰性渐变、光晕、彩色玻璃背景和过量卡片阴影。
- 禁止为插件自行添加第二套顶栏、品牌 Hero、启动页或应用 Logo 来模拟独立产品。
- 禁止重新着色产品截图、第三方 Logo 和用户媒体内容。
- 禁止直接在隔离页面依赖宿主 `--primary`、`.dark` 或主题状态。

## 市场发布与升级

### API 1.3 本地预览

SDK 1.3.0 为「在指定网站上采集结构化数据」补齐五组主进程能力。新增能力全部要求显式清单权限，旧插件不受影响。

- **页面操作**：`browser.open(url)` 在右侧浏览器面板打开页面并返回 `tabId`；`browser.snapshot({ tabId })` 返回 `ref`、`role`、`name`、`value`、`visible`、`rect`，图片与链接附带绝对 `url`，不返回 HTML、Cookie、隐藏输入和密码字段；`browser.act` 支持 `click / type / select / scroll / hover`；`browser.waitFor` 等待元素或文本出现、消失。需要 `permissions.browser: ['automate']`。
- **页面来源白名单**：清单新增 `permissions.browserOrigins`（最多 16 个 origin，可写 `http://127.0.0.1:端口` 便于本地联调）。`browser.snapshot / act / waitFor / saveResource` 只在标签页当前 origin 命中白名单时可用，否则直接拒绝；`browser.open` 也只接受白名单地址。登录态保存在插件隔离分区中，验证码和改版页面由插件提示用户处理，底座不做绕过。
- **资源转存**：`browser.saveResource({ tabId, url })` 使用该标签页的会话（带登录态和 Referer）抓取图片，校验内容类型与 32 MB 上限后交给存储，返回可直接用于上传的文件令牌。需要 `permissions.files` 与 `permissions.storage`。跨源地址仍禁止私网、回环和本地域名。
- **签名与自定义请求头**：`network.sign({ credential, algorithm, message, keySuffix })` 支持 `hmac-sha256` 和 `sha256`，返回 `{ algorithm, encoding: 'base64', digest }`，密钥不离开主进程，凭据必须已列入 `permissions.credentials`。`keySuffix` 用于「HMAC 密钥 = 密钥 + 请求中公开的随机串」这类平台（如希音），最多 32 个可见字符，只有 `hmac-sha256` 接受。`network.request` 新增 `headers`，每个头名都必须列入 `permissions.networkHeaders`（最多 16 个，不能覆盖 `Authorization`、`Cookie`、`Host` 等传输头，单值不超过 2048 字符，`Content-Type` 只在 JSON 请求中允许 `application/json` 及可选 charset，multipart 请求不可覆盖）。用于需要 `x-lt-openKeyId / x-lt-timestamp / x-lt-signature` 这类平台签名头的接口。
- **持久化存储**：`storage.get/set/keys/remove` 按插件隔离，单键 JSON 不超过 1 MB、总量不超过 100 MB；`storage.saveFile/readFile/removeFile` 保存跨重启可用的文件令牌。需要 `permissions.storage`，文件相关方法还需要 `permissions.files`。卸载插件时连同凭据、浏览器分区与存储一并清除。

示例：

```json
"permissions": {
  "files": true,
  "storage": true,
  "browser": ["automate"],
  "browserOrigins": ["https://detail.1688.com"],
  "network": ["https://openapi.sheincorp.com"],
  "networkHeaders": ["x-lt-openkeyid", "x-lt-timestamp", "x-lt-signature"],
  "credentials": ["shein.open-key", "shein.secret-key"]
}
```

插件页面仍拿不到密钥与页面 HTML，只能拿到结构化结果和摘要。旧底座通过 `api: '^1.3.0'` 拒绝安装并提示升级。

### API 1.5 图片输入

SDK 1.5.0 让文本补全可以带上图片，用于「看图写文案」这类需要同时看图和读参数的场景，模型与密钥仍然复用底座配置：

- **消息片段**：`messages[].content` 既可以是字符串，也可以是片段数组，片段为 `{ type: 'text', text }` 或 `{ type: 'image_url', image_url: { url } }`。单条消息最多 4 张图片，整个请求不超过 8 MB。
- **图片来源**：只接受 `https:` 地址，或 `png` / `jpeg` / `webp` 的 base64 data URL；`file:`、`http:`、带账号密码的地址一律拒绝。图片字节由插件自己准备（例如 `files.read(token)`），底座不代读本地文件。
- **模型要求**：只有支持图片输入的文本模型才能识别图片，模型不支持时由模型服务返回错误。
- **兼容性**：纯文本调用方式不变，声明 `api: '^1.4.0'` 的插件继续可用；需要图片输入时声明 `api: '^1.5.0'`。

示例：

```js
const image = await client.files.read(token);
const result = await client.ai.complete({
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: '结合图片和商品信息，给出 3 个英文标题。' },
      { type: 'image_url', image_url: { url: 'data:' + image.mime + ';base64,' + image.data } },
    ],
  }],
  responseFormat: { type: 'json_object' },
});
```

### API 1.4 本地预览

SDK 1.4.0 为「使用底座 AI 配置完成文本任务」补齐插件接口。插件不再自带模型地址与密钥，统一复用用户在底座「设置 → AI 模型」中连接的 OpenAI 兼容服务，全部能力要求显式清单权限：

- **模型目录**：`ai.textModels()` 返回 `{ models, defaultModel }`，其中 `models` 是服务 `/v1/models` 全部返回中过滤出的可用文本模型（`id`、`title`）；底座不再保存指定模型，`defaultModel` 只是目录中的首个文本模型，方便旧插件兼容。新插件应展示目录并由用户或插件逻辑自行选择。
- **文本补全**：`ai.complete({ model?, messages, temperature?, responseFormat? })` 通过主进程调用配置的代理 `/v1/chat/completions`，返回 `{ content, model }`。`messages` 为 1 到 100 条 `system / user / assistant` 消息，单条不超过 10 万字符；`responseFormat` 仅接受 `text` 或 `json_object`。密钥不出主进程，请求与响应大小受主进程限制。
- **共享助手**：`ai.assistant.send({ text, model? })` 也可显式传入目录中的模型；省略时沿用该插件会话已选模型，首次会话回退到目录中的首个文本模型。
- **清单权限**：`permissions.ai` 新增 `text` 值；`api: '^1.4.0'` 声明本能力。旧插件不受影响。

示例：

```js
const { models, defaultModel } = await client.ai.textModels();
const result = await client.ai.complete({
  model: models.some(item => item.id === settings.model) ? settings.model : defaultModel,
  messages,
  temperature: 0.2,
  responseFormat: { type: 'json_object' },
});
```

### 插件端到端联调

自动化测试需要用真实平台主机名访问本地模拟服务。未打包构建可设置 `COMMERCE_TEST_NETWORK_ROUTES`，把已声明的平台 origin 映射到本机 HTTP 服务：

```sh
COMMERCE_TEST_NETWORK_ROUTES='{"https://openapi-test01.sheincorp.cn":"http://127.0.0.1:7801","https://api.openai.com":"http://127.0.0.1:7801"}' npm run desktop:dev
```

只接受 `openapi.sheincorp.com`、`openapi-test01.sheincorp.cn`、`api.openai.com`、`api.deepseek.com` 四个来源，目标必须是 `127.0.0.1`。改写发生在 `NetworkBroker` 完成清单授权之后，插件声明的 `permissions.network` 仍是唯一准入依据；打包构建忽略该变量。页面侧仍走 Chromium，需要真实域名时用 `--host-resolver-rules` 加自签名证书。

### API 1.2 本地预览

SDK 1.2.0 新增 `files.pickMany()`、`files.pickDirectory()`；目录仅返回不透明令牌和名称，不返回路径。`ai.batch.create/get/list/revise/start/cancel/preview` 用于宿主持有的批图任务，`ai.assistant.send/status/cancel` 与 `ai.onEvent()` 用于共享文本助手。类型定义见 SDK `index.d.ts`。

清单声明 `permissions.ai: ['assistant', 'image-edit']`，批次还需文件权限。官方图像编辑需声明服务 network origin 和插件隔离凭据 `google-image` / `openai-image`。`ai.models({ source: 'proxy' })` 读取共享代理图片目录，`ai.batch.create({ source: 'proxy', ... })` 固定图片来源、型号与参数；无 source 的旧调用仍使用官方 API。代理图片支持 GPT Image 的 `/v1/images/edits`、Gemini 的 `/v1beta/models/{id}:generateContent` 和目录中 `type: openai-image` 的兼容别名。未知能力不展示推测参数，目录缺失型号不会回退；外部代理兼容模型需配置 `image: true`。切换代理地址后旧批次禁止改投新来源，但已生成结果仍可重新保存。凭据不会返回插件；上传和大响应由可信适配器处理，不放宽通用网络接口限制。模型发现只是读取目录，不验证账户图像权限，也不发送付费生成请求。外部代理的上游重试策略由其管理端配置，轻作本身不重发图片请求。

`batch.create` 固定输入副本和有效提示词，创建草稿而非提交请求。`revise` 使用 revision 检查；`start` 必须携带用户选定的 directoryToken 和当前 revision。重复 start 不重复生成；恢复不重发 unknown 项。`retryFailed: true` 仅显式重试 failed 项，对 save-failed 项只重新保存。关闭工具视图不取消批次，停用和卸载才取消所属任务。

本地预览固定 SDK 压缩包和底座制品测试，不使用未发布的公共版本；暂不签名上架。旧底座通过 `api: '^1.2.0'` 拒绝安装并提示升级。

业务插件在独立仓库构建、测试和发布，底座不再构建业务制品。使用 sdk-v1.1.1 Release 中的固定 npm 压缩包与 lockfile，API 契约仍是 1.1.0。测试辅助入口 @commerce/plugin-sdk/testing 的 launchPluginTestHost 接受 executablePath、artifactPath 和 pluginId，在独立用户目录启动指定底座制品、导入并打开插件，返回 app/page/plugin/close。开发验收依赖 @playwright/test，运行插件不需要测试依赖。

API 1.1 增加 files.url(token) 与 files.release(token)。URL 只在插件自身隔离会话中有效；其他插件不能读取令牌。network.request 支持 multipart.fields 和 multipart.files（field/token），不能与 json 同时使用；上传总量最多 25 MB。responseType: file 返回 status/mime/file，普通响应返回 status/mime/data；响应上限分别为 64 MB 和 8 MB。HTTP 错误状态由插件解释，凭据注入、网络边界和取消由底座执行，失败不会自动重试。

目录维护位于 ZhiPenTu/qingzuo-market。发布者生成双平台目录片段，市场验证原始 Release 制品后签名并自动更新目录。目录条目的 api 是可选兼容范围，旧条目默认 ^1.0.0，不兼容插件在界面和安装入口均被阻止。

官方制品需 Ed25519 签名与 SHA-256。使用 `COMMERCE_PLUGIN_SIGNING_KEY` 环境变量运行 `npm run plugin -- sign <artifact>`，不要将私钥写入源码或插件包。目录每个条目仅保留最新版本及其变更日志；每个平台记录 URL、哈希和签名。示例结构由 `scripts/market-artifacts.mjs` 生成。

发布仓库生成目录片段后，市场会校验并自动更新在线目录；它不依赖底座安装包重发。开发者自助发布、支付和账号不属于首版范围。市场下载会校验签名、平台、身份和版本；本地包同样进入暂存校验与启动探测。失败恢复原版本，插件管理可显式恢复上一版本。

目录可携带 `stats.downloads`，表示该插件所有正式 Release 中双平台 `.ecplugin` 制品的历史累计下载数。该数字包含重复下载与市场验签产生的下载，不代表唯一用户数或成功安装数；旧客户端会忽略这个可选字段。

停用/卸载时 Cordis 服务注销、视图关闭、文件令牌失效、任务取消并清理进程。不同调用方访问同一服务时使用各自的进程实例，避免共享另一工具的文档状态。

## AI 对话调用插件（API 1.2 本地预览）

宿主「AI 对话」通过 Harness 发现已启用插件。所有插件支持确认后打开工具或设置；AI 批图还有可信宿主提供的批次工具。其他本地插件可在清单新增 `assistant.tools`，每个工具包含 `name`、`title`、`description`、`service`、`method` 和 `parameters`。`service` 必须已列入 `services.provides`，且有 backend。参数采用受限 JSON Schema：object/array/string/integer/number/boolean、properties/required、enum 与长度/数值范围；对象必须 `additionalProperties: false`，不接收密钥、密码、令牌或文件路径。最多 16 个工具；保留名称不能覆盖。

例如服务 `local.echo` 可声明 `echo` 方法，参数 `{ "type": "object", "properties": { "text": { "type": "string", "maxLength": 100 } }, "required": ["text"], "additionalProperties": false }`。只有用户确认该插件与参数后，宿主才在独立 OS 沙箱调用 backend。返回值也会发给文本模型，不应包含凭据或其他插件的私有数据。不要用工具描述请求 AI 绕过确认。调用取消或超时不表示所有外部副作用都已回滚。

上游 UI 复用范围、安全边界和版本升级契约见 [Harness 适配文档](harness-integration.md)。当前只打包本地预览，不发布 SDK 或插件市场更新。
