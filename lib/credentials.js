/**
 * 凭据读取：**只读调用方显式给出的文件**。
 *
 * 这个插件刻意不认识任何「默认凭据来源」——不查环境变量、不看 `$DSH_HOME`、
 * 不碰任何受管凭据库。密钥从哪来完全由调用方决定，并把路径作为参数传进来，
 * 所以插件本身无法在无人指示的情况下读到任何账号的凭据。
 *
 * 为什么不把密钥直接当参数传：DSH 的工具参数会进会话记录与事件日志
 * （`dsh-tools` 没有敏感参数的概念）。传**路径**则密钥永远不会离开进程。
 * @module dsh-wechat-push/credentials
 */
import { readFile } from 'node:fs/promises';

/** 认这两个名字；与 `.env` / `.credentials.yaml` 的写法都兼容。 */
export const APP_ID_KEY = 'WECHAT_MP_APPID';
export const APP_SECRET_KEY = 'WECHAT_MP_SECRET';

/**
 * 解析一个键值文本（`.env` 或 `.credentials.yaml` 的 `refs:` 段落通用）。
 *
 * 刻意做得比严格的 YAML 宽松：只认 `名字: 值` 与 `名字=值` 两种行，
 * 去掉行尾注释、剥掉包裹的引号，其余一律忽略。
 * @param text - 文件内容。
 * @returns 名字到值的映射。
 */
export function parseCredentialText(text) {
    const values = new Map();
    for (const raw of text.split(/\r?\n/)) {
        // 行尾注释会紧贴在值后面，先切掉；值里本来也不该出现裸的 ' #'。
        const line = raw.replace(/\s+#.*$/, '').trim();
        if (line === '' || line.startsWith('#'))
            continue;
        const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*(.*)$/.exec(line);
        if (match === null)
            continue;
        let value = match[2].trim();
        if (value.length >= 2
            && ((value.startsWith('"') && value.endsWith('"'))
                || (value.startsWith("'") && value.endsWith("'")))) {
            value = value.slice(1, -1);
        }
        if (value !== '')
            values.set(match[1], value);
    }
    return values;
}

/**
 * 从调用方给出的路径读出公众号凭据。
 *
 * 缺哪个就报哪个，并把路径写进错误——路径本身不是秘密，缺的才是重点。
 * @param credentialsPath - 调用方显式传入的凭据文件路径（`.env` 或 `.credentials.yaml`）。
 * @returns AppID 与 AppSecret。
 */
export async function readCredentials(credentialsPath) {
    const filePath = typeof credentialsPath === 'string' ? credentialsPath.trim() : '';
    if (filePath === '') {
        throw new Error('缺少 `credentials_path`：公众号凭据必须由调用方显式提供。'
            + `请传入一个含 ${APP_ID_KEY} 与 ${APP_SECRET_KEY} 的文件路径（例如工作区的 .env）。`
            + '本插件不认识任何默认凭据来源，不会自行去环境变量或凭据库里找。');
    }
    let text;
    try {
        text = await readFile(filePath, 'utf8');
    }
    catch (error) {
        throw new Error(`读不到凭据文件 \`${filePath}\`：`
            + `${error instanceof Error ? error.message : String(error)}。`
            + '请确认路径正确、文件可读。');
    }
    const values = parseCredentialText(text);
    const missing = [APP_ID_KEY, APP_SECRET_KEY].filter(key => !values.has(key));
    if (missing.length > 0) {
        throw new Error(`凭据文件 \`${filePath}\` 缺少 ${missing.join(' 和 ')}。`
            + `需要的两个名字是 ${APP_ID_KEY} 与 ${APP_SECRET_KEY}。`);
    }
    return { appId: values.get(APP_ID_KEY), appSecret: values.get(APP_SECRET_KEY) };
}
