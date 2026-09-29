/**
 * Typert Host Face —— loader 注册的 `TYPERT` 清单，浏览器半边靠它调用本插件的服务。
 *
 * 手写而非生成：生成器是 monorepo 里的工作区工具，外部插件只要给出 loader 校验的形状即可。
 * loader 要求每个 codec 带真正的 zod v4 schema（它会检查 `_zod`），所以这里不能用
 * 浏览器包里那种轻量校验器。
 * @module dsh-wechat-push/typert
 */
import { z } from 'zod';

const publishParameterSchema = z.object({
    markdown: z.string().optional(),
    html: z.string().optional(),
    title: z.string().optional(),
    theme: z.string().optional(),
    fontSize: z.string().optional(),
}).refine(value => Boolean(value.markdown?.trim() || value.html?.trim()), {
    message: 'markdown 或 html 至少要提供一个',
});

const publishResultSchema = z.object({
    ok: z.boolean(),
    mediaId: z.string().optional(),
    title: z.string().optional(),
    error: z.string().optional(),
    warnings: z.array(z.string()).optional(),
    deduplicated: z.boolean().optional(),
});

/** 由 `@deepseek-ai/dsh-typert-loader` 在插件加载时 import 的清单。 */
export const TYPERT = {
    package: 'dsh-wechat-push',
    face: 'host',
    schemas: [],
    invocations: [
        {
            id: 'dsh-wechat-push#wechatPush/publish',
            service: 'wechatPush',
            namespace: 'wechatPush',
            method: 'publish',
            invocation: { kind: 'direct' },
            parameters: [
                {
                    name: 'request',
                    codec: {
                        mode: 'strict',
                        typeSymbol: 'dsh-wechat-push/remote#PublishRequest',
                        schema: publishParameterSchema,
                    },
                },
            ],
            result: {
                mode: 'strict',
                typeSymbol: 'dsh-wechat-push/remote#PublishResult',
                schema: publishResultSchema,
            },
            sourceLocation: { file: 'src/remote/service.ts', line: 1, column: 1 },
        },
    ],
};
