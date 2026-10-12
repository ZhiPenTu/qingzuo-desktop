# CLIProxyAPI 上游版本更新

版本、官方仓库、支持平台和 SHA-256 固定在 `desktop/upstream/cli-proxy.json`。运行时版本显示和构建下载共用这份文件。当前支持 macOS arm64、Windows x64；更新不会自动替换正在运行的程序。

## 检查与准备

```sh
# CI 的离线检查：固定清单及实际运行时版本必须一致。
node scripts/update-cli-proxy.mjs --validate-pin --report .cache/upstream/cli-proxy-pin-report.json

# 查询官方最新稳定发布，只下载发布信息和 checksums.txt。
node scripts/update-cli-proxy.mjs --check

# 指定候选版本；同时下载、校验两个平台的官方制品。
node scripts/update-cli-proxy.mjs --prepare --version 8.0.23
```

不指定 `--version` 时查询 GitHub 官方 `latest`。草稿、预发布、版本标签不匹配、平台制品缺失、下载地址不属于官方发布以及缺失/重复校验值都会使流程失败。同一固定版本的官方校验信息改变时，流程要求先调查，避免静默接受重新发布的制品。

`--prepare` 在两个平台的制品都通过 SHA-256 校验后生成：

- `.cache/upstream/cli-proxy-candidate.json`：供验证和代码审查使用的候选清单。
- `.cache/upstream/cli-proxy-report.json`：固定版本、候选版本、发布链接、逐平台校验结果以及兼容性验证状态。
- `.cache/cli-proxy/`：已经校验的下载缓存。构建时仍再次验证缓存，损坏的缓存会使构建失败。

`--candidate PATH` 和 `--report PATH` 可指定输出位置。`--check` 不下载程序，也不写入候选清单；`--prepare` 不修改固定版本。

## 验证和采用候选版本

在 macOS arm64 和 Windows x64 上对同一候选清单运行 `scripts/validate-cli-proxy.mjs`，检查程序启动、模型发现、账户管理接口以及代理适配契约：

```sh
# macOS arm64
node scripts/validate-cli-proxy.mjs --manifest .cache/upstream/cli-proxy-candidate.json --report .cache/upstream/cli-proxy-smoke-macOS.json

# Windows x64
node scripts/validate-cli-proxy.mjs --manifest .cache/upstream/cli-proxy-candidate.json --report .cache/upstream/cli-proxy-smoke-Windows.json

# 收集两个平台的报告后汇总；缺少任一平台或制品哈希不一致均失败。
node scripts/validate-cli-proxy.mjs --manifest .cache/upstream/cli-proxy-candidate.json --combine .cache/upstream/cli-proxy-smoke-macOS.json .cache/upstream/cli-proxy-smoke-Windows.json --report .cache/upstream/cli-proxy-validation.json
```

`.github/workflows/upstream.yml` 的手动运行入口支持选择 `cli-proxy` 和指定版本，自动完成上述两个平台验证及报告汇总。汇总结果通过后，采用命令为：

```sh
node scripts/update-cli-proxy.mjs --apply --version 8.0.23 --validation-report .cache/upstream/cli-proxy-validation.json
```

`--apply` 会重新读取官方发布信息并校验两个平台的制品。兼容性报告必须包含同一版本、同一制品哈希以及全部通过的检查，然后才会原子更新固定清单。自动监测使用 `--check` / `--prepare`，固定版本变更通过代码审查和正常应用发布分发。

汇总后的兼容性报告格式如下；逐平台验证工具生成对应平台的结果，汇总流程补齐两项平台检查：

```json
{
  "schemaVersion": 1,
  "component": "CLIProxyAPI",
  "version": "8.0.23",
  "artifacts": {
    "darwin-arm64": "<candidate darwin-arm64 SHA-256>",
    "win32-x64": "<candidate win32-x64 SHA-256>"
  },
  "checks": {
    "proxyContracts": "passed",
    "darwin-arm64": "passed",
    "win32-x64": "passed"
  }
}
```

此外，在正式发布前运行 `test:desktop` 验证开发目录中的 Electron 应用；完成打包后执行 `node scripts/test-packaged-desktop.mjs`，验证独立应用的资源路径和启动。平台签名按发布流程单独检查。上游新增提供商、管理端点和消息格式仍需在轻作适配层和对应契约测试中逐项接入。

## 应用内检查与运行时更新

设置页的“检查 CLIProxyAPI 更新”只读取官方稳定 Release 清单，并显示当前版本、候选版本
和兼容性状态。它不会覆盖安装包 `Resources/commerce` 中的文件。用户态更新器使用
`userData/ai-proxy/versions/<version>` 和原子 `active.json` 指针，下载后校验制品哈希，停止
当前代理，启动候选并通过 `/v1/models` 健康检查；启动失败时恢复旧指针和旧二进制。

运行时完整性校验不等于项目兼容性验收。只有受信任的双平台 smoke、代理契约和安装包验收报告
通过后，候选才会被标记为 `compatibility=passed` 并允许显示“立即更新”。当前应用没有已发布的
候选验收报告，因此设置页只显示检查按钮；`cliProxy.update` 保留为后台任务接口并拒绝未验收候选。
外部 CLIProxyAPI 配置不受此更新器影响，配置、账户和 OAuth 凭据也不会被删除；切换版本后需
重新验证已选模型的工具调用能力。
