# Harness 内核与 AI 能力边界

轻作只使用 DeepSeek Harness 的 Profile/Bundle 启动能力，不加载 Agent 循环、对话会话、工具执行器或上游界面。当前固定 `@deepseek-ai/dsh-app-boot@0.2.2-alpha.2`，Cordis 兄弟包按各自版本固定；完整 `@deepseek-ai/dsh` CLI 元包不会进入依赖树。

`desktop/kernel.mjs` 通过 `desktop/kernel-boot.mjs` 调用公开的 `boot`、`createRuntimeResolution`、`readProfilePatches`、`PluginPackages` 与 `installFailLoud` 组合 commerce-desktop Profile。根配置始终重写为空入口列表，patch 由 Profile bundle、profile `cordis.patch.yml` 与 home patch 组合；`profileContext`、插件包解析、fail-loud 和 SIGTERM=0 / SIGINT=130 / 5 秒强退语义与上游启动器一致。

内核不提供 `cmdlineArgs`、`appExit`、`appReady` 或环境代理。当前装载的七个系统服务没有这些消费方；如果以后引入上游 Web、终端或命令行类插件，需要先补回对应契约并重新验证退出与代理行为。

## AI 能力

- 文本：插件申请 `permissions.ai: ['text']` 后，通过 `ai.textModels()` 读取目录，并用 `ai.complete({ model?, messages })` 调用主进程托管的 OpenAI 兼容 `/v1/chat/completions`。密钥不出主进程，请求与响应大小受限。
- 图像：`ai.models()`、`ai.batch.*` 由主进程图像运行时与批图运行时管理；批次启动仍需用户确认、费用提示和输出目录授权，失败或未知结果不会自动重试。
- 不提供工作台对话、共享助手、`ai.assistant.*`、Agent 工具调用、审批卡或会话 JSONL。插件如需多轮交互，自行维护消息历史并通过 `ai.complete()` 发送。
- `official.ai-assistant` 插件的设置页仍可通过第一方 `firstParty.assistant.settings` 桥管理代理与共享图像服务；`firstParty.assistant.chat` 已移除。

## 升级与验证

版本来源集中在 `desktop/upstream/harness.json`。升级候选仍按 [整组升级流程](harness-upgrades.md) 准备和验证，重点检查 app-boot 的公开导出、Profile 组合与插件包解析；真实 Electron 应用流程另跑 `npm run test:desktop`：

```sh
npm run build
npm run test:harness-contract
npm test
npm run test:platform
npm run test:desktop
```

候选目录只使用本地 HTTP fixture 与合成数据，不访问生产凭据，也不发起付费生成。`npm run upstream:check` 同时阻止完整 CLI 元包被重新加入依赖或 platform-bundle。
