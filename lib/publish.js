import { createHash } from 'node:crypto';
import { isAbsolute, resolve as resolvePath } from 'node:path';

const TOKEN_SRC = /^dsh-[a-z0-9]*-image-\d+$/;
const REMOTE_SRC = /^(https?:)?\/\//i;
const DATA_SRC = /^data:/i;
const WECHAT_IMAGE_HOST = /(^|\.)mmbiz\.qpic\.cn$/i;
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const recentDrafts = new Map();

function nonEmpty(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function escapeAttr(value, quote) {
    const escaped = value.replace(/&/g, '&amp;');
    return quote === "'" ? escaped.replace(/'/g, '&#39;') : escaped.replace(/"/g, '&quot;');
}

export function imageSources(html) {
    const sources = [];
    const pattern = /<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;
    for (const match of html.matchAll(pattern)) sources.push(match[2]);
    return sources;
}

export function replaceImageSource(html, source, replacement) {
    return html.replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi, (whole, prefix, quote, value) => {
        return value === source ? `${prefix}${quote}${escapeAttr(replacement, quote)}${quote}` : whole;
    });
}

export function removeImageSource(html, source) {
    return html.replace(/<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi, (whole, _quote, value) => {
        return value === source ? '' : whole;
    });
}

export function resolveCoverInput(args) {
    const modern = args.cover;
    if (modern !== undefined && (args.thumb_media_id !== undefined || args.cover_image !== undefined)) {
        const modernId = nonEmpty(modern?.media_id);
        const legacyId = nonEmpty(args.thumb_media_id);
        const modernPath = nonEmpty(modern?.path);
        const legacyPath = nonEmpty(args.cover_image);
        if ((legacyId && modernId !== legacyId) || (legacyPath && modernPath !== legacyPath)) {
            throw new Error('封面参数冲突：请只使用 `cover`，不要同时传入值不同的旧参数 `thumb_media_id` / `cover_image`');
        }
    }
    const cover = modern ?? { media_id: args.thumb_media_id, path: args.cover_image };
    const mediaId = nonEmpty(cover?.media_id);
    const path = nonEmpty(cover?.path);
    if (!mediaId && !path) throw new Error('需要封面：请提供 `cover.media_id`，或提供可上传的本地 `cover.path`');
    return { mediaId, path };
}

export function validateArticle({ title, html, sourceUrl, missingImagePolicy }) {
    if (nonEmpty(title) === '') throw new Error('文章标题不能为空');
    if ([...title].length > 64) throw new Error('文章标题不能超过 64 个字符');
    if (nonEmpty(html) === '') throw new Error('文章 HTML 正文不能为空');
    if (sourceUrl !== undefined && nonEmpty(sourceUrl) !== '') {
        let parsed;
        try { parsed = new URL(sourceUrl); }
        catch { throw new Error('source_url 必须是有效的 HTTP/HTTPS URL'); }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('source_url 必须是有效的 HTTP/HTTPS URL');
        }
    }
    if (!['keep', 'remove', 'warn', 'error'].includes(missingImagePolicy)) {
        throw new Error('missing_image_policy 必须是 keep、remove、warn 或 error');
    }
}

function isTrustedImageUrl(value) {
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'https:' && WECHAT_IMAGE_HOST.test(parsed.hostname);
    }
    catch { return false; }
}

