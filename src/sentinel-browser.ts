import {existsSync} from "node:fs";
import {chromium, type Browser, type BrowserContext, type Page} from "playwright-core";
import {appConfig} from "./config.js";
import type {DeviceProfile} from "./device-profile.js";

const SENTINEL_FRAME_URL = "https://sentinel.openai.com/backend-api/sentinel/frame.html?sv=20260219f9f6";
const SENTINEL_COOKIE_DOMAIN = "sentinel.openai.com";
const SENTINEL_SCRIPT_READY_TIMEOUT_MS = 20000;

interface BrowserState {
    browserPromise?: Promise<Browser>;
    contextPromise?: Promise<BrowserContext>;
    pagePromise?: Promise<Page>;
    contextProfileKey: string;
}

declare global {
    interface Window {
        SentinelSDK?: {
            token(flow: string): Promise<string>;
        };
    }
}

const states = new Map<string, BrowserState>();

function stateKey(proxyUrl: string, browserPath: string): string {
    return `${browserPath}|||${proxyUrl}`;
}

function resolveBrowserExecutablePath(browserPath?: string): string {
    const candidates = [
        browserPath,
        process.env.SENTINEL_BROWSER_PATH,
        appConfig.sentinelBrowser.path,
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ].filter(Boolean) as string[];

    const matched = candidates.find((candidate) => existsSync(candidate));
    if (!matched) {
        throw new Error("未找到可用浏览器，请设置 [sentinel_browser].path");
    }
    return matched;
}

function buildProxyConfig(rawProxy: string): {server: string; username?: string; password?: string} | undefined {
    const trimmed = rawProxy.trim();
    if (!trimmed) return undefined;
    try {
        const url = new URL(trimmed);
        const protocol = url.protocol.startsWith("socks") ? "http:" : url.protocol;
        const config: {server: string; username?: string; password?: string} = {
            server: `${protocol}//${url.host}`,
        };
        if (url.username) config.username = decodeURIComponent(url.username);
        if (url.password) config.password = decodeURIComponent(url.password);
        return config;
    } catch {
        return {server: trimmed};
    }
}

async function getBrowser(state: BrowserState, proxyUrl: string, browserPath: string): Promise<Browser> {
    if (!state.browserPromise) {
        state.browserPromise = chromium.launch({
            headless: true,
            executablePath: browserPath,
            proxy: buildProxyConfig(proxyUrl),
        });
    }
    return state.browserPromise;
}

function buildProfileKey(profile: DeviceProfile): string {
    return JSON.stringify({
        userAgent: profile.userAgent,
        locale: profile.locale,
        timezoneId: profile.timezoneId,
        viewportWidth: profile.viewportWidth,
        viewportHeight: profile.viewportHeight,
        deviceScaleFactor: profile.deviceScaleFactor,
        isMobile: profile.isMobile,
        hasTouch: profile.hasTouch,
    });
}

async function closeCurrentContext(state: BrowserState): Promise<void> {
    if (state.pagePromise) {
        const page = await state.pagePromise.catch(() => null);
        state.pagePromise = undefined;
        await page?.close().catch(() => undefined);
    }
    if (state.contextPromise) {
        const context = await state.contextPromise.catch(() => null);
        state.contextPromise = undefined;
        await context?.close().catch(() => undefined);
    }
    state.contextProfileKey = "";
}

async function getContext(state: BrowserState, profile: DeviceProfile, proxyUrl: string, browserPath: string): Promise<BrowserContext> {
    const nextProfileKey = buildProfileKey(profile);
    if (state.contextPromise && state.contextProfileKey !== nextProfileKey) {
        await closeCurrentContext(state);
    }

    if (!state.contextPromise) {
        state.contextPromise = (async () => {
            const browser = await getBrowser(state, proxyUrl, browserPath);
            return browser.newContext({
                viewport: {
                    width: profile.viewportWidth,
                    height: profile.viewportHeight,
                },
                screen: {
                    width: profile.screenWidth,
                    height: profile.screenHeight,
                },
                deviceScaleFactor: profile.deviceScaleFactor,
                locale: profile.locale,
                timezoneId: profile.timezoneId,
                userAgent: profile.userAgent,
                isMobile: profile.isMobile,
                hasTouch: profile.hasTouch,
                extraHTTPHeaders: {
                    "accept-language": profile.acceptLanguage,
                    "sec-ch-ua-mobile": profile.isMobile ? "?1" : "?0",
                },
            });
        })().catch((error) => {
            state.contextPromise = undefined;
            state.contextProfileKey = "";
            throw error;
        });
        state.contextProfileKey = nextProfileKey;
    }
    return state.contextPromise;
}

async function getSentinelPage(state: BrowserState, profile: DeviceProfile, proxyUrl: string, browserPath: string): Promise<Page> {
    if (!state.pagePromise) {
        state.pagePromise = (async () => {
            const context = await getContext(state, profile, proxyUrl, browserPath);
            return context.newPage();
        })().catch((error) => {
            state.pagePromise = undefined;
            throw error;
        });
    }
    return state.pagePromise;
}

async function ensureDeviceCookie(page: Page, deviceID: string): Promise<void> {
    await page.context().addCookies([
        {
            name: "oai-did",
            value: deviceID,
            domain: SENTINEL_COOKIE_DOMAIN,
            path: "/",
            secure: true,
            httpOnly: false,
            sameSite: "None",
        },
    ]);
}

async function loadSentinelFrame(page: Page): Promise<void> {
    await page.goto(SENTINEL_FRAME_URL, {
        waitUntil: "domcontentloaded",
        timeout: SENTINEL_SCRIPT_READY_TIMEOUT_MS,
    });
    await page.reload({
        waitUntil: "domcontentloaded",
        timeout: SENTINEL_SCRIPT_READY_TIMEOUT_MS,
    });
    await page.waitForFunction(() => {
        return typeof window.SentinelSDK?.token === "function";
    }, {timeout: SENTINEL_SCRIPT_READY_TIMEOUT_MS});
}

export async function fetchSentinelTokenFromBrowser(
    flow: string,
    deviceID: string,
    profile: DeviceProfile,
    options: {proxyUrl?: string; browserPath?: string} = {},
): Promise<string> {
    const proxyUrl = options.proxyUrl?.trim() || process.env.SENTINEL_BROWSER_PROXY?.trim() || appConfig.defaultProxyUrl || "";
    const browserPath = resolveBrowserExecutablePath(options.browserPath);
    const key = stateKey(proxyUrl, browserPath);
    const state = states.get(key) ?? {contextProfileKey: ""};
    states.set(key, state);

    const page = await getSentinelPage(state, profile, proxyUrl, browserPath);
    await ensureDeviceCookie(page, deviceID);
    await loadSentinelFrame(page);

    const result = await page.evaluate(async ({runtimeFlow}) => {
        if (typeof window.SentinelSDK?.token !== "function") {
            throw new Error("SentinelSDK.token 不可用");
        }
        return await window.SentinelSDK.token(runtimeFlow);
    }, {runtimeFlow: flow});

    if (typeof result !== "string" || !result.trim()) {
        throw new Error(`浏览器 SentinelSDK 返回异常: ${JSON.stringify(result)}`);
    }

    console.log(`browserSentinelTokenSuccess: flow=${flow}`);
    return result;
}
