import {existsSync, readFileSync} from "node:fs";
import path from "node:path";
import {DEFAULT_SENTINEL_SDK_URL} from "./sentinel-sdk.js";

export interface RunConfig {
    total: number;
    concurrency: number;
    maxPhoneTries: number;
    useBrowserSentinel: boolean;
    runUntilEmpty: boolean;
    memorySoftLimitMb: number;
    memoryHardLimitMb: number;
}

export interface OpenAIConfig {
    defaultPassword: string;
    saveAuthJson: boolean;
}

export interface HeroSMSConfig {
    apiKey: string;
    countries: number[];
    acquirePriority: "country" | "price_low" | "price_high";
    minPrice: number;
    maxPrice: number;
    priceStep: number;
    pollIntervalMs: number;
    maxPhoneTries: number;
    autoReleaseOnTimeout: boolean;
}

export interface EmailPoolConfig {
    source: string;
    success: string;
    inflight: string;
    failed: string;
    lock: string;
}

export interface SentinelBrowserConfig {
    path: string;
}

export interface SentinelSdkConfig {
    url: string;
    file: string;
}

export interface CpaJsonConfig {
    dir: string;
}

export interface AppConfig {
    run: RunConfig;
    openai: OpenAIConfig;
    heroSMS: HeroSMSConfig;
    emailPool: EmailPoolConfig;
    cpaJson: CpaJsonConfig;
    proxies: string[];
    sentinelBrowser: SentinelBrowserConfig;
    sentinelSdk: SentinelSdkConfig;
    defaultProxyUrl: string;
    defaultPassword: string;
}

type TomlValue = string | number | boolean | string[] | number[];
type TomlObject = Record<string, Record<string, TomlValue>>;