export async function prepareBodyImages(client, html, entries, options = {}) {
    const warnings = [];
    const skipped = [];
    let uploaded = 0;
    let reused = 0;
    let content = html;
    const seen = new Set();
    const declared = new Set();
    const policy = options.missingImagePolicy ?? 'warn';

    for (const entry of entries ?? []) {
        const key = nonEmpty(entry?.token ?? entry?.src);
        if (!key) throw new Error('images 的每一项都要有非空的 `token` 或 `src`');
        if (seen.has(key)) throw new Error(`images 里重复定义了 ${key}`);
        seen.add(key);
        declared.add(key);
        const url = nonEmpty(entry.url);
        const path = nonEmpty(entry.path);
        if (url) {
            content = replaceImageSource(content, key, url);
            reused += 1;
            if (!isTrustedImageUrl(url)) warnings.push(`正文图片 ${key} 使用的 URL 不是微信图片域名，发布后可能被过滤`);
            continue;
        }
        if (path) {
            const uploadedUrl = await client.uploadImage(resolvePath(path), options.signal);
            content = replaceImageSource(content, key, uploadedUrl);
            uploaded += 1;
            continue;
        }
        skipped.push(key);
        if (policy === 'error') throw new Error(`正文图片 ${key} 没有 url 或 path`);
        if (policy === 'remove') content = removeImageSource(content, key);
        if (policy === 'warn') warnings.push(`正文图片 ${key} 没有 url 或 path，已保留 HTML 原状`);
    }

    if (options.uploadLocalImages) {
        for (const src of new Set(imageSources(content))) {
            if (TOKEN_SRC.test(src) || REMOTE_SRC.test(src) || DATA_SRC.test(src)) continue;
            const path = isAbsolute(src) ? src : resolvePath(options.baseDir, src);
            content = replaceImageSource(content, src, await client.uploadImage(path, options.signal));
            uploaded += 1;
        }
    }

    const unresolved = [...new Set(imageSources(content).filter(src => TOKEN_SRC.test(src) && !declared.has(src)))];
    if (unresolved.length) {
        throw new Error(`还有 ${unresolved.length} 张图没有 images 条目：${unresolved.join(', ')}`);
    }
    for (const src of new Set(imageSources(content))) {
        if (/^https?:\/\//i.test(src) && !isTrustedImageUrl(src)) {
            const warning = `正文仍包含非微信图片 URL ${src}，发布后可能被过滤`;
            if (!warnings.includes(warning)) warnings.push(warning);
        }
        else if (!REMOTE_SRC.test(src) && !DATA_SRC.test(src) && !TOKEN_SRC.test(src)) {
            const warning = `正文仍包含未上传的本地图片路径 ${src}，微信无法直接读取该文件`;
            if (!warnings.includes(warning)) warnings.push(warning);
        }
    }
    return { content, uploaded, reused, skipped, warnings };
}

export async function createDraft(client, input, signal) {
    const missingImagePolicy = input.missingImagePolicy ?? 'warn';
    validateArticle({ title: input.title, html: input.html, sourceUrl: input.sourceUrl, missingImagePolicy });
    if (nonEmpty(input.author) && [...input.author.trim()].length > 16) throw new Error('作者署名不能超过 16 个字符');
    if (input.digest !== undefined && [...String(input.digest)].length > 120) throw new Error('摘要不能超过 120 个字符');
    const cover = resolveCoverInput(input);
    // Use caller-visible sources rather than uploaded URLs/media ids, so a retry is caught
    // before it uploads the same local files again.
    const fingerprint = createHash('sha256').update(JSON.stringify({
        title: input.title.trim(), html: input.html, cover,
        images: input.images ?? [], author: nonEmpty(input.author), digest: input.digest ?? '',
        sourceUrl: nonEmpty(input.sourceUrl), missingImagePolicy,
    })).digest('hex');
    const previous = recentDrafts.get(fingerprint);
    if (previous && Date.now() - previous.createdAt < DEDUPE_WINDOW_MS) {
        return { ...previous.result, coverUploaded: false, deduplicated: true };
    }
    const body = await prepareBodyImages(client, input.html, input.images, {
        signal,
        missingImagePolicy,
        uploadLocalImages: input.uploadLocalImages,
        baseDir: input.baseDir ?? process.cwd(),
    });
    const coverUploaded = cover.mediaId === '';
    const thumbMediaId = coverUploaded ? await client.uploadThumb(resolvePath(cover.path), signal) : cover.mediaId;
    const article = {
        title: input.title.trim(),
        content: body.content,
        thumb_media_id: thumbMediaId,
        ...nonEmpty(input.author) ? { author: input.author.trim() } : {},
        ...input.digest !== undefined ? { digest: input.digest } : {},
        ...nonEmpty(input.sourceUrl) ? { content_source_url: input.sourceUrl.trim() } : {},
    };
    const mediaId = await client.addDraft([article], signal);
    const result = { ...body, mediaId, thumbMediaId, coverUploaded, deduplicated: false };
    recentDrafts.set(fingerprint, { result, createdAt: Date.now() });
    for (const [key, value] of recentDrafts) {
        if (Date.now() - value.createdAt >= DEDUPE_WINDOW_MS) recentDrafts.delete(key);
    }
    return result;
}
