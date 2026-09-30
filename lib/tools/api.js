/**
 * 和微信 API 打交道的三个工具：传图、建草稿、列草稿。
 *
 * 这一半只管「把已有的 HTML 和图片送进草稿箱」——排版是 dsh-wechat-html 的事。
 * 工具无条件挂载，但每次调用都必须带 `credentials_path`：插件不认识任何默认凭据来源，
 * 缺了就在调用时报错，而不是让工具悄悄消失。
 * @module dsh-wechat-push/tools/api
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveTokenCacheDir } from '../config.js';
import { readCredentials } from '../credentials.js';
import { MpClient } from '../mp-client/index.js';
import { createDraft as publishDraft } from '../publish.js';

/** 会改动公众号、因而已知需要审批的工具。 */
export const WRITE_TOOLS = new Set(['mp_upload_image', 'mp_create_draft']);

/** 每个工具都要的那个参数：调用方显式给出的凭据文件路径。 */
const CREDENTIALS_PATH_PARAM = {
    type: 'string',
    required: true,
    description: 'Path to a file holding WECHAT_MP_APPID and WECHAT_MP_SECRET '
        + '(e.g. the workspace `.env`, or a `.credentials.yaml` with a `refs:` block). '
        + 'Pass the path, never the secret itself. This plugin reads no other source: '
        + 'no environment variables, no managed credential store.',
};


/**
 * 为一次操作建一个客户端。
 *
 * 凭据每次调用都重新读文件、从不缓存：正因为逐次读取，轮换后的密钥才能在下一次调用就生效，
 * 不需要重启。密钥来自调用方传入的**路径**，所以它不会进入工具参数记录。
 * @param config - 指明行为开关的部署配置。
 * @param credentialsPath - 调用方显式给出的凭据文件路径。
 * @returns 绑定到该账号的客户端。
 */
async function connect(config, credentialsPath) {
    const { appId, appSecret } = await readCredentials(credentialsPath);
    return new MpClient({
        appId,
        appSecret,
        cacheDir: resolveTokenCacheDir(config),
        baseUrl: config.baseUrl,
    });
}

/**
 * 注册 API 工具，以及守着写操作的那道审批闸门。
 * @param ctx - 带工具注册表的 context。
 * @param config - 已归一化的部署配置。
 */
