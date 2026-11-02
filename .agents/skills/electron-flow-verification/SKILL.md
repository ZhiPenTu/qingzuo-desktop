---
name: electron-flow-verification
description: 用于选择并执行轻作的 Vite、Electron、Playwright、平台契约、Harness 和 Rust 沙箱验证；在改动后需要实际测试、复现问题或收集证据时使用。
---

# Electron 与平台验证

目标是给出可复查的验证结论，而不是只报告命令退出码。

## 选择测试矩阵

| 改动范围 | 首选检查 |
| --- | --- |
| 纯文案、说明或仓库配置 | `npm run build`，必要时 `npm test` |
| React 渲染进程 | `npm test`、`npm run build` |
| 平台服务、权限、插件契约 | `npm run test:platform` |
| Harness 适配或 AI 契约 | `npm run test:harness-contract` |
| Rust 沙箱 | `npm run test:sandbox` |
| 真实 Electron 页面或流程 | `npm run test:desktop` |
| 打包、签名或安装 | `npm run build:desktop`，再按平台运行对应验收脚本 |

## 执行规则

1. 先读 `AGENTS.md`、`package.json`、相关测试和当前 diff，确认测试是否真的覆盖改动。
2. 先运行最接近改动的测试，再扩展到构建或平台契约；不要一开始就运行全部重型流程。
3. 记录实际命令、通过数、失败原文和跳过原因。禁止把未执行或环境不满足写成通过。
4. 真实 Electron 行为必须用 Playwright 或实际桌面启动验证；Vite 页面、浏览器截图和静态检查不能替代 Electron 结果。
5. 测试失败时先判断是否由本次改动、现有环境或无关缺陷造成；只修复与本次改动相关的问题。
6. 测试产物只写入 `output/`、`test-results/` 等被忽略目录；不要把生成物加入提交。

## 证据

- 需要浏览器截图、控制台或网络证据时，使用项目内 Playwright 和本地 Vite/Electron 页面，产物写入被忽略目录。
- 明确标注证据覆盖的是 Vite 页面、真实 Electron 页面还是静态代码判断。
- 公开上游资料用 `$mcp-evidence`（`magpie`）；`magpie` 不可用时记录降级，不用它替代本地测试。

## 输出

- 测试矩阵和执行命令。
- 通过数、失败原因、未执行项和环境限制。
- 证据路径、剩余风险和需要人工验收的部分。
