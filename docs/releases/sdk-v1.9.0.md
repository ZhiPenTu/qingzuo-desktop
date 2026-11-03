# Plugin SDK 1.9.0

- 运行时 API 1.9.0。
- 新增宿主托管持久工作区 `client.workspace`：固定四个根目录、真实路径与 inode 校验、原子写入、敏感文件与符号链接拒绝、不透明文件 URL，以及 `.aws` 预设包预览和导入。
- 新增远程 MCP `client.mcp`：Streamable HTTP、静态 Bearer/API Key、OAuth 2.1 + PKCE、逐工具只读授权、SSRF 与重定向防护、超时和响应上限。
- 新增公众号发布 `client.wechat`：掩码账号、连接验证、草稿、发布、状态和列表；AppSecret 保存在系统凭据库，access token 只在主进程内存中。
- `ai.complete` 新增 `maxTokens` 和 `finishReason`；`ai.batch.start` 新增 `workspacePath`，与 `directoryToken` 互斥，并在生成前显示原生确认。
- 新增清单权限 `workspace`、`mcp: ['read']` 和 `wechat: ['draft', 'publish', 'list']`。旧插件与原有调用方式保持兼容。