export function registerApiTools(ctx, config) {
    // 一次调用会不会为人停下来，会改变模型做计划的方式；所以描述里的承诺必须跟着闸门走，
    // 而不是无条件断言。
    const approvalNote = config.requireApproval ? ' Requires user approval.' : '';
    // 往公开的发布账号里写东西，闸门装在策略层而不是每个工具内部，这样部署可以重排或扩展
    // 策略而不必动本插件。没有审批通道时，整条流水线 fail closed。
    //
    // 只有确实想要闸门时才注册监听器：不该让一道关掉的闸门还占着 waterfall 跑一遍再转交。
    if (config.requireApproval) {
        ctx.on('tools/pre-execute', async (exec, next) => {
            if (!WRITE_TOOLS.has(exec.name))
                return next();
            return {
                kind: 'ask',
                reason: exec.name === 'mp_upload_image'
                    ? '上传图片到公众号素材库'
                    : '在公众号草稿箱创建草稿',
            };
        });
    }

    ctx.tools.register(defineTool({
        name: 'mp_upload_image',
        description: 'Upload one local image to the WeChat Official Account and return the '
            + 'mmbiz.qpic.cn URL that article bodies must use. WeChat strips images served '
            + 'from any other host, so every local image in an article goes through this. '
            + 'Accepts jpg and png under 1 MB.' + approvalNote,
        parameters: {
            credentials_path: CREDENTIALS_PATH_PARAM,
            path: { type: 'string', required: true, description: 'Absolute path to a local jpg or png.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    url: { type: 'string', required: true, description: 'The mmbiz.qpic.cn URL for use in article HTML.' },
                    path: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `Uploaded ${value.path}\n→ ${value.url}` }],
        },
        async execute(args, exec) {
            const client = await connect(config, args.credentials_path);
            const url = await client.uploadImage(resolvePath(args.path), exec.signal);
            return { url, path: resolvePath(args.path) };
        },
        presentCall: args => ({
            card: 'generic',
            title: 'Upload image to WeChat',
            kind: 'other',
            locations: [{ path: args.path }],
        }),
    }));

    ctx.tools.register(defineTool({
        name: 'mp_create_draft',
        description: 'Create a draft in the WeChat Official Account draft box from HTML. '
            + 'The HTML usually comes from mp_render, but any inline-styled HTML works — '
            + 'pass it as a file with `html_path` or as text with `html`. '
            + 'Does NOT publish: a human still confirms and sends it from the Official Account '
            + 'console. Every image placeholder token must be resolved first — pass a token→url '
            + 'or token→local-path entry per image. An explicit image entry with neither source '
            + 'is treated as skipped and does not block draft creation. WeChat requires a cover image.' + approvalNote,
        parameters: {
            credentials_path: CREDENTIALS_PATH_PARAM,
            html_path: {
                type: 'string',
                description: 'File holding the article body (the `htmlPath` from mp_render). Give this OR `html`, not both.',
            },
            html: {
                type: 'string',
                description: 'The article body as HTML text. Give this OR `html_path`, not both.',
            },
            title: { type: 'string', required: true, description: 'Article title, at most 64 characters.' },
            cover: {
                type: 'object',
                additionalProperties: false,
                description: 'Cover source. Reuse `media_id` when present; otherwise upload the local `path`.',
                properties: {
                    media_id: {
                        type: 'string',
                        description: 'An existing WeChat cover material id. Takes precedence over `path`.',
                    },
                    path: {
                        type: 'string',
                        description: 'Local jpg/png cover uploaded only when `media_id` is empty.',
                    },
                },
            },
            cover_image: {
                type: 'string',
                description: 'Legacy alias of `cover.path`.',
            },
            thumb_media_id: {
                type: 'string',
                description: 'Legacy alias of `cover.media_id`.',
            },
            author: { type: 'string', description: 'Author byline. Defaults to the deployment setting.' },
            digest: {
                type: 'string',
                description: 'Summary shown in the article list. WeChat derives one from the body when omitted.',
            },
            source_url: { type: 'string', description: 'Target of the "阅读原文" link.' },
            images: {
                type: 'array',
                description: 'One entry per image in the article. Each entry names the placeholder with '
                    + '`token` (or `src`) and gives either an already-uploaded `url` or a local `path` '
                    + 'to upload now. If both are empty, that image is left unchanged and skipped.',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        token: {
                            type: 'string',
                            description: 'A placeholder token from mp_render, e.g. dsh-mp-image-0. Defaults to `src` when omitted.',
                        },
                        src: {
                            type: 'string',
                            description: 'The exact `img src` value to replace, for HTML that is not from mp_render.',
                        },
                        url: {
                            type: 'string',
                            description: 'An existing WeChat image URL. When non-empty it is reused directly, '
                                + 'even if `path` is also supplied.',
                        },
                        path: {
                            type: 'string',
                            description: 'A local jpg/png uploaded only when `url` is empty. '
                                + 'Accepts jpg/png under 1 MB only.',
                        },
                    },
                },
            },
            upload_local_images: {
                type: 'boolean',
                description: 'Also upload every `img src` that is a local file path rather than a URL. '
                    + 'Default false; useful for hand-written HTML. Relative paths resolve against `base_dir`.',
            },
            missing_image_policy: {
                type: 'string',
                enum: ['keep', 'remove', 'warn', 'error'],
                description: 'What to do when an explicit body-image entry has neither url nor path. '
                    + 'Defaults to warn: keep the HTML, continue, and return a warning.',
            },
            base_dir: {
                type: 'string',
                description: 'Base directory for relative image paths in `upload_local_images` mode. '
                    + 'Defaults to the directory of `html_path`.',
            },
            submitted_path: {
                type: 'string',
                description: 'Where to save the exact submitted body when `html` text was given. '
                    + 'With `html_path` the copy always lands beside it as `<html_path>.submitted.html`.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    mediaId: { type: 'string', required: true, description: 'The draft media_id.' },
                    title: { type: 'string', required: true },
                    bytes: { type: 'integer', required: true, description: 'UTF-8 size of the submitted body.' },
                    imagesFilled: { type: 'integer', required: true, description: 'How many image sources were resolved.' },
                    uploaded: { type: 'integer', required: true, description: 'How many of them this call uploaded itself.' },
                    reused: { type: 'integer', required: true, description: 'How many existing body-image URLs were reused.' },
                    skipped: { type: 'array', required: true, items: { type: 'string' } },
                    warnings: { type: 'array', required: true, items: { type: 'string' } },
                    coverUploaded: { type: 'boolean', required: true },
                    deduplicated: { type: 'boolean', required: true },
                    submittedPath: { type: 'string' },
                    submittedSaved: { type: 'boolean', required: true },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `Draft created: "${value.title}" (media_id ${value.mediaId}, ${value.bytes} bytes, `
                        + `${value.imagesFilled} image(s) resolved, ${value.uploaded} uploaded, `
                        + `${value.reused} reused, ${value.skipped.length} skipped${value.deduplicated ? ', duplicate suppressed' : ''}).\n`
                        + (value.warnings.length ? `Warnings: ${value.warnings.join('; ')}\n` : '')
                        + '打开公众平台后台「草稿箱」确认排版并发布——插件不会替你群发。',
                }],
        },
        async execute(args, exec) {
            const htmlPathValue = typeof args.html_path === 'string' ? args.html_path.trim() : '';
            const htmlValue = typeof args.html === 'string' ? args.html.trim() : '';
            if ((htmlPathValue === '') === (htmlValue === '')) {
                throw new Error('mp_create_draft 需要 `html_path` 和 `html` 二选一：正文既可以给文件，也可以直接给 HTML 文本');
            }
            const htmlPath = htmlPathValue === '' ? undefined : resolvePath(htmlPathValue);
            const raw = htmlPath === undefined
                ? args.html
                : await readFile(htmlPath, { encoding: 'utf8', signal: exec.signal });

            const client = await connect(config, args.credentials_path);

            const author = args.author ?? config.defaultAuthor;
            const result = await publishDraft(client, {
                ...args,
                html: raw,
                author,
                sourceUrl: args.source_url,
                missingImagePolicy: args.missing_image_policy,
                uploadLocalImages: args.upload_local_images === true,
                baseDir: args.base_dir !== undefined
                    ? resolvePath(args.base_dir)
                    : htmlPath !== undefined ? resolvePath(htmlPath, '..') : process.cwd(),
            }, exec.signal);

            // 提交的正文与渲染出的文件在填完 token 之后就不一样了；留一份，日后再问
            // 「我们到底发出去的是什么」才有答案。
            const submittedPath = htmlPath !== undefined
                ? `${htmlPath}.submitted.html`
                : args.submitted_path === undefined ? undefined : resolvePath(args.submitted_path);
            let submittedSaved = false;
            if (submittedPath !== undefined) {
                try {
                    await mkdir(dirname(submittedPath), { recursive: true });
                    await writeFile(submittedPath, result.content, 'utf-8');
                    submittedSaved = true;
                }
                catch (error) {
                    result.warnings.push(`草稿已创建，但审计副本保存失败：${error instanceof Error ? error.message : String(error)}`);
                }
            }

            return {
                mediaId: result.mediaId,
                title: args.title,
                bytes: Buffer.byteLength(result.content, 'utf-8'),
                imagesFilled: result.uploaded + result.reused,
                uploaded: result.uploaded,
                reused: result.reused,
                skipped: result.skipped,
                warnings: result.warnings,
                coverUploaded: result.coverUploaded,
                deduplicated: result.deduplicated,
                ...(submittedPath === undefined ? {} : { submittedPath }),
                submittedSaved,
            };
        },
        presentCall: args => ({
            card: 'generic',
            title: `Create WeChat draft: ${args.title}`,
            kind: 'other',
            ...args.html_path ? { locations: [{ path: args.html_path }] } : {},
        }),
    }));

    ctx.tools.register(defineTool({
        name: 'mp_list_drafts',
        description: 'List recent drafts in the WeChat Official Account draft box, newest first. '
            + 'Read-only; use it to confirm a draft landed.',
        parameters: {
            credentials_path: CREDENTIALS_PATH_PARAM,
            count: {
                type: 'integer',
                description: 'How many drafts to return, 1 to 20. Defaults to 5.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    drafts: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                mediaId: { type: 'string', required: true },
                                updatedAt: { type: 'integer', required: true, description: 'Unix seconds.' },
                                titles: { type: 'array', required: true, items: { type: 'string' } },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.drafts.length === 0
                        ? '草稿箱是空的。'
                        : value.drafts
                            .map(draft => `${new Date(draft.updatedAt * 1000).toISOString().slice(0, 16).replace('T', ' ')}  ${draft.titles.join(' / ')}  (${draft.mediaId})`)
                            .join('\n'),
                }],
        },
        async execute(args, exec) {
            const count = args.count ?? 5;
            if (count < 1 || count > 20)
                throw new Error('mp_list_drafts: count 必须在 1..20 之间');
            const client = await connect(config, args.credentials_path);
            const drafts = await client.listDrafts(count, exec.signal);
            return {
                drafts: drafts.map(draft => ({
                    mediaId: draft.media_id,
                    updatedAt: draft.update_time,
                    titles: draft.titles,
                })),
            };
        },
        presentCall: () => ({ card: 'generic', title: 'List WeChat drafts', kind: 'other' }),
    }));
}
