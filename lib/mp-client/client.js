/**
 * A thin, dependency-free wrapper over the WeChat Official Account REST API.
 *
 * Zero Cordis: this module is what survives a breaking harness change (PLAN 决策 2),
 * and it is unit-testable by injecting `fetchImpl`.
 * @module
 */
import { basename, extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { WeChatApiError, WeChatTransportError } from "./errors.js";
import { TokenManager, sharedTokenManager } from "./token.js";
export { WeChatApiError, WeChatTransportError } from "./errors.js";
/** Default API origin. Overridable so tests and proxies can redirect it. */
export const DEFAULT_BASE_URL = 'https://api.weixin.qq.com';
/** `media/uploadimg` rejects anything larger; checked locally for a clearer error. */
const IN_ARTICLE_IMAGE_LIMIT_BYTES = 1024 * 1024;
/** Image formats the in-article upload endpoint accepts. */
const ALLOWED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);
/**
 * REST client for one Official Account.
 *
 * Every call resolves an access_token first, and retries once against a forced
 * refresh when WeChat reports the token as expired — that race is normal near the
 * two-hour boundary and should not surface to the caller.
 */
export class MpClient {
    baseUrl;
    fetchImpl;
    tokens;
    constructor(options) {
        this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
        this.fetchImpl = options.fetchImpl ?? fetch;
        const tokenOptions = {
            appId: options.appId,
            appSecret: options.appSecret,
            cacheDir: options.cacheDir,
            baseUrl: this.baseUrl,
            ...options.fetchImpl ? { fetchImpl: options.fetchImpl } : {},
            ...options.now ? { now: options.now } : {},
        };
        // Injected clocks/fetches belong to isolated tests. Normal clients share the manager,
        // including its in-flight refresh, across tool and Web-button calls in this process.
        this.tokens = options.fetchImpl || options.now
            ? new TokenManager(tokenOptions)
            : sharedTokenManager(tokenOptions);
    }
    /**
     * Perform one token-authenticated call, retrying once on a token-expiry code.
     * @param endpoint - API path, e.g. `/cgi-bin/draft/add`.
     * @param build - produces the RequestInit for a given attempt.
     * @param signal - caller cancellation.
     * @param query - extra query parameters beyond `access_token`.
     * @returns the parsed JSON body, already checked for `errcode`.
     */
    async call(endpoint, build, signal, query = {}) {
        for (let attempt = 0; attempt < 2; attempt++) {
            const token = await this.tokens.get(signal, attempt > 0);
            const url = new URL(endpoint, this.baseUrl);
            url.searchParams.set('access_token', token);
            for (const [key, value] of Object.entries(query))
                url.searchParams.set(key, value);
            const body = build();
            let response;
            try {
                const headers = typeof body === 'string' ? { 'content-type': 'application/json; charset=utf-8' } : undefined;
                response = await this.fetchImpl(url, {
                    method: 'POST',
                    signal: signal ?? null,
                    ...headers === undefined ? {} : { headers },
                    ...body === undefined ? {} : { body },
                });
            }
            catch (error) {
                throw new WeChatTransportError(endpoint, error);
            }
            const parsed = await this.parseResponse(response, endpoint);
            if (typeof parsed.errcode === 'number' && parsed.errcode !== 0) {
                const error = new WeChatApiError(parsed.errcode, parsed.errmsg ?? '', endpoint);
                // A token can expire between the cache check and the server's read of it.
                // One forced refresh distinguishes that race from a genuinely bad secret.
                if (error.isTokenExpiry && attempt === 0)
                    continue;
                throw error;
            }
            return parsed;
        }
        // The loop either returns or throws; this satisfies the compiler's flow analysis.
        throw new Error(`unreachable: ${endpoint} retry loop exhausted`);
    }
    async parseResponse(response, endpoint) {
        let text;
        try { text = await response.text(); }
        catch (error) { throw new WeChatTransportError(endpoint, error); }
        let parsed;
        try { parsed = JSON.parse(text); }
        catch {
            const sample = text.slice(0, 200).replace(/\s+/g, ' ');
            throw new WeChatTransportError(endpoint, new Error(`HTTP ${response.status}: 微信返回了非 JSON 响应${sample ? ` (${sample})` : ''}`));
        }
        if (!response.ok) {
            throw new WeChatTransportError(endpoint, new Error(`HTTP ${response.status}: ${JSON.stringify(parsed).slice(0, 300)}`));
        }
        return parsed;
    }
    /**
     * Upload an in-article image and get back a `mmbiz.qpic.cn` URL.
     *
     * This endpoint does not consume the account's permanent-material quota and the
     * returned URL is only valid inside article bodies.
     * @param path - local image file, jpg or png, under 1 MB.
     * @param signal - caller cancellation.
     * @returns the WeChat-hosted image URL.
     */
    async uploadImage(path, signal) {
        const bytes = await this.readImage(path, IN_ARTICLE_IMAGE_LIMIT_BYTES, '正文图片');
        const result = await this.call('/cgi-bin/media/uploadimg', () => this.imageForm(path, bytes), signal);
        if (typeof result.url !== 'string') {
            throw new WeChatApiError(-2, `uploadimg returned no url: ${JSON.stringify(result)}`, '/cgi-bin/media/uploadimg');
        }
        return result.url;
    }
    /**
     * Upload a permanent thumb material, which is what a draft's cover requires.
     * @param path - local image file, jpg or png.
     * @param signal - caller cancellation.
     * @returns the `media_id` to use as `thumb_media_id`.
     */
    async uploadThumb(path, signal) {
        // The cover is a permanent material and allows a larger file than an in-article
        // image, so only the format check applies here.
        const bytes = await this.readImage(path, Number.POSITIVE_INFINITY, '封面图');
        const result = await this.call('/cgi-bin/material/add_material', () => this.imageForm(path, bytes), signal, { type: 'thumb' });
        if (typeof result.media_id !== 'string') {
            throw new WeChatApiError(-2, `add_material returned no media_id: ${JSON.stringify(result)}`, '/cgi-bin/material/add_material');
        }
        return result.media_id;
    }
    /**
     * Create a draft. The draft is not published; a human still confirms it in the
     * Official Account console.
     * @param articles - one or more articles to place in the draft.
     * @param signal - caller cancellation.
     * @returns the draft's `media_id`.
     */
    async addDraft(articles, signal) {
        if (articles.length === 0)
            throw new Error('addDraft requires at least one article');
        const payload = JSON.stringify({ articles });
        const result = await this.call('/cgi-bin/draft/add', () => payload, signal);
        if (typeof result.media_id !== 'string') {
            throw new WeChatApiError(-2, `draft/add returned no media_id: ${JSON.stringify(result)}`, '/cgi-bin/draft/add');
        }
        return result.media_id;
    }
    /**
     * List recent drafts, newest first.
     * @param count - how many to return, 1..20.
     * @param signal - caller cancellation.
     * @returns one summary per draft.
     */
    async listDrafts(count, signal) {
        const payload = JSON.stringify({ offset: 0, count, no_content: 1 });
        const result = await this.call('/cgi-bin/draft/batchget', () => payload, signal);
        return (result.item ?? []).map(entry => ({
            media_id: entry.media_id ?? '',
            update_time: entry.update_time ?? 0,
            titles: (entry.content?.news_item ?? []).map(article => article.title ?? ''),
        }));
    }
    /**
     * Read and validate a local image before spending an API call on it.
     * @param path - local file path.
     * @param limitBytes - endpoint's size ceiling.
     * @param label - what the image is, for the error message.
     * @returns the file contents.
     */
    async readImage(path, limitBytes, label) {
        const extension = extname(path).toLowerCase();
        if (!ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
            throw new Error(`${label}只支持 jpg/png,拿到的是 ${extension || '(无扩展名)'}: ${path}`);
        }
        let bytes;
        try {
            bytes = await readFile(path);
        }
        catch (error) {
            throw new Error(`读不到${label} ${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (bytes.byteLength > limitBytes) {
            const kb = Math.round(bytes.byteLength / 1024);
            throw new Error(`${label} ${path} 有 ${kb}KB,超过微信的 ${Math.round(limitBytes / 1024)}KB 限制,先压缩再传`);
        }
        return bytes;
    }
    /**
     * Build the multipart body both upload endpoints expect.
     * @param path - source path, used for the part's filename.
     * @param bytes - file contents.
     * @returns a FormData carrying the `media` part.
     */
    imageForm(path, bytes) {
        const form = new FormData();
        const extension = extname(path).toLowerCase();
        const type = extension === '.png' ? 'image/png' : 'image/jpeg';
        // A fresh view per attempt: a Blob may not be re-read after a retry consumed it.
        form.append('media', new Blob([new Uint8Array(bytes)], { type }), basename(path));
        return form;
    }
}
