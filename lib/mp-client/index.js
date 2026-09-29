/**
 * WeChat Official Account API client. No Cordis, no harness types (PLAN 决策 2).
 * @module
 */
export { DEFAULT_BASE_URL, MpClient } from "./client.js";
export { explain, WeChatApiError, WeChatTransportError } from "./errors.js";
export { sharedTokenManager, TokenManager } from "./token.js";
