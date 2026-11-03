# Plugin SDK 1.10.0

- 运行时插件 API 升级至 1.10.0，继续兼容声明更早 API 范围的插件。
- 新增三档信任层 `platform / official / community`，市场注册表升级为 schema v2，目录保持 schema v1 并显式提供 `tier` 与兼容投影 `official`。
- 新增 `official.ai-assistant` 与 `official.diagnostics` 的宿主内部 `firstParty.*` 受控桥；公开 `createPluginClient()` 不提供这些能力。
- 新增 `PluginBridge.onDebugLog` 类型与带游标的脱敏日志批次类型，仅用于精确授权的第一方诊断插件。
- 市场验证器固定到本 Release 的 SDK 压缩包。此 Release 设置 `latest=false`，不影响桌面版本升级。

需要轻作桌面版本支持插件 API 1.10.0。现有插件接口保持兼容；插件更新时必须重新核对其 `api` 范围。
