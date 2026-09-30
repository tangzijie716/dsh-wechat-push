/**
 * dsh-wechat-push —— 微信公众号投递插件（拆自 dsh-wechat-mp 的投递半边）。
 *
 * 只做一件事：把**已有的** HTML 正文与图片送进公众号草稿箱，外加一个「发公众号」按钮。
 * 它不排版——需要 markdown 起步时，按钮会去用 dsh-wechat-html 发布的 `ctx.wechatHtml`
 * 服务；两个插件因此互不依赖，各自都能单独安装。
 *
 * 凭据刻意不在这里解决：插件不认识任何默认来源，每次调用都必须由调用方把凭据文件
 * 路径传进来（见 `lib/credentials.js`）。因此本插件不注入 `credentials` 服务，
 * 也不再因为「部署没配凭据」而整体不挂载。
 *
 * 永远不群发：草稿建好之后，仍然要人在公众平台后台点发送。
 * @module dsh-wechat-push
 */
import { resolveConfig } from './config.js';
import { WechatPushService } from './remote/service.js';
import { registerApiTools } from './tools/api.js';

export { TYPERT } from './remote/typert.host.js';
export { deriveTitle } from './remote/service.js';
export { DEFAULT_BASE_URL, resolveConfig, resolveTokenCacheDir } from './config.js';
export { APP_ID_KEY, APP_SECRET_KEY, parseCredentialText, readCredentials } from './credentials.js';
export { WRITE_TOOLS } from './tools/api.js';

/** cordis 插件名。 */
export const name = 'wechat-push';

/** 需要工具注册表。 */
export const inject = ['tools'];

/**
 * 注册「发公众号」按钮的 Host 半边，并挂上 API 工具。
 *
 * 工具无条件注册：它们不再依赖任何凭据提供方，缺凭据会在**调用时**由
 * `credentials_path` 缺失报出来，而不是让工具整个消失。
 * @param ctx - 带工具注册表的 context。
 * @param config - profile 里写的 config（可缺省）。
 */
export function apply(ctx, config) {
    const resolved = resolveConfig(config);
    registerApiTools(ctx, resolved);
    // 按钮的 Host 端。它和工具放在一起而不是放进 agent preset，因为它的调用方是浏览器，
    // 在 agent loop 之外。
    ctx.plugin(WechatPushService, resolved);
}
