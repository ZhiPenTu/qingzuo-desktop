# Harness 对话适配与升级契约

轻作不实现第二套 Agent 循环，也不复制 DeepSeek Harness UI 源码。首版统一固定 `0.2.1-alpha.1` 包族，通过公开 `agents.create/resume`、`agent.followup/cancel/whenIdle`、`tools.register`、`llm.registerAdapter` 与 JSONL 会话持久化服务运行。`desktop/ai-harness.mjs` 是唯一 Agent 适配层；插件不导入 Harness 类型。

## 对话界面的上游复用

`src/platform/HarnessPresentation.tsx` 直接导入官方 `@deepseek-ai/dsh-client-ui-primitives` 根导出的 `MarkdownText`、`TextShimmer` 和 `JsonTree`。流式 Markdown 增量解析、代码块、GFM、数学公式、安全 HTML/协议处理、工具参数树与活动动画由上游维护。轻作只通过 CSS 变量映射主题与传入中文标签，不修改 `node_modules`、不导入 `lib/`、`src/` 等内部路径。

上游完整 Chat/Conversation 是 Cordis 客户端插件，需要其远程会话控制器、工作区和完整 Web 服务，不是一个可直接嵌入现有 shell 的 React 组件。本版没有打开它们的任意文件、终端、动态插件或 Web 管理接口。会话列表、输入区、插件确认卡是轻作薄壳；这不是完整上游 Chat UI，后续可在公开客户端契约通过权限审计后替换薄壳。前端懒加载，不影响普通工具页启动。

薄壳采用单栏对话工作区：历史和插件能力按需打开抽屉，正文独立滚动，输入区固定在底部。布局变化不改变 Harness 消息、会话持久化与工具审批契约，候选升级仍执行同一组兼容测试。

## 插件调用边界

- 工作台对话与每插件批图助手分开，宿主 ID 不可由插件 IPC 获取；工作台会话可新建、切换和恢复。
- `list_plugins` 只返回已启用且依赖齐全的插件与声明工具。描述和输出是非可信数据，不是指令。
- `call_plugin` 的插件、参数和版本在确认前冻结；每次调用都需用户确认。拒绝、取消、停用、卸载、版本变化和重复确认不会触发调用。等待最长十分钟；重启不恢复旧授权。
- 所有插件可打开主界面或配置页；AI 批图另提供批次查询、逐图提示词修改、启动与停止。启动卡展示图片数、型号、参数和逐图提示词，再由原生对话框授予输出目录。不自动导入用户文件、重试图像请求或覆盖原图。
- 其他插件通过 SDK `assistant.tools` 声明 backend 方法、已提供的 service 和严格 JSON Schema；没有声明的服务方法、密钥、文件路径和令牌不可作为工具参数。宿主复查身份后，使用现有 OS 沙箱为对话单独创建调用方进程，不把第三方代码载入 Harness。
- 停止对话只撤销未执行的调用并停止正在调用的专属 worker；已确认启动的批图由宿主管理，需通过停止批次工具或插件按钮另外取消。已产生的外部副作用无法回滚；未知结果不能自动重发。
- 原始 Harness JSONL 是引擎恢复日志；`sessions.json` 只保存薄壳展示和会话索引。界面删除列表记录不清除 JSONL 审计日志。

## 跟随上游升级

不要使用浮动 `latest`、运行时下载 UI 或自动迁移会话。一起更新直接依赖包族和 lockfile，检查公共 UI 导出及依赖，生成第三方声明，然后执行：

```sh
npm run build
npm run test:harness-contract
npm test
npm run test:platform
npm run test:desktop
```

候选版本还需用旧 JSONL 会话验证继续对话、取消、工具调用、未确认请求中断恢复和跨插件隔离；先备份 `harness/ai`、`harness/ai-session-logs`、`ai-batches` 与代理配置，再做迁移和安装包验收。升级失败保留旧固定版本及备份。绝不让候选测试访问生产凭据或发起付费生成。

版本来源集中在 `desktop/upstream/harness.json`。`npm run upstream:check` 检查整个直接包族、嵌套包版本、Cordis 依赖范围、平台 Bundle peer、lockfile SRI，以及已审阅的原生加载器与 Electron 组合。`check-upstream` 根据当前 `alpha` 通道查询候选版本，不能用较旧的 `latest` 标签替代当前版本。

`npm run upstream:harness -- prepare --version VERSION --directory output/upstream/harness-candidate` 在独立目录生成包族、Bundle、版本元数据和 lockfile；`validate --directory ...` 安装候选依赖，检查公开接口、Node/Electron 原生加载器、UI 构建与真实 Harness 会话和工具契约。验证使用本地 HTTP 模型响应及已脱敏的旧 JSONL，会话和凭据与实际用户环境分开。完整命令及安装包验收边界见 [整组升级流程](harness-upgrades.md)。

代理适配层现支持按事件解析分片 SSE、推理内容回传、Token 用量、停止词与生成参数，以及区分正常结束、长度上限、过滤、请求失败和取消。长度上限不会执行截断工具调用。图像消息需要接入 Harness 的公开附件服务后才能支持，当前输入仍为文字。