const DEFAULT_CONFIG: AppConfig = {
    run: {
        total: 1,
        concurrency: 1,
        maxPhoneTries: 20,
        useBrowserSentinel: false,
        runUntilEmpty: false,
        memorySoftLimitMb: 0,
        memoryHardLimitMb: 0,
    },
    openai: {
        defaultPassword: "change-this-password",
        saveAuthJson: false,
    },
    heroSMS: {
        apiKey: "",
        countries: [33],
        acquirePriority: "country",
        minPrice: 0.45,
        maxPrice: 0.5,
        priceStep: 0.01,
        pollIntervalMs: 3000,
        maxPhoneTries: 20,
        autoReleaseOnTimeout: true,
    },
    emailPool: {
        source: "email.txt",
        success: "email.success.txt",
        inflight: "email.inflight.txt",
        failed: "email.failed.txt",
        lock: ".email.lock",
    },
    cpaJson: {
        dir: "cpa_json",
    },
    proxies: [],
    sentinelBrowser: {
        path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
    sentinelSdk: {
        url: DEFAULT_SENTINEL_SDK_URL,
        file: "sdk.js",
    },
    defaultProxyUrl: "",
    defaultPassword: "change-this-password",
};

function stripInlineComment(line: string): string {
    let inString = false;
    let escaped = false;
    let bracketDepth = 0;
    let out = "";

    for (const ch of line) {
        if (escaped) {
            out += ch;
            escaped = false;
            continue;
        }
        if (ch === "\\" && inString) {
            out += ch;
            escaped = true;
            continue;
        }
        if (ch === "\"") {
            inString = !inString;
            out += ch;
            continue;
        }
        if (!inString) {
            if (ch === "[") bracketDepth += 1;
            if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
            if (ch === "#" && bracketDepth === 0) break;
        }
        out += ch;
    }
    return out.trim();
}

function parseTomlValue(rawValue: string): TomlValue {
    const value = rawValue.trim();
    if (value.startsWith("\"") && value.endsWith("\"")) {
        return value.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
    }
    if (value === "true") return true;
    if (value === "false") return false;
    if (value.startsWith("[") && value.endsWith("]")) {
        const inner = value.slice(1, -1).trim();
        if (!inner) return [];
        const items = splitArrayItems(inner).map(parseTomlValue);
        if (items.every((item): item is number => typeof item === "number")) return items;
        if (items.every((item): item is string => typeof item === "string")) return items;
        throw new Error(`TOML 数组只支持纯 string 或纯 number: ${value}`);
    }
    const numberValue = Number(value);
    if (Number.isFinite(numberValue)) {
        return numberValue;
    }
    throw new Error(`无法解析 TOML 值: ${value}`);
}

function splitArrayItems(inner: string): string[] {
    const items: string[] = [];
    let current = "";
    let inString = false;
    let escaped = false;
    for (const ch of inner) {
        if (escaped) {
            current += ch;
            escaped = false;
            continue;
        }
        if (ch === "\\" && inString) {
            current += ch;
            escaped = true;
            continue;
        }
        if (ch === "\"") {
            inString = !inString;
            current += ch;
            continue;
        }
        if (ch === "," && !inString) {
            items.push(current.trim());
            current = "";
            continue;
        }
        current += ch;
    }
    if (current.trim()) {
        items.push(current.trim());
    }
    return items;
}

export function parseToml(raw: string): TomlObject {
    const result: TomlObject = {};
    let section = "";
    for (const originalLine of raw.split(/\r?\n/)) {
        const line = stripInlineComment(originalLine);
        if (!line) continue;
        const sectionMatch = line.match(/^\[([A-Za-z0-9_.-]+)]$/);
        if (sectionMatch) {
            section = sectionMatch[1];
            result[section] ??= {};
            continue;
        }
        const eqIndex = line.indexOf("=");
        if (eqIndex < 0 || !section) {
            throw new Error(`TOML 行格式错误: ${originalLine}`);
        }
        const key = line.slice(0, eqIndex).trim();
        const value = parseTomlValue(line.slice(eqIndex + 1));
        result[section][key] = value;
    }
    return result;
}

function stringValue(value: TomlValue | undefined, fallback: string): string {
    return typeof value === "string" ? value.trim() : fallback;
}

function numberValue(value: TomlValue | undefined, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: TomlValue | undefined, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

function stringArrayValue(value: TomlValue | undefined): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
}

function numberArrayValue(value: TomlValue | undefined): number[] {
    if (!Array.isArray(value)) return [];
    const items = value.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
    return items;
}

function positiveNumber(value: number, fallback: number): number {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(value: number, fallback: number): number {
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeAcquirePriority(value: TomlValue | undefined, fallback: HeroSMSConfig["acquirePriority"]): HeroSMSConfig["acquirePriority"] {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (normalized === "country") return "country";
    if (normalized === "price" || normalized === "price_low") return "price_low";
    if (normalized === "price_high") return "price_high";
    return fallback;
}

function pathValue(value: TomlValue | undefined, fallback: string, baseDir: string): string {
    const raw = stringValue(value, fallback);
    return path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw);
}

function resolveConfigPath(configPath = path.resolve(process.cwd(), "config.toml")): string {
    return process.env.FREE_REGISTER_CONFIG?.trim() || configPath;
}

function envString(name: string): string {
    return process.env[name]?.trim() ?? "";
}

function envNumber(name: string): number | null {
    const raw = envString(name);
    if (!raw) return null;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : null;
}

function envBoolean(name: string): boolean | null {
    const raw = envString(name).toLowerCase();
    if (!raw) return null;
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
    return null;
}

function applyEnvOverrides(config: AppConfig): AppConfig {
    const heroSMSApiKey = envString("FREE_REGISTER_HERO_SMS_API_KEY");
    const defaultPassword = envString("FREE_REGISTER_DEFAULT_PASSWORD");
    const saveAuthJson = envBoolean("FREE_REGISTER_SAVE_AUTH_JSON");
    const total = envNumber("FREE_REGISTER_TOTAL");
    const concurrency = envNumber("FREE_REGISTER_CONCURRENCY");
    const maxPhoneTries = envNumber("FREE_REGISTER_MAX_PHONE_TRIES");
    const useBrowserSentinel = envBoolean("FREE_REGISTER_USE_BROWSER_SENTINEL");
    const runUntilEmpty = envBoolean("FREE_REGISTER_RUN_UNTIL_EMPTY");
    const emailPoolDir = envString("FREE_REGISTER_EMAIL_POOL_DIR");
    const cpaJsonDir = envString("FREE_REGISTER_CPA_JSON_DIR");
    const sentinelSdkUrl = envString("FREE_REGISTER_SENTINEL_SDK_URL");
    const sentinelSdkFile = envString("FREE_REGISTER_SENTINEL_SDK_FILE");

    const next: AppConfig = {
        ...config,
        run: {
            ...config.run,
            total: total ?? config.run.total,
            concurrency: concurrency ?? config.run.concurrency,
            maxPhoneTries: maxPhoneTries ?? config.run.maxPhoneTries,
            useBrowserSentinel: useBrowserSentinel ?? config.run.useBrowserSentinel,
            runUntilEmpty: runUntilEmpty ?? config.run.runUntilEmpty,
        },
        heroSMS: {
            ...config.heroSMS,
            apiKey: heroSMSApiKey || config.heroSMS.apiKey,
            maxPhoneTries: maxPhoneTries ?? config.heroSMS.maxPhoneTries,
        },
        openai: {
            ...config.openai,
            defaultPassword: defaultPassword || config.openai.defaultPassword,
            saveAuthJson: saveAuthJson ?? config.openai.saveAuthJson,
        },
        proxies: config.proxies,
        cpaJson: {
            ...config.cpaJson,
            dir: cpaJsonDir ? path.resolve(cpaJsonDir) : config.cpaJson.dir,
        },
        sentinelSdk: {
            ...config.sentinelSdk,
            url: sentinelSdkUrl || config.sentinelSdk.url,
            file: sentinelSdkFile || config.sentinelSdk.file,
        },
    };

    if (emailPoolDir) {
        const dir = path.resolve(emailPoolDir);
        next.emailPool = {
            source: path.join(dir, path.basename(config.emailPool.source)),
            success: path.join(dir, path.basename(config.emailPool.success)),
            inflight: path.join(dir, path.basename(config.emailPool.inflight)),
            failed: path.join(dir, path.basename(config.emailPool.failed)),
            lock: path.join(dir, path.basename(config.emailPool.lock)),
        };
    }

    next.defaultProxyUrl = next.proxies[0] ?? "";
    next.defaultPassword = next.openai.defaultPassword;
    return next;
}

export function loadConfig(configPath = resolveConfigPath()): AppConfig {
    const parsed = existsSync(configPath) ? parseToml(readFileSync(configPath, "utf8")) : {};
    const configDir = path.dirname(path.resolve(configPath));
    const run = parsed.run ?? {};
    const openai = parsed.openai ?? {};
    const hero = parsed.hero_sms ?? {};
    const emailPool = parsed.email_pool ?? {};
    const cpaJson = parsed.cpa_json ?? {};
    const proxies = parsed.proxies ?? {};
    const sentinelBrowser = parsed.sentinel_browser ?? {};
    const sentinelSdk = parsed.sentinel_sdk ?? {};

    const proxyUrls = stringArrayValue(proxies.urls);
    const openAIConfig: OpenAIConfig = {
        defaultPassword: stringValue(openai.default_password, DEFAULT_CONFIG.openai.defaultPassword),
        saveAuthJson: booleanValue(openai.save_auth_json, DEFAULT_CONFIG.openai.saveAuthJson),
    };
    const runMaxPhoneTries = positiveInteger(numberValue(run.max_phone_tries, DEFAULT_CONFIG.run.maxPhoneTries), DEFAULT_CONFIG.run.maxPhoneTries);
    const configuredCountries = numberArrayValue(hero.countries);
    const legacyCountry = positiveInteger(numberValue(hero.country, DEFAULT_CONFIG.heroSMS.countries[0] ?? 33), DEFAULT_CONFIG.heroSMS.countries[0] ?? 33);
    const legacyPriceTiers = numberArrayValue(hero.price_tiers);
    const minPrice = positiveNumber(
        numberValue(hero.min_price, legacyPriceTiers.length ? Math.min(...legacyPriceTiers) : DEFAULT_CONFIG.heroSMS.minPrice),
        DEFAULT_CONFIG.heroSMS.minPrice,
    );
    const maxPrice = positiveNumber(numberValue(hero.max_price, DEFAULT_CONFIG.heroSMS.maxPrice), DEFAULT_CONFIG.heroSMS.maxPrice);

    const config: AppConfig = {
        run: {
            total: positiveInteger(numberValue(run.total, DEFAULT_CONFIG.run.total), DEFAULT_CONFIG.run.total),
            concurrency: positiveInteger(numberValue(run.concurrency, DEFAULT_CONFIG.run.concurrency), DEFAULT_CONFIG.run.concurrency),
            maxPhoneTries: runMaxPhoneTries,
            useBrowserSentinel: booleanValue(run.use_browser_sentinel, DEFAULT_CONFIG.run.useBrowserSentinel),
            runUntilEmpty: booleanValue(run.run_until_empty, DEFAULT_CONFIG.run.runUntilEmpty),
            memorySoftLimitMb: Math.max(0, Math.floor(numberValue(run.memory_soft_limit_mb, DEFAULT_CONFIG.run.memorySoftLimitMb))),
            memoryHardLimitMb: Math.max(0, Math.floor(numberValue(run.memory_hard_limit_mb, DEFAULT_CONFIG.run.memoryHardLimitMb))),
        },
        openai: openAIConfig,
        heroSMS: {
            apiKey: stringValue(hero.api_key, DEFAULT_CONFIG.heroSMS.apiKey),
            countries: configuredCountries.length ? configuredCountries : [legacyCountry],
            acquirePriority: normalizeAcquirePriority(hero.acquire_priority, DEFAULT_CONFIG.heroSMS.acquirePriority),
            minPrice,
            maxPrice,
            priceStep: positiveNumber(numberValue(hero.price_step, DEFAULT_CONFIG.heroSMS.priceStep), DEFAULT_CONFIG.heroSMS.priceStep),
            pollIntervalMs: positiveInteger(numberValue(hero.poll_interval_ms, DEFAULT_CONFIG.heroSMS.pollIntervalMs), DEFAULT_CONFIG.heroSMS.pollIntervalMs),
            maxPhoneTries: positiveInteger(numberValue(hero.max_phone_tries, runMaxPhoneTries), runMaxPhoneTries),
            autoReleaseOnTimeout: booleanValue(hero.auto_release_on_timeout, DEFAULT_CONFIG.heroSMS.autoReleaseOnTimeout),
        },
        emailPool: {
            source: stringValue(emailPool.source, DEFAULT_CONFIG.emailPool.source),
            success: stringValue(emailPool.success, DEFAULT_CONFIG.emailPool.success),
            inflight: stringValue(emailPool.inflight, DEFAULT_CONFIG.emailPool.inflight),
            failed: stringValue(emailPool.failed, DEFAULT_CONFIG.emailPool.failed),
            lock: stringValue(emailPool.lock, DEFAULT_CONFIG.emailPool.lock),
        },
        cpaJson: {
            dir: pathValue(cpaJson.dir, DEFAULT_CONFIG.cpaJson.dir, configDir),
        },
        proxies: proxyUrls,
        sentinelBrowser: {
            path: stringValue(sentinelBrowser.path, DEFAULT_CONFIG.sentinelBrowser.path),
        },
        sentinelSdk: {
            url: stringValue(sentinelSdk.url, DEFAULT_CONFIG.sentinelSdk.url),
            file: stringValue(sentinelSdk.file, DEFAULT_CONFIG.sentinelSdk.file),
        },
        defaultProxyUrl: proxyUrls[0] ?? "",
        defaultPassword: openAIConfig.defaultPassword,
    };
    return applyEnvOverrides(config);
}

export function applyCliOverrides(config: AppConfig, argv = process.argv.slice(2)): AppConfig {
    const total = readNumberArg(argv, "--total");
    const concurrency = readNumberArg(argv, "--concurrency");
    const maxPhoneTries = readNumberArg(argv, "--max-phone-tries");
    const runUntilEmpty = argv.includes("--run-until-empty")
        ? true
        : argv.includes("--no-run-until-empty")
            ? false
            : config.run.runUntilEmpty;
    return {
        ...config,
        run: {
            ...config.run,
            total: total ?? config.run.total,
            concurrency: concurrency ?? config.run.concurrency,
            maxPhoneTries: maxPhoneTries ?? config.run.maxPhoneTries,
            runUntilEmpty,
        },
        heroSMS: {
            ...config.heroSMS,
            maxPhoneTries: maxPhoneTries ?? config.heroSMS.maxPhoneTries,
        },
    };
}

export function readArgValue(argv: string[], flag: string): string {
    const index = argv.indexOf(flag);
    if (index < 0) return "";
    return argv[index + 1] ?? "";
}

function readNumberArg(argv: string[], flag: string): number | null {
    const raw = readArgValue(argv, flag).trim();
    if (!raw) return null;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : null;
}

export function proxyForWorker(config: AppConfig, workerIndex: number): string {
    if (!config.proxies.length) return "";
    return config.proxies[workerIndex % config.proxies.length];
}

export function redactProxy(proxyUrl: string): string {
    if (!proxyUrl) return "direct";
    try {
        const url = new URL(proxyUrl);
        if (url.username || url.password) {
            url.username = "***";
            url.password = "***";
        }
        return url.toString();
    } catch {
        return proxyUrl.replace(/\/\/([^/@:]+):([^/@]+)@/, "//***:***@");
    }
}

export const appConfig = loadConfig();
