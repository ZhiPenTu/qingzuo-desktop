# Plugin SDK 1.12.0

- 运行时插件 API 升级至 1.12.0，继续兼容声明更早 API 范围的旧插件。
- `wechat.createDraft` 新增显式图片消息输入：`article.type: 'image'` 与 1–20 张 `images`，第一张作为封面。
- 图片消息逐张上传 PNG/JPEG 永久素材，并使用 `article_type: 'newspic'`、`image_info.image_list` 创建草稿；标题最多 32 字。
- 省略 `article.type` 时仍创建普通图文，原有字段、`material/add_material` 封面与 `media/uploadimg` 正文图片流程不变。
- 新增 `WechatImageArticleInput` 类型；`WechatArticleInput` 保持对既有图文调用的兼容。

需要轻作桌面版本支持插件 API 1.12.0。现有插件接口保持兼容；使用图片消息草稿的插件必须声明 `api: "^1.12.0"`。
