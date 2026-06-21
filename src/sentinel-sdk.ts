export const DEFAULT_SENTINEL_SDK_URL = "https://sentinel.openai.com/sentinel/20260219f9f6/sdk.js";

export const SENTINEL_SDK_PATCH_HOOK = "t.init=we,t.sessionObserverToken=async function(t){";

export const SENTINEL_SDK_PATCH_REPLACEMENT =
    "t.__codexTurnstileDx=function(requirements,key,dx){D(requirements,key);return _n(requirements,dx)},t.init=we,t.sessionObserverToken=async function(t){";

export function validateSentinelSdkSource(source: string): void {
    if (!source.includes("SentinelSDK")) {
        throw new Error("下载内容不像 Sentinel SDK：缺少 SentinelSDK");
    }
    if (!source.includes(SENTINEL_SDK_PATCH_HOOK)) {
        throw new Error("下载的 sdk.js 不包含当前 VM patch hook，需更新 sentinel.ts 的 patch 逻辑");
    }
}
