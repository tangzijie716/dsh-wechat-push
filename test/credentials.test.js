// dsh-wechat-push 凭据读取的单元测试（node --test）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_ID_KEY, APP_SECRET_KEY, parseCredentialText, readCredentials } from '../lib/credentials.js';

const APPID = 'wx9fcac898b18bc14d';
const SECRET = 'bba08e61b0bfc10716cfd5810c655ebe';

function fixture(name, text) {
    const dir = mkdtempSync(join(tmpdir(), 'wechat-push-cred-'));
    const file = join(dir, name);
    writeFileSync(file, text, 'utf8');
    return file;
}

test('读 .env 形式', async () => {
    const file = fixture('case.env', [
        '# 注释行',
        '',
        `${APP_ID_KEY}=${APPID}`,
        `${APP_SECRET_KEY}=${SECRET}`,
    ].join('\r\n'));
    const creds = await readCredentials(file);
    assert.equal(creds.appId, APPID);
    assert.equal(creds.appSecret, SECRET);
});

test('读 .credentials.yaml 的 refs: 段（缩进 / 引号 / 行尾注释）', async () => {
    const file = fixture('case.yaml', [
        'version: 1',
        'records:',
        '  some/record:',
        '    kind: grant',
        'refs:',
        `  ${APP_ID_KEY}: "${APPID}"`,
        `  ${APP_SECRET_KEY}: '${SECRET}'  # inline comment`,
    ].join('\n'));
    const creds = await readCredentials(file);
    assert.equal(creds.appId, APPID);
    assert.equal(creds.appSecret, SECRET);
});

test('未传路径：明确报缺参，且说明本插件不认默认来源', async () => {
    await assert.rejects(() => readCredentials(undefined), /缺少 `credentials_path`/);
    await assert.rejects(() => readCredentials('   '), /不读环境变量|不认任何默认凭据来源|缺少 `credentials_path`/);
});

test('路径不存在：报出路径与原因', async () => {
    const missing = join(tmpdir(), 'wechat-push-definitely-missing.env');
    await assert.rejects(() => readCredentials(missing), /读不到凭据文件/);
});

test('文件里缺一个变量：报出缺哪个', async () => {
    const file = fixture('half.env', `${APP_ID_KEY}=${APPID}\n`);
    await assert.rejects(() => readCredentials(file), new RegExp(`缺少 ${APP_SECRET_KEY}`));
});

test('解析器忽略注释、空行与其他段，且只取最后一个同名键', () => {
    const values = parseCredentialText([
        '# comment',
        '',
        'records:',
        '  a: 1',
        'refs:',
        `  X: first`,
        `  X: second`,
    ].join('\n'));
    assert.equal(values.get('X'), 'second');
    assert.equal(values.has('a'), true); // 宽松解析：不区分段，调用方只按名字取
    assert.equal(values.has('records'), false);
});

test('模块不引入任何凭据服务依赖（回归保护）', async () => {
    const source = await import('node:fs/promises').then(fs =>
        fs.readFile(new URL('../lib/credentials.js', import.meta.url), 'utf8'));
    assert.ok(!source.includes('dsh-credentials'), 'credentials.js 不应依赖 dsh-credentials');
});
