# dsh-wechat-push

DeepSeek Harness 插件：把 **HTML 正文与图片直接投递到微信公众号草稿箱**。

它可以与`dsh-wechat-html`（markdown → 微信可用 HTML）结合使用。两个插件互相独立：
本插件**不排版**——直接给它 HTML 文本或文件即可，所以不装排版插件也能用。

**它永远不群发**：草稿建好之后，仍然要人在公众平台后台点发送。

## 安装

克隆仓库后，在仓库根目录运行：

```bash
dsh plugin --profile web add file:.
```

本插件要求 Node.js 18 或更高版本。运行时还需要由 DeepSeek Harness 提供
`@deepseek-ai/dsh-tools` 和 `@deepseek-ai/dsh-typert-protocol` 两个宿主依赖。

## 凭据

**本插件不认识任何「默认凭据来源」。** 它不读进程环境变量、不读 `$DSH_HOME`、不读任何受管凭据库。
每次调用都必须由调用方把**凭据文件的路径**传进来：

```
mp_create_draft(credentials_path="D:\WeChat-Publishing\.env", ...)
mp_upload_image(credentials_path="D:\WeChat-Publishing\.env", path="...")
mp_list_drafts(credentials_path="D:\WeChat-Publishing\.env", count=3)
```

那个文件里要有两个名字（`.env` 的 `NAME=value`，或 `.credentials.yaml` 的 `refs:` 段，两种都认）：

| 名字 | 是什么 |
|---|---|
| `WECHAT_MP_APPID` | 公众号的 AppID |
| `WECHAT_MP_SECRET` | 公众号的 AppSecret |

**为什么传路径而不是传密钥**：DSH 的工具参数会进会话记录与事件日志（`dsh-tools` 没有敏感参数的概念）。
传路径则密钥只在插件进程内被读出使用，**永远不会离开进程**。

两个值都在 公众平台 → 设置与开发 → 基本配置。**AppSecret 只显示一次**；重新生成会让其它
系统手里的 token 立刻失效（报 `40125 invalid appsecret`）。

缺 `credentials_path`、读不到文件、或文件里缺变量，都会在**调用时**报出明确的错误——
工具本身**始终挂载**（不再因为「部署没配凭据」而整体消失）。

> 「发公众号」按钮不再可用：它的调用方是浏览器里的一次点击，既不该拿到密钥、也没有「路径」可传。
> 请改用 `mp_create_draft` 工具投递。

## 工具

### `mp_upload_image` —— 写

上传一张本地 jpg/png（**< 1MB**），返回正文里必须使用的 `mmbiz.qpic.cn` 地址。
微信会剥掉所有其它来源的图片，所以文章里每张本地图都要过这一步。

### `mp_create_draft` —— 写

从 HTML 建草稿。正文可以是文件（`html_path`）或直接是文本（`html`）——二选一。
HTML 通常来自 `mp_render`，但任何内联样式的 HTML 都可以。

| 参数 | 说明 |
|---|---|
| `html_path` / `html` | 二选一：正文文件，或正文 HTML 文本 |
| `title` | 必填，≤ 64 字符 |
| `cover` | 封面：`{media_id, path}`。优先直接引用 `media_id`，它为空时才上传 `path` |
| `cover_image` / `thumb_media_id` | 旧参数，分别等价于 `cover.path` / `cover.media_id`，为兼容已有调用保留 |
| `author` / `digest` / `source_url` | 可选；`source_url` 是「阅读原文」的链接 |
| `images` | 每张正文图一条：优先直接引用 `{token, url}`，url 为空时按 `{token, path}` 上传；两者都为空时跳过该图并继续。也可以用 `src` 代替 `token` |
| `missing_image_policy` | 缺少 url/path 时的策略：`warn`（默认）、`keep`、`remove` 或 `error` |
| `upload_local_images` | 额外扫描 HTML 里写成本地路径的 `img src` 并上传，默认 `false` |
| `base_dir` | 上面那种相对路径的基准目录，默认取 `html_path` 所在目录 |
| `submitted_path` | 只给 `html` 文本时，把提交后的正文另存一份的位置 |

**没有出现在 `images` 里的未解析占位 token 仍会被拒绝**；但如果调用方明确给了该图的
`images` 条目，只是没有 `url` 和 `path`，则保留 HTML 原状并继续创建草稿。封面仍是必需的：
已有 `cover.media_id` 时直接引用，
否则必须给出 `cover.path` 本地路径上传。两者同时给出时不会重复上传。

因为支持 `{token, path}`，一篇文章可以**一次调用**连图带正文全部上去：

