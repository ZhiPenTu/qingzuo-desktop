# CLIProxyAPI 批图本地预览验收

2026-10-11，轻作 0.3.0、SDK 1.2.0、AI 批图 0.1.0 本地候选；不发布、不提交、不推送、不打标签。

## 接口契约

依据 CLIProxyAPI 固定 v8.0.23 的一手源码验证路由和目录元数据：

- [图像编辑处理器](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.23/sdk/api/handlers/openai/openai_images_handlers.go)：`/v1/images/edits`、单张 multipart 原图、`n=1`、`response_format=b64_json`。兼容别名须在代理配置中声明 `image: true`，目录类型为 `openai-image`。
- [路由](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.23/internal/api/server_routes.go)：Gemini 原生图像请求使用 `/v1beta/models/{id}:generateContent`。由宿主使用共享 Bearer 访问密钥，非 Google 官方 Key。
- [模型目录](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.23/internal/registry/model_registry.go)：保留 `type`、`version`、`display_name` 用于区分型号与兼容别名。未知参数能力不展示推测选项，缺失型号不回退。

共享凭据仅在宿主取用，插件通用网络接口仍拒绝本机地址。所有批次和目录按插件身份校验；批次持久化来源与可信模型快照，但不持久化访问密钥。地址/模式变化时阻止旧批次重新投递，已有生成结果仍可重新保存。无 source 的旧 SDK 调用仍为官方 API。

## 自动化结果

- 前端 19 项、平台 87 项、Electron 8 项、独立插件 4 项全部通过，共 118 项。
- 新增代理目录、别名、鉴权、原图上传、两种响应解析、400/401/403/404/429/500、无图和 URL-only 响应、取消、未知型号/参数、来源变化、重启恢复与跨插件隔离契约。
- `npm run build`、`git diff --check` 通过。上游 Harness 发布包缺少 source map 和既有构建 chunk 大小提示仍为非阻塞警告。
- 使用源码目录外的真实 macOS arm64 app 执行插件黄金路径：11 张固定响应结果保存成功，覆盖两家官方接口、代理 Gemini/GPT Image、兼容别名、无需官方 Key、刷新保留队列、确认隔离、草稿来源冻结、默认文本助手不变。插件页面无 JavaScript 异常。
- app 深度签名验证、DMG 完整性校验、SDK/插件/DMG SHA-256 校验通过。

## 真实本地配置

通过原启动器更新 `/Users/tuzhipeng/Documents/Qingzuo-0.3.0-preview`，保留其 `profile`，不覆盖 `/Applications/Qingzuo.app`。更新前后 `profile/ai-proxy/settings.json` SHA-256 完全相同。

原有 CLIProxyAPI 实际目录已显示 5 个 GPT Image 型号：`gpt-image-1.5`、`gpt-image-2.5-sunburst`、`gpt-image-2.5`、`gpt-image-2`、`gpt-image-2.5-flare`。插件默认选中已发现的 Sunburst；文本默认助手仍由原配置管理，没有更换。截图保存为预览目录中的 `CLIProxyAPI真实图片模型.png`。

真实连接仅读取型号目录，没有调用付费图片编辑或助手对话。真实图片效果、账户额度/编辑权限、代理上游重试策略及 Windows 安装包尚未验收。

人工导入时既有内核 RPC 的 30 秒限制可能在等待系统选择/确认对话框期间触发超时提示；插件实际安装成功，重新打开工具后已展示新版本界面。该通用交互超时问题未纳入本轮代理图像接口修改。
