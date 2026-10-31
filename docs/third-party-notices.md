# 第三方声明

本项目使用 MIT 许可。DeepSeek Harness 由 DeepSeek 提供，使用 MIT 许可；底座直接依赖官方发布的 `@deepseek-ai/dsh@0.2.2-alpha.2` 及其完整锁定依赖树。分发包包含 `DeepSeek-Harness-LICENSE` 原文和 `THIRD_PARTY_NOTICES.json` 中的生产 Node 依赖及随包许可文本。

Electron / Chromium / Node 的许可随 Electron 框架分发。LabelEdit 的 PDFium、pypdf、ReportLab、RapidOCR、ONNX Runtime、OpenCV、Python、模型和字体不随底座分发，由独立插件仓库维护第三方许可与资源来源。remove.bg 是第三方在线服务，由独立抠图插件和用户账户按其服务条款使用。

构建时由 `scripts/generate-notices.mjs` 生成安装依赖的许可清单，正式发布时应检查新增依赖的声明是否齐全。许可声明不表示第三方为本项目背书。

Harness 的原生加载适配器固定为官方 `node-addon-require-builtin@0.1.9`，macOS 构建使用 [上游源码提交 a58d359](https://github.com/deepseek-ai/dsh-node-addon-require-builtin/commit/a58d3599a2e551d7d706d1ff796c9fd4bbaff63c)，不修改原生源码。其 MIT 许可随包保存在 `Harness-native-adapter-LICENSE`。
