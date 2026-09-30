/**
 * 投递半边的配置解析。
 *
 * 这里**只有行为开关，没有凭据**：密钥既不在配置里，也不在任何「默认来源」里，
 * 而是每次调用由调用方把凭据文件路径作为参数传进来。所以这份配置可以放心提交、
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
        tokenCacheDir: typeof config.tokenCacheDir === 'string' ? config.tokenCacheDir : '',
        baseUrl: config.baseUrl || DEFAULT_BASE_URL,
        defaultAuthor: typeof config.defaultAuthor === 'string' ? config.defaultAuthor : '',
        defaultCover: typeof config.defaultCover === 'string' ? config.defaultCover : '',
        defaultCoverMediaId: typeof config.defaultCoverMediaId === 'string' ? config.defaultCoverMediaId : '',
        requireApproval: config.requireApproval === true,
    };
}
