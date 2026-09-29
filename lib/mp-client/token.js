/**
 * access_token acquisition and caching.
 *
 * WeChat issues one token per app with a two-hour life and a bounded number of daily
 * grants, and a fresh grant invalidates the previous token. Two systems sharing an
 * account therefore evict each other, so the cache is a real correctness concern and
 * not just an optimization.
 * @module
 */
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { WeChatApiError, WeChatTransportError } from "./errors.js";
/** Refresh this far before nominal expiry so an in-flight call cannot straddle it. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const sharedManagers = new Map();

/** Reuse one manager per account/config inside this process so concurrent calls share a refresh. */
export function sharedTokenManager(options) {
    const secretDigest = createHash('sha256').update(options.appSecret).digest('hex').slice(0, 12);
    const key = `${options.baseUrl}\0${options.cacheDir}\0${options.appId}\0${secretDigest}`;
    let manager = sharedManagers.get(key);
    if (manager === undefined) {
        manager = new TokenManager(options);
        sharedManagers.set(key, manager);
    }
    return manager;
}
/**
 * Holds one app's access_token, persisted across processes.
 *
 * The cache filename is derived from a hash of the AppID so the directory never
 * reveals which accounts a machine manages, and so two accounts cannot collide.
 */
export class TokenManager {
    options;
    now;
    fetchImpl;
    cacheFile;
    /** De-duplicates concurrent refreshes within this process. */
    inFlight;
    memory;
    constructor(options) {
        this.options = options;
        this.now = options.now ?? Date.now;
        this.fetchImpl = options.fetchImpl ?? fetch;
        const digest = createHash('sha256').update(options.appId).digest('hex').slice(0, 16);
        this.cacheFile = join(options.cacheDir, `token-${digest}.json`);
    }
    /**
     * Return a usable token, refreshing when the cached one is missing or near expiry.
     * @param signal - cancels an in-flight refresh.
     * @param force - discard the cached token first; used after a token-expiry errcode.
     * @returns the access_token.
     */
    async get(signal, force = false) {
        const rejectedToken = force ? this.memory?.token : undefined;
        if (force) {
            this.memory = undefined;
        }
        else {
            const usable = this.memory ?? await this.readCache();
            if (usable !== undefined && usable.expiresAt - REFRESH_MARGIN_MS > this.now()) {
                this.memory = usable;
                return usable.token;
            }
        }
        // A second caller during a refresh must wait for it rather than burn another
        // daily grant, which would also invalidate the token the first caller is about
        // to receive.
        this.inFlight ??= this.refreshCoordinated(signal, rejectedToken).finally(() => {
            this.inFlight = undefined;
        });
        return this.inFlight;
    }
    async refreshCoordinated(signal, rejectedToken) {
        await mkdir(dirname(this.cacheFile), { recursive: true });
        const lockFile = `${this.cacheFile}.lock`;
        let handle;
        for (let attempt = 0; attempt < 200; attempt++) {
            if (signal?.aborted) throw signal.reason ?? new Error('操作已取消');
            try {
                handle = await open(lockFile, 'wx', 0o600);
                break;
            }
            catch (error) {
                if (error?.code !== 'EEXIST') throw error;
                // A crashed process must not hold token refresh forever.
                const info = await stat(lockFile).catch(() => undefined);
                if (info && this.now() - info.mtimeMs > 30_000) await unlink(lockFile).catch(() => undefined);
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
        if (handle === undefined) throw new Error('等待 access_token 刷新锁超时');
        try {
            const cached = await this.readCache();
            if (cached && cached.expiresAt - REFRESH_MARGIN_MS > this.now() && cached.token !== rejectedToken) {
                this.memory = cached;
                return cached.token;
            }
            return await this.refresh(signal);
        }
        finally {
            await handle.close().catch(() => undefined);
            await unlink(lockFile).catch(() => undefined);
        }
    }
    async readCache() {
        let raw;
        try {
            raw = await readFile(this.cacheFile, 'utf-8');
        }
        catch {
            // No cache yet, or it was cleared: an absent cache is the ordinary first-run
            // state, not a failure worth surfacing.
            return undefined;
        }
        try {
            const parsed = JSON.parse(raw);
            if (typeof parsed.token !== 'string' || typeof parsed.expiresAt !== 'number')
                return undefined;
            return { token: parsed.token, expiresAt: parsed.expiresAt };
        }
        catch {
            // A truncated or hand-edited cache file must not break a render; refetch.
            return undefined;
        }
    }
    async writeCache(entry) {
        await mkdir(dirname(this.cacheFile), { recursive: true });
        // Write-then-rename so a concurrent reader never sees a partial file.
        const temp = `${this.cacheFile}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(entry), { encoding: 'utf-8', mode: 0o600 });
        await rename(temp, this.cacheFile);
    }
    async refresh(signal) {
        const endpoint = '/cgi-bin/token';
        const url = new URL(endpoint, this.options.baseUrl);
        url.searchParams.set('grant_type', 'client_credential');
        url.searchParams.set('appid', this.options.appId);
        url.searchParams.set('secret', this.options.appSecret);
        let response;
        try {
            response = await this.fetchImpl(url, { signal: signal ?? null });
        }
        catch (error) {
            throw new WeChatTransportError(endpoint, error);
        }
        let text;
        try { text = await response.text(); }
        catch (error) { throw new WeChatTransportError(endpoint, error); }
        let body;
        try { body = JSON.parse(text); }
        catch {
            throw new WeChatTransportError(endpoint, new Error(`HTTP ${response.status}: 微信返回了非 JSON 响应`));
        }
        if (!response.ok) {
            throw new WeChatTransportError(endpoint, new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0, 300)}`));
        }
        if (typeof body.errcode === 'number' && body.errcode !== 0) {
            throw new WeChatApiError(body.errcode, body.errmsg ?? '', endpoint);
        }
        if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
            throw new WeChatApiError(-2, `unexpected token response: ${JSON.stringify(body)}`, endpoint);
        }
        const entry = {
            token: body.access_token,
            expiresAt: this.now() + body.expires_in * 1000,
        };
        this.memory = entry;
        // A cache write failure costs an extra grant next process, which is far better
        // than failing the operation the caller actually asked for.
        await this.writeCache(entry).catch(() => undefined);
        return entry.token;
    }
}
