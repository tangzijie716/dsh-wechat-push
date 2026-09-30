/**
 * 「发公众号」按钮背后的 Host 服务：`ctx.wechatPush`。
 *
 * 浏览器半边只负责点击和取出消息正文；所有碰微信的事情都在这里，复用同一套 REST 层。
 * 排版则不再自带一份，而是可选消费 `ctx.wechatHtml`（dsh-wechat-html 发布的排版服务）——
 * 两个插件因此互不依赖：装了排版插件按钮就能从 markdown 起步，没装就直说。
 * @module dsh-wechat-push/remote/service
 */
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { resolveTokenCacheDir } from '../config.js';
import { MpClient } from '../mp-client/index.js';
import { createDraft } from '../publish.js';

/** 微信会把超出的部分截掉，所以推导出来的标题先在这里切。 */
const TITLE_LIMIT = 64;

/**
 * 从消息本身推导文章标题。
 *
 * 草稿要能在后台列表里被认出来，而一条助手回复自己是没有标题的——它的第一个标题行，
 * 或者退一步第一条正文行，就是人本来会打的字。
 * @param markdown - 消息原文。
 * @returns 非空标题。
 */
export function deriveTitle(markdown) {
    for (const raw of markdown.split('\n')) {
        const line = raw.trim();
        if (line === '')
            continue;
        const heading = /^#{1,6}\s+(.*)$/.exec(line);
        const text = (heading?.[1] ?? line)
            // 去掉那些会在后台文章列表里原样显示的强调符号。
            .replace(/[*_`~]/g, '')
            .replace(/^>\s*/, '')
            .trim();
        if (text !== '')
            return text.length > TITLE_LIMIT ? text.slice(0, TITLE_LIMIT) : text;
    }
    return '未命名草稿';
}

/**
 * 把助手消息投递进公众号草稿箱。
 *
 * 注册为 `ctx.wechatPush`；API 网关把浏览器的 `remote.wechatPush.publish` 路由到这里。
 */
let WechatPushService = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _publish_decorators;
    return class WechatPushService extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _publish_decorators = [Remote('publish')];
            __esDecorate(this, null, _publish_decorators, { kind: "method", name: "publish", static: false, private: false, access: { has: obj => "publish" in obj, get: obj => obj.publish }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        config = __runInitializers(this, _instanceExtraInitializers);
        constructor(ctx, config) {
            super(ctx, 'wechatPush');
            this.config = config;
        }
        /**
         * 把一条消息排好版、传好图，放进草稿箱。
         *
         * 错误走信封返回而不是抛出去：调用方是个必须把原因显示出来的按钮，
         * 而微信的 errcode 本身就带着可执行的说明。
         * @param request - 消息正文（markdown 或已经是 HTML）与可选的呈现覆盖项。
         * @returns 草稿的 media_id，或者它没能建出来的原因。
         */
        async publish(request) {
            try {
                if (this.config.requireApproval) {
                    return {
                        ok: false,
                        error: '当前配置要求写操作审批，「发公众号」按钮不能绕过审批。请改用 mp_create_draft 工具完成投递。',
                    };
                }
                const coverPath = this.config.defaultCover.trim();
                const coverMediaId = this.config.defaultCoverMediaId.trim();
                if (coverPath === '' && coverMediaId === '') {
                    return {
                        ok: false,
                        error: '没有配置封面图。微信要求每篇文章必须有封面——'
                            + '请给 wechat-push 设置 defaultCoverMediaId，或让 defaultCover 指向一张本地 jpg/png。',
                    };
                }

                const html = (request.html ?? '').trim();
                const markdown = (request.markdown ?? '').trim();
                let body;
                let images;

                if (html !== '') {
                    // 已经是 HTML 就直接用：这条路径不需要排版插件。
                    body = html;
                    images = [];
                }
                else {
                    if (markdown === '')
                        return { ok: false, error: '这条消息没有正文,没什么可发布的。' };
                    const typesetting = this.ctx.get('wechatHtml');
                    if (typesetting === undefined) {
                        return {
                            ok: false,
                            error: '这条消息是 markdown,而排版插件 dsh-wechat-html 没有装(或没启用),'
                                + '按钮没法把它排成微信 HTML。装上排版插件,或改用 mp_create_draft 直接投递 HTML。',
                        };
                    }
                    const rendered = typesetting.render(markdown, {
                        ...request.theme === undefined ? {} : { theme: request.theme },
                        ...request.fontSize === undefined ? {} : { fontSize: request.fontSize },
                    });
                    body = rendered.html;
                    images = rendered.images;
                }

                const client = await this.connect();
                const title = (request.title ?? '').trim() || deriveTitle(markdown || body);
                const result = await createDraft(client, {
                    title,
                    html: body,
                    cover: { media_id: coverMediaId, path: coverPath },
                    author: this.config.defaultAuthor,
                    missingImagePolicy: 'warn',
                    images: images.map(image => ({
                        token: image.token,
                        ...(image.isLocal ? { path: image.source } : { url: image.source }),
                    })),
                });
                return {
                    ok: true,
                    mediaId: result.mediaId,
                    title,
                    warnings: result.warnings,
                    deduplicated: result.deduplicated,
                };
            }
            catch (error) {
                return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
        }
        /**
         * 按钮这条路没有凭据可用。
         *
         * 凭据现在只能由调用方把**文件路径**作为参数传进来（见 `lib/credentials.js`），
         * 而这个方法的调用方是浏览器里的一次点击——它既不该拿到密钥，也没有「路径」可传。
         * 所以这里明确拒绝，并把人指向能传参的工具，而不是假装按钮还能用。
         */
        async connect() {
            throw new Error('「发公众号」按钮不再自带凭据：本插件只从调用方传入的 `credentials_path` 读凭据。'
                + '请改用 `mp_create_draft` 工具投递（把工作区 .env 的路径传给它的 credentials_path 参数）。');
        }
    };
})();
export { WechatPushService };
