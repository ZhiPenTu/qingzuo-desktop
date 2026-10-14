# 轻作官网（GitHub Pages）

`site/` 是轻作的官方介绍与下载页，静态文件，无构建步骤，由 `.github/workflows/pages.yml` 发布到 GitHub Pages。

```
site/
├── index.html          页面结构与文案
├── assets/styles.css   配色与排版（与桌面端设计令牌一致）
├── assets/site.js      外观切换 + 最新版本直链解析 + 插件市场目录
├── assets/*.png        应用图标与工作台插画（复制自 src/assets）
└── .nojekyll           避免 Pages 走 Jekyll 处理
```

## 插件市场目录

页面上的插件列表不是写死的，`assets/site.js` 在运行时读取官方市场仓库的目录：

```
https://raw.githubusercontent.com/ZhiPenTu/qingzuo-market/main/catalog.json
```

这与桌面端插件市场使用的地址相同（见 `scripts/prepare-platform.mjs` 的 `COMMERCE_MARKET_URL` 默认值），因此**市场上架新插件后，官网自动出现该插件，无需改动任何代码**。市场流程是「合并目录即上架」，不依赖底座安装包重发。

目录字段到页面元素的映射：

| `catalog.json` 字段 | 页面显示 |
| --- | --- |
| `title` | 卡片标题与图标文字（中文标题改用 `id` 词首字母，避免多个插件标记相同） |
| `version` | 标题右侧版本徽标 |
| `category` | 副标题，同时用于顶部分类筛选按钮 |
| `description` | 卡片正文 |
| `artifacts` 的键 | 平台徽标（`darwin-arm64` → macOS，`win32-x64` → Windows） |
| `artifacts[*].url` | 反推出插件仓库地址，作为卡片链接 |

`api` 与 `releaseNotes` 只用于开发排查，刻意不出现在界面上。

卡片上的仓库链接是从安装包 URL 反推的（`https://github.com/<owner>/<repo>/releases/...`），目录里没有显式的仓库字段。

容错：目录同样缓存 30 分钟；有缓存但网络失败时继续展示缓存并提示；无缓存且网络失败时保留 `index.html` 里静态兜底的三张卡片并给出提示，同时隐藏统计数字。

界面只呈现用户需要的信息。目录同步成功时不显示任何状态提示，只有加载失败才提示；下载版本同理，正常时按钮下方只显示版本号、体积与日期，出错才引导到 Releases。

## 下载按钮如何做到「点击即下载」

GitHub Release 的资源文件名带版本号（`CommerceTools-<version>-mac-arm64.dmg`），静态页面无法预知下一个版本号，因此 `assets/site.js` 在运行时请求：

```
https://api.github.com/repos/ZhiPenTu/qingzuo-desktop/releases/latest
```

然后按文件名匹配当前平台的安装包，把按钮的 `href` 指向该资源的 `browser_download_url`：

- macOS：`-mac-arm64.dmg$` → `CommerceTools-<version>-mac-arm64.dmg`
- Windows：`-win-x64.exe$` → `CommerceTools-<version>-win-x64.exe`

因此访客点击按钮会直接下载最新版本安装包，而不是跳到发布页面。

容错行为：

| 场景 | 行为 |
| --- | --- |
| 正常 | 按钮指向最新安装包，并显示版本号、体积与发布日期 |
| 30 分钟内重复访问 | 使用 `localStorage` 缓存结果，避免触发 GitHub API 限流 |
| 有缓存但网络失败 | 继续使用缓存直链，状态提示「离线缓存」 |
| 无缓存且网络失败 | 按钮退回 `releases` 页面，状态区提示手动下载 |

未登录用户调用 GitHub API 有 60 次/小时限制，缓存与「取不到就退回发布页」的策略就是为了避免在这种限制下失效。

## 本地预览

```bash
python3 -m http.server 4177 --bind 127.0.0.1 --directory site
# 打开 http://127.0.0.1:4177/
```

## 发布

1. 仓库 Settings → Pages → Build and deployment → Source 选择 **GitHub Actions**（只需设置一次）。
2. 推送 `main` 分支上 `site/**` 的改动，工作流 `Deploy official site to Pages` 会自动发布。
3. 也可以在 Actions 页面手动触发 `workflow_dispatch`。

发布后地址为 `https://<owner>.github.io/qingzuo-desktop/`，工作流输出 `page_url` 会给出实际链接。
