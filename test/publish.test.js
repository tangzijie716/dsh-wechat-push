import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraft, imageSources, prepareBodyImages, replaceImageSource, resolveCoverInput } from '../lib/publish.js';
import { sharedTokenManager, TokenManager } from '../lib/mp-client/token.js';
import { MpClient, WeChatTransportError } from '../lib/mp-client/client.js';

function client() {
    const calls = { image: [], thumb: [], draft: [] };
    return {
        calls,
        async uploadImage(path) { calls.image.push(path); return `https://mmbiz.qpic.cn/${calls.image.length}`; },
        async uploadThumb(path) { calls.thumb.push(path); return 'uploaded-cover'; },
        async addDraft(articles) { calls.draft.push(articles); return `draft-${calls.draft.length}`; },
    };
}

test('image parsing and replacement supports quote, spacing and case variants', () => {
    const html = `<IMG SRC = 'dsh-wechat-image-0'><img src="other">`;
    assert.deepEqual(imageSources(html), ['dsh-wechat-image-0', 'other']);
    assert.match(replaceImageSource(html, 'dsh-wechat-image-0', 'https://mmbiz.qpic.cn/a'), /mmbiz\.qpic\.cn/);
});

test('body image reuses URL, uploads path, and skips empty source', async () => {
    const fake = client();
    const result = await prepareBodyImages(fake,
        `<img src="a"><img src='b'><img src="c">`, [
            { token: 'a', url: 'https://mmbiz.qpic.cn/existing', path: 'unused.png' },
            { token: 'b', path: 'local.png' },
            { token: 'c' },
        ]);
    assert.equal(fake.calls.image.length, 1);
    assert.equal(result.reused, 1);
    assert.equal(result.uploaded, 1);
    assert.deepEqual(result.skipped, ['c']);
    assert.match(result.content, /src="c"/);
});

test('cover media id wins over path without upload', async () => {
    assert.deepEqual(resolveCoverInput({ cover: { media_id: 'known', path: 'cover.png' } }), {
        mediaId: 'known', path: 'cover.png',
    });
    assert.throws(() => resolveCoverInput({ cover: {} }), /需要封面/);
});

test('draft creation validates, reports structured state and suppresses retry', async () => {
    const fake = client();
    const input = {
        title: `unique-${Date.now()}`,
        html: '<p>body</p>',
        cover: { path: 'cover.png' },
        images: [],
    };
    const first = await createDraft(fake, input);
    const second = await createDraft(fake, input);
    assert.equal(first.coverUploaded, true);
    assert.equal(second.deduplicated, true);
    assert.equal(fake.calls.thumb.length, 1);
    assert.equal(fake.calls.draft.length, 1);
    await assert.rejects(() => createDraft(fake, { ...input, title: '' }), /标题不能为空/);
});

test('shared token manager coalesces concurrent refresh', async () => {
    let requests = 0;
    const fetchImpl = async () => {
        requests += 1;
        await new Promise(resolve => setTimeout(resolve, 10));
        return new Response(JSON.stringify({ access_token: 'token', expires_in: 7200 }));
    };
    const options = {
        appId: `app-${Date.now()}`,
        appSecret: 'secret',
        cacheDir: join(tmpdir(), 'dsh-wechat-push-tests'),
        baseUrl: 'https://example.invalid',
        fetchImpl,
    };
    const one = sharedTokenManager(options);
    const two = sharedTokenManager(options);
    assert.equal(one, two);
    assert.deepEqual(await Promise.all([one.get(), two.get()]), ['token', 'token']);
    assert.equal(requests, 1);
});

test('file lock coalesces refresh across separate token managers', async () => {
    let requests = 0;
    const unique = `${Date.now()}-${Math.random()}`;
    const options = {
        appId: `lock-${unique}`,
        appSecret: 'secret',
        cacheDir: join(tmpdir(), `dsh-wechat-push-tests-${unique}`),
        baseUrl: 'https://example.invalid',
        fetchImpl: async () => {
            requests += 1;
            await new Promise(resolve => setTimeout(resolve, 10));
            return new Response(JSON.stringify({ access_token: 'shared', expires_in: 7200 }));
        },
    };
    const one = new TokenManager(options);
    const two = new TokenManager(options);
    assert.deepEqual(await Promise.all([one.get(), two.get()]), ['shared', 'shared']);
    assert.equal(requests, 1);
});

test('HTTP parser reports non-JSON response as transport error', async () => {
    const fake = new MpClient({ appId: 'a', appSecret: 'b', cacheDir: tmpdir(), fetchImpl: async () => new Response('{}') });
    await assert.rejects(
        () => fake.parseResponse(new Response('<html>bad gateway</html>', { status: 502 }), '/draft'),
        error => error instanceof WeChatTransportError && /非 JSON/.test(error.message),
    );
});

test('conflicting modern and legacy cover parameters are rejected', () => {
    assert.throws(() => resolveCoverInput({
        cover: { media_id: 'new' },
        thumb_media_id: 'old',
    }), /封面参数冲突/);
});
