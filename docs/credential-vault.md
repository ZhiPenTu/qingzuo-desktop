# 共享凭证库

共享凭证库用于保存多组第三方应用凭证，并让已获授权的插件在宿主进程内使用密钥。它面向 `AppID + APP_SecretKey` 这类“应用身份”凭证，不替代插件自己的普通设置或文件存储。

本期只支持手工创建和替换凭证；不提供旧明文导入、备份恢复、跨 profile 共享、密钥导出或密钥轮换。记录和授权只属于当前轻作用户目录。

## 记录模型

一条记录包含：

```ts
{
  id: string;                 // rec-<12 位小写十六进制>
  label: string;              // 1–64 字符，忽略大小写唯一
  appId: string;              // 1–256 个可打印字符
  environment: 'production' | 'sandbox';
  createdAt: number;          // Unix 毫秒
  updatedAt: number;          // Unix 毫秒
  hasSecret: boolean;
}
```

`list()` 还可以附带 `grants` 数量，供管理界面展示使用方总数。记录没有备注字段。

### 字段分类

- `appId` 是公开标识。管理插件可以读取全部记录的完整 AppID；消费插件只能读取已授权记录的完整 AppID。`browse()` 始终只返回掩码。
- `secretKey` 是机密字段。它只能在宿主进程内解密，只用于 `network.request` 注入或 `network.sign` 计算。任何 SDK 返回值、IPC 响应、日志、错误文案和页面状态都不得包含明文。
- 记录别名、环境和时间属于元数据，可以返回给有对应读取权限的插件。

## 权限与来源

清单增加：

```json
{
  "permissions": {
    "credentialVault": "use"
  }
}
```

取值只有 `use` 和 `manage`：

- `use`：可以浏览掩码候选，请求授权，读取自己已获授权的记录，并撤销自己的授权。任何来源的插件都可以申请。
- `manage`：可以创建、编辑、删除记录，查看全部记录与使用方，并撤销任意授权。只有 `source === 'market'` 或 `source === 'bundled'` 的插件可以实际管理。
- 本地导入但未签名的 `manage` 插件仍可安装，也可以按 `use` 的规则浏览和请求自己的授权；调用 `create / update / remove / grants / revokeGrant` 时返回“请从工具市场安装后使用凭证管理。”
- 授权申请必须由当前可见的插件发起。后台调用、隐藏页面或别的插件代发都会返回“请在插件界面中完成凭证授权。”

## SDK

API / SDK 1.7.0 增加 `client.credentials.records`：

| 方法 | `use` | `manage` | 返回 |
| --- | --- | --- | --- |
| `list()` | 只返回已授权记录 | 返回全部记录 | `CredentialRecord[]` |
| `browse()` | 返回全部候选的掩码 | 同左 | `{ id, label, environment, appIdMasked, granted }[]` |
| `request(id)` | 首次请求会弹宿主确认，授权长期有效 | 同左 | `{ id, label, appId, environment }` |
| `revoke(id)` | 撤销自己的授权 | 撤销自己的授权 | `void` |
| `create(input)` | 拒绝 | 新建 | `CredentialRecord` |
| `update(id, patch)` | 拒绝 | 修改；密钥只能整体替换 | `CredentialRecord` |
| `remove(id)` | 拒绝 | 删除记录、密钥和全部授权 | `void` |
| `grants(id)` | 拒绝 | 查看使用方 | `{ pluginId, title, confirmedAt }[]` |
| `revokeGrant(id, pluginId)` | 拒绝 | 撤销指定插件授权 | `void` |

新增记录的 `secretKey` 必填。更新时 `secretKey` 省略或留空表示保留原密钥；传入非空值会整体替换。编辑接口永远不会返回原密钥。

`network.request` 和 `network.sign` 的 `credential` 字段支持：

```js
credential: 'plugin-private-credential-name'
credential: { record: 'rec-abcdef123456' }
```

字符串形式继续使用插件自己的私密凭据。对象形式必须同时满足：

