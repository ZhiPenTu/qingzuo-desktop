# 轻作插件 SDK sdk-v1.3.0

- 运行时 API 1.3.0。
- 新增 `browser.open / snapshot / act / waitFor / saveResource`，快照只返回结构化节点、可见性和位置，不返回页面标记、Cookie、隐藏输入与密码字段。
- 新增 `network.sign`（`hmac-sha256` 与 `sha256`）和 `network.request` 的 `headers`；密钥留在主进程，请求头必须在清单中声明。
- 新增 `storage.get / set / keys / remove / saveFile / readFile / removeFile`，按插件隔离并有配额。
- 清单新增 `permissions.browserOrigins`、`permissions.networkHeaders`、`permissions.storage`，`permissions.browser` 增加 `automate`。
- 此 Release 设置 latest=false，不影响桌面升级；独立插件用固定 URL 与 lockfile integrity 安装。
