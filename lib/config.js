/**
 * 投递半边的配置解析。
 *
 * 这里只有凭据的**引用名**，密钥本身留在凭据提供方，所以这份配置可以放心提交、
 * 也可以原样渲染进设置界面。
 * @module dsh-wechat-push/config
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 微信 API 默认入口。可覆盖，便于代理或测试重定向。 */
export const DEFAULT_BASE_URL = 'https://api.weixin.qq.com';

/** 部署没有指定 tokenCacheDir 时，access_token 缓存落到系统临时目录。 */
export function resolveTokenCacheDir(config) {
    return config.tokenCacheDir || join(tmpdir(), 'dsh-wechat-push', 'tokens');
}

/**
 * 把 profile 里写的 config 归一化。
 * @param raw - cordis 传进来的原始 config。
 * @returns 每个键都有值的配置对象。
 */
export function resolveConfig(raw) {
    const config = raw ?? {};
    return {
        appIdRef: config.appIdRef || 'WECHAT_MP_APPID',
        appSecretRef: config.appSecretRef || 'WECHAT_MP_SECRET',
        tokenCacheDir: typeof config.tokenCacheDir === 'string' ? config.tokenCacheDir : '',
        baseUrl: config.baseUrl || DEFAULT_BASE_URL,
        defaultAuthor: typeof config.defaultAuthor === 'string' ? config.defaultAuthor : '',
        defaultCover: typeof config.defaultCover === 'string' ? config.defaultCover : '',
        defaultCoverMediaId: typeof config.defaultCoverMediaId === 'string' ? config.defaultCoverMediaId : '',
        requireApproval: config.requireApproval === true,
    };
}