1. 插件声明 `credentialVault: 'use'` 或 `'manage'`；
2. 记录仍然存在；
3. 该插件已获得这条记录的显式授权；
4. 密钥仍可读取。

未授权、记录已删除、密钥缺失或解密失败分别返回可操作错误，不会回退到其他记录或明文凭据。

## 授权生命周期

1. 插件调用 `browse()`，页面只显示别名、环境、掩码 AppID 和是否已授权。
2. 用户选择记录后，插件调用 `request(id)`。
3. 宿主串行弹出确认框，显示插件标题、记录别名、完整 AppID 和环境。
4. 用户允许后写入长期授权；再次 `request(id)` 不会重复弹框。
5. 插件或用户可以在凭证管理插件中撤销授权。
6. 消费方被卸载时，宿主清除它的全部共享凭证授权。
7. 删除记录时，记录元数据、密钥和全部授权一起删除。

授权按“插件 + 记录”组合保存。一条记录最多授权给 64 个插件；同一插件可以授权多条记录。

## 存储与加密

记录索引位于 `userData/credential-records.json`：

```json
{
  "schemaVersion": 1,
  "records": [],
  "grants": {
    "official.example": {
      "rec-abcdef123456": 1760000000000
    }
  }
}
```

- 索引使用原子写：同目录临时文件写完后再重命名；非 Windows 平台强制 `0600`。
- 索引不保存密钥。索引损坏时先重命名为 `.corrupt-<时间戳>` 备份，再从空库重建。
- 密钥交给现有凭据存储，归属 `vault` 命名空间，名称为 `record-<id>`。
- 所有 `Credentials.set` 写入统一加 `enc:v1:` 信封，由 Electron `safeStorage` 加密；macOS 使用 Keychain，Windows 使用 DPAPI。
- 读取时只接受 `enc:v1:` 信封。解密失败返回“无法读取已保存的密钥，请重新填写。”；不带信封的旧明文视为未配置。
- 开发构建、应用身份变化或系统钥匙串状态变化时，macOS 可能重新询问钥匙串授权。这是确保密钥真实加密落盘所接受的代价。

## 限额与校验

- 最多 64 条记录。
- 别名 1–64 字符，忽略大小写唯一，不能包含控制字符。
- AppID 1–256 个可打印字符，不能包含控制字符。
- 密钥 1–1024 字符，不能包含 NUL、回车或换行。
- 每条记录最多 64 个插件授权。
- 接口参数只接受约定字段；未知管理动作直接失败。

## 旧数据

升级到 API 1.7 后，旧版明文凭据不再被视为已配置。启动时宿主会清理已知旧键：

- `system.ai:external`
- `system.ai:google-image`
- `system.ai:openai-image`
- 已安装插件清单中 `permissions.credentials` 声明的凭据名

用户需要重新填写 AI、抠图、Seedance、希音等工具里已保存的密钥。清理失败只记录不含密钥的告警，不会把明文继续交给插件使用。

## 日志与错误

- 允许记录：操作类型、插件 ID、记录 ID、是否成功。
- 禁止记录：`secretKey`、完整请求头、签名原文、解密后的店铺密钥。
- 用户错误优先说明下一步，例如“请重新填写”“请重新选择”“请先授权”。
- 宿主不自动重试失败的密钥读取或网络请求，避免在凭据状态未知时重复产生副作用。

## 示例

管理插件：

```js
const record = await client.credentials.records.create({
  label: '希音正式店铺',
  appId: 'APP-123456',
  environment: 'production',
  secretKey: userInput,
});
```

消费插件：

```js
const candidates = await client.credentials.records.browse();
const access = await client.credentials.records.request(candidates[0].id);

const signed = await client.network.sign({
  credential: { record: access.id },
  algorithm: 'hmac-sha256',
  message,
  keySuffix,
});
```

插件页面只拿到 `access` 中的公开字段和 `signed.digest`；密钥始终留在主进程。
