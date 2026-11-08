# Plugin SDK 1.13.0

- 移除 `ai.assistant.send/status/cancel`、`AssistantStatus` 与 `AIEvent` 的 assistant 变体。
- 文本能力继续通过 `ai.textModels()` 与 `ai.complete()` 提供；图像批次继续通过 `ai.models()` 与 `ai.batch.*` 提供。
- 清单中的 `permissions.ai: ['assistant']` 与 `assistant.tools` 仍会被解析，用于兼容已安装插件，但宿主不再展示工具目录或提供调用入口。
- 运行时插件 API 升级至 1.13.0，继续兼容声明更早 API 范围的旧插件。
