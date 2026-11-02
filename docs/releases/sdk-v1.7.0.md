# 轻作插件 SDK sdk-v1.7.0

- 运行时 API 1.7.0，新增 `credentials.records`：`list`、`browse`、`request`、`revoke`、`create`、`update`、`remove`、`grants`、`revokeGrant`。
- 清单新增 `permissions.credentialVault: 'use' | 'manage'`；管理能力只对市场或内置来源开放。
- `network.request` 与 `network.sign` 的 `credential` 支持 `{ record: id }`，字符串形式的插件私密凭据继续兼容。
- 共享凭证的 `secretKey` 永不返回插件；记录与授权保存在 `userData/credential-records.json`，密钥使用系统安全存储的 `enc:v1:` 信封。
- 旧版明文凭据升级后视为未配置，需要用户重新填写。完整规范见 `docs/credential-vault.md`。