```jsonc
{
  "html_path": "./content/article.html",
  "title": "示例文章",
  "cover": {
    "path": "./content/cover.png"
  },
  "images": [
    { "token": "dsh-mp-image-0", "path": "./content/image-01.png" }
  ]
}
```

给 `html_path` 时，提交后的正文会另存为 `<html_path>.submitted.html`——填完 token 之后它
和渲染出的文件就不再一样了。保存失败不会把已创建的草稿判成失败，但结果会返回明确警告。

### `mp_list_drafts` —— 只读

最近的草稿，新的在前。用来确认草稿真的落地了。

## 「发公众号」按钮（Web UI）

每条助手回复后面有一个 **发公众号** 按钮。一次点击就把那条回复排版（用配置的模板）
并放进草稿箱——不必先存成文件再让 agent 发布。

标题取消息的第一个标题行，或第一行正文，截到 64 字符。

按钮从 markdown 起步，所以它需要排版插件 `dsh-wechat-html`：装了就走
`ctx.get('wechatHtml')` 服务渲染；没装则明确告诉你缺什么，而不是静默失败。
按钮和工具共用同一套 API 代码，两条路不会走偏。

按钮**没有地方选封面**，所以必须先配好已有素材 ID 或本地路径：

```yaml
- id: wechat-push
  config:
    defaultCoverMediaId: '' # 有已上传素材时填它，优先使用
    defaultCover: './content/cover.png'
```

两者都没配的话，一次点击会告诉你该设哪个键。

消息里的外链图片会继续保留，但结果会警告它可能被微信过滤。正文图片、本地图片、封面、字段校验和
重复提交保护都与 `mp_create_draft` 共用同一条发布流程。

## 审批

写操作默认**不弹提示**。这里不会发布——草稿仍然需要人打开后台按发送——所以一次无人值守的
运行留下的是待删的草稿，而不是读者已经看到的推送。

想开提示：

```yaml
- id: wechat-push
  config:
    requireApproval: true
```

它们随后走 dsh 的审批缝（`tools/pre-execute`）并 **fail closed**：没有组合进审批通道时，
调用被拒而不是被悄悄放行。

开启审批后，「发公众号」按钮也不会绕过这条规则：按钮会拒绝写入并提示改用受审批保护的
`mp_create_draft` 工具。

当 agent 无人值守地跑在一个**永久素材配额**要紧的账号上时值得打开：删掉草稿并不会把封面
占掉的坑还回来。

## 配置

全部可选；写在 profile 的 `cordis.patch.yml` 里，按行 id `wechat-push` 改。
**这里没有凭据项**——密钥不在配置里，每个调用自带 `credentials_path`（见上文「凭据」）。

```yaml
- id: wechat-push
  config:
    tokenCacheDir: ''       # '' → 系统临时目录
    baseUrl: https://api.weixin.qq.com
    defaultAuthor: ''
    defaultCover: ''        # 「发公众号」按钮需要它
    defaultCoverMediaId: '' # 已有素材 ID；非空时按钮直接引用，不上传 defaultCover
    requireApproval: false
```

补丁层会整块替换某一行的 `config`，所以想保留的键都要写全。

## 已知坑

### IP 白名单（errcode 40164）

每次 API 调用都必须来自 公众平台 → 基本配置 → IP白名单 里列出的地址。家宽的地址会变，
所以昨天能用的配置今天可能就失败。错误信息会直接说这件事。

### access_token 是按账号唯一的（errcode 45009）

微信每个账号只发一个 token，有效期两小时，每天发放次数有上限，而且**新的一次发放会让上一个失效**。
如果别的系统（CMS、某个微信 SDK、同事的脚本）在用同一个账号，你们会互相把对方顶掉。
本插件把 token 缓存在磁盘上、提前五分钟刷新，并把并发刷新收敛成一次发放。它对**另一个系统**无能为力。

### 账号类型

**未认证的个人订阅号也能用草稿箱和素材接口。** 这是权限最受限的一种账号，且是拿真实账号验证过的。
它**不能**做的是「通过 API 群发」——而本插件本来就不群发，所以那条限制碰不到。
如果某个接口确实没开放，微信会回 **errcode 48001, "api unauthorized"**，插件会用大白话说清楚。

注意 **IP 白名单是在取 token 时就校验的**，早于任何接口。所以白名单没配会每次都是 40164，
它不告诉你任何权限信息。

### 图片

`media/uploadimg` 只收 jpg/png 且要小于 1MB；插件会在花掉一次 API 调用之前先在本地检查。
封面走的是**另一个**接口（永久 thumb 素材），插件替你处理了。

## License

[MIT](./LICENSE)。
