import {createHash, randomBytes, timingSafeEqual} from "node:crypto";
import {createServer, type IncomingMessage, type ServerResponse} from "node:http";
import {mkdir, readFile, readdir, rename, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import {removeSuccessCostRecords, successCostLinesForEmails, summarizeSuccessCosts} from "./cost.js";
import {EmailPool, emailFromLine} from "./email-pool.js";
import {heroSmsProxyForWorker, loadConfig, parseToml, redactProxy, type AppConfig, type HeroSMSConfig, type HeroSMSProxyStrategy, type ProxyMode} from "./config.js";
import {RegisterTaskRunner, type RegisterLogger} from "./runner.js";
import {disableHeroSmsApiKey, enableHeroSmsApiKeyIfReason, getHeroSmsRpsStats} from "./sms/index.js";
import {createHeroSmsProvider, fixedHeroSmsPollAttempts, type HeroSmsCountry} from "./sms/heroSMS.js";
import {extractHeroSmsCountryName} from "./phone-country-proxy.js";
import {formatUtc8Timestamp} from "./utils.js";

type JsonValue = null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue};
type LogLevel = "info" | "warn" | "error";

interface LogEntry {
    id: number;
    time: string;
    level: LogLevel;
    message: string;
}

interface HeroSmsCountryOption {
    id: number;
    label: string;
    english?: string;
}

interface HeroSmsCountriesStatus {
    source: "api" | "fallback";
    countries: HeroSmsCountryOption[];
    fetchedAt: string;
    error?: string;
    cached?: boolean;
}

const DEFAULT_PORT = 8788;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_LOG_LINES = 10000;
const MAX_LOG_LINE_CHARS = 2000;
const MAX_LOG_BACKLOG_LINES = 300;
const LOG_BROADCAST_INTERVAL_MS = 250;
const MAX_LOG_BROADCAST_BATCH = 500;
const MAX_SSE_WRITABLE_BUFFER_BYTES = 1024 * 1024;
const SESSION_COOKIE = "fr_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_STORE_VERSION = 1;
const SESSION_PERSIST_FILE = ".admin-sessions.json";
const SESSION_PERSIST_THROTTLE_MS = 30 * 1000;
const HERO_SMS_BALANCE_TTL_MS = 30 * 1000;
const HERO_SMS_BALANCE_TIMEOUT_MS = 5000;
const HERO_SMS_COUNTRIES_TIMEOUT_MS = 10000;
const HERO_SMS_COUNTRIES_CACHE_VERSION = 1;
const HERO_SMS_COUNTRIES_CACHE_FILE = path.join(".cache", "hero-sms-countries.json");
const SUCCESS_EXPORT_SNAPSHOT_TTL_MS = 30 * 60 * 1000;
const VENDOR_ASSETS: Record<string, {file: string; contentType: string}> = {
    "/vendor/codemirror/codemirror.css": {
        file: "node_modules/codemirror/lib/codemirror.css",
        contentType: "text/css; charset=utf-8",
    },
    "/vendor/codemirror/codemirror.js": {
        file: "node_modules/codemirror/lib/codemirror.js",
        contentType: "application/javascript; charset=utf-8",
    },
    "/vendor/codemirror/toml.js": {
        file: "node_modules/codemirror/mode/toml/toml.js",
        contentType: "application/javascript; charset=utf-8",
    },
};
const HERO_SMS_FALLBACK_COUNTRIES = [
    {id: 4, label: "菲律宾 (Philippines)"},
    {id: 6, label: "印度尼西亚 (Indonesia)"},
    {id: 8, label: "肯尼亚 (Kenya)"},
    {id: 10, label: "越南 (Vietnam)"},
    {id: 15, label: "波兰 (Poland)"},
    {id: 16, label: "英国 (United Kingdom)"},
    {id: 32, label: "罗马尼亚 (Romania)"},
    {id: 33, label: "哥伦比亚 (Colombia)"},
    {id: 43, label: "德国 (Germany)"},
    {id: 52, label: "泰国 (Thailand)"},
    {id: 73, label: "巴西 (Brazil)"},
    {id: 78, label: "法国 (France)"},
    {id: 151, label: "智利 (Chile)"},
    {id: 182, label: "日本 (Japan)"},
    {id: 187, label: "美国（物理) (USA)"},
];

interface SuccessExportSnapshot {
    emails: string[];
    createdAt: number;
    expiresAt: number;
}

const successExportSnapshots = new Map<string, SuccessExportSnapshot>();

class LogBuffer implements RegisterLogger {
    private readonly lines: LogEntry[] = [];
    private readonly subscribers = new Map<number, ServerResponse>();
    private readonly pendingBroadcasts: LogEntry[] = [];
    private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
    private nextId = 1;
    private nextSubscriberId = 1;

    info(message: string): void {
        console.log(message);
    }

    warn(message: string): void {
        console.warn(message);
    }

    error(message: string): void {
        console.error(message);
    }

    recent(limit = 250): JsonValue {
        return this.lines.slice(-limit) as unknown as JsonValue;
    }

    recentAfter(lastId: number, limit = 250): LogEntry[] {
        const matched = this.lines.filter((line) => line.id > lastId);
        return matched.slice(-limit);
    }

    capture(level: LogLevel, args: unknown[]): void {
        this.add(level, formatConsoleArgs(args));
    }

    subscribe(res: ServerResponse): () => void {
        const id = this.nextSubscriberId;
        this.nextSubscriberId += 1;
        this.subscribers.set(id, res);
        return () => {
            this.subscribers.delete(id);
        };
    }

    private add(level: LogLevel, message: string): void {
        const time = formatUtc8Timestamp();
        for (const line of String(message).split(/\r?\n/)) {
            const entry = {
                id: this.nextId,
                time,
                level,
                message: truncateLogLine(line),
            };
            this.nextId += 1;
            this.lines.push(entry);
            this.queueBroadcast(entry);
        }
        if (this.lines.length > MAX_LOG_LINES) {
            this.lines.splice(0, this.lines.length - MAX_LOG_LINES);
        }
    }

    private queueBroadcast(entry: LogEntry): void {
        if (!this.subscribers.size) {
            return;
        }
        this.pendingBroadcasts.push(entry);
        if (this.pendingBroadcasts.length >= MAX_LOG_BROADCAST_BATCH) {
            this.flushBroadcasts();
            return;
        }
        if (!this.broadcastTimer) {
            this.broadcastTimer = setTimeout(() => this.flushBroadcasts(), LOG_BROADCAST_INTERVAL_MS);
        }
    }

    private flushBroadcasts(): void {
        if (this.broadcastTimer) {
            clearTimeout(this.broadcastTimer);
            this.broadcastTimer = null;
        }

        if (!this.pendingBroadcasts.length) {
            return;
        }

        const entries = this.pendingBroadcasts.splice(0, MAX_LOG_BROADCAST_BATCH);
        this.broadcast(sseEntries(entries));
        if (this.pendingBroadcasts.length) {
            this.broadcastTimer = setTimeout(() => this.flushBroadcasts(), 0);
        }
    }

    private broadcast(payload: string): void {
        if (!payload) return;
        for (const [id, res] of this.subscribers) {
            if (res.destroyed || res.writableEnded) {
                this.subscribers.delete(id);
                continue;
            }
            if (res.writableLength > MAX_SSE_WRITABLE_BUFFER_BYTES) {
                res.end();
                this.subscribers.delete(id);
                continue;
            }
            res.write(payload);
        }
    }
}

const logger = new LogBuffer();
const runner = new RegisterTaskRunner(logger);
const sessions = new Map<string, number>();
let sessionPersistTimer: ReturnType<typeof setTimeout> | null = null;
let sessionPersistPromise: Promise<void> = Promise.resolve();
let heroSmsBalanceCache: {key: string; expiresAt: number; value: JsonValue} | null = null;
let heroSmsBalanceInFlight: {key: string; promise: Promise<JsonValue>} | null = null;
let heroSmsCountriesCache: HeroSmsCountriesStatus | null = null;
let heroSmsCountriesInFlight: Promise<HeroSmsCountriesStatus> | null = null;
const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
};

function installConsoleCapture(): void {
    console.log = (...args: unknown[]) => {
        logger.capture("info", args);
        originalConsole.log(...args);
    };
    console.warn = (...args: unknown[]) => {
        logger.capture("warn", args);
        originalConsole.warn(...args);
    };
    console.error = (...args: unknown[]) => {
        logger.capture("error", args);
        originalConsole.error(...args);
    };
}

function truncateLogLine(line: string): string {
    return line.length > MAX_LOG_LINE_CHARS ? `${line.slice(0, MAX_LOG_LINE_CHARS)}...` : line;
}

function formatConsoleArgs(args: unknown[]): string {
    return args.map((arg) => {
        if (typeof arg === "string") return arg;
        if (arg instanceof Error) return arg.stack || arg.message;
        try {
            return JSON.stringify(arg);
        } catch {
            return String(arg);
        }
    }).join(" ");
}

function sseEntries(entries: LogEntry[]): string {
    if (!entries.length) return "";
    const lastId = entries[entries.length - 1]?.id ?? 0;
    return `id: ${lastId}\nevent: logs\ndata: ${JSON.stringify(entries)}\n\n`;
}

function configPath(): string {
    return process.env.FREE_REGISTER_CONFIG?.trim() || path.resolve(process.cwd(), "config.toml");
}

function adminPassword(): string {
    return process.env.FREE_REGISTER_ADMIN_PASSWORD?.trim() || "changeme";
}

function adminPort(): number {
    const raw = process.env.FREE_REGISTER_ADMIN_PORT?.trim() || "";
    const port = Number.parseInt(raw, 10);
    return Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT;
}

function sessionStorePath(): string {
    const configured = process.env.FREE_REGISTER_SESSION_FILE?.trim();
    if (configured) return configured;
    return path.join(path.dirname(configPath()), SESSION_PERSIST_FILE);
}

function hashSessionToken(token: string): string {
    return createHash("sha256").update(adminPassword()).update("\0").update(token).digest("hex");
}

function pruneExpiredSessions(now = Date.now()): number {
    let removed = 0;
    for (const [tokenHash, expiresAt] of sessions) {
        if (!Number.isFinite(expiresAt) || now > expiresAt) {
            sessions.delete(tokenHash);
            removed += 1;
        }
    }
    return removed;
}

async function loadPersistentSessions(): Promise<void> {
    const file = sessionStorePath();
    try {
        const raw = await readFile(file, "utf8");
        const payload = JSON.parse(raw) as {
            version?: unknown;
            sessions?: unknown;
        };
        if (payload.version !== SESSION_STORE_VERSION || !Array.isArray(payload.sessions)) {
            logger.warn(`[admin] session 文件格式不兼容，已忽略: ${file}`);
            return;
        }
        const now = Date.now();
        let loaded = 0;
        for (const item of payload.sessions) {
            if (!item || typeof item !== "object") continue;
            const tokenHash = (item as {tokenHash?: unknown}).tokenHash;
            const expiresAt = (item as {expiresAt?: unknown}).expiresAt;
            if (typeof tokenHash !== "string" || !/^[a-f0-9]{64}$/i.test(tokenHash)) continue;
            if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || now > expiresAt) continue;
            sessions.set(tokenHash, expiresAt);
            loaded += 1;
        }
        if (loaded > 0) {
            logger.info(`[admin] 已恢复登录态 sessions=${loaded}`);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        logger.warn(`[admin] session 文件读取失败，将重新登录: ${(error as Error).message}`);
    }
    if (pruneExpiredSessions() > 0) {
        scheduleSessionPersist();
    }
}

async function writePersistentSessions(): Promise<void> {
    pruneExpiredSessions();
    const payload = {
        version: SESSION_STORE_VERSION,
        updatedAt: new Date().toISOString(),
        sessions: Array.from(sessions.entries()).map(([tokenHash, expiresAt]) => ({tokenHash, expiresAt})),
    };
    await writeFileAtomic(sessionStorePath(), `${JSON.stringify(payload, null, 2)}\n`);
}

function scheduleSessionPersist(): void {
    if (sessionPersistTimer) return;
    sessionPersistTimer = setTimeout(() => {
        sessionPersistTimer = null;
        flushSessionPersist();
    }, SESSION_PERSIST_THROTTLE_MS);
    sessionPersistTimer.unref?.();
}

async function flushSessionPersist(): Promise<void> {
    if (sessionPersistTimer) {
        clearTimeout(sessionPersistTimer);
        sessionPersistTimer = null;
    }
    sessionPersistPromise = sessionPersistPromise
        .catch(() => undefined)
        .then(() => writePersistentSessions());
    try {
        await sessionPersistPromise;
    } catch (error) {
        logger.warn(`[admin] session 文件保存失败: ${(error as Error).message}`);
    }
}

function safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(createHash("sha256").update(a).digest("hex"));
    const right = Buffer.from(createHash("sha256").update(b).digest("hex"));
    return timingSafeEqual(left, right);
}

function parseCookies(req: IncomingMessage): Record<string, string> {
    const header = req.headers.cookie ?? "";
    const cookies: Record<string, string> = {};
    for (const part of header.split(";")) {
        const index = part.indexOf("=");
        if (index < 0) continue;
        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (key) cookies[key] = decodeURIComponent(value);
    }
    return cookies;
}

function isAuthenticated(req: IncomingMessage): boolean {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token) return false;
    const tokenHash = hashSessionToken(token);
    const expiresAt = sessions.get(tokenHash);
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) {
        sessions.delete(tokenHash);
        scheduleSessionPersist();
        return false;
    }
    sessions.set(tokenHash, Date.now() + SESSION_TTL_MS);
    scheduleSessionPersist();
    return true;
}

function send(res: ServerResponse, statusCode: number, body: string | Buffer, headers: Record<string, string> = {}): void {
    res.writeHead(statusCode, {
        "cache-control": "no-store",
        ...headers,
    });
    res.end(body);
}

function sendJson(res: ServerResponse, statusCode: number, data: JsonValue): void {
    send(res, statusCode, JSON.stringify(data), {"content-type": "application/json; charset=utf-8"});
}

function isRunnerBusy(): boolean {
    const snapshot = runner.getSnapshot();
    return snapshot.activeWorkers > 0 || snapshot.status === "running" || snapshot.status === "pausing" || snapshot.status === "force_pausing";
}

function sendError(res: ServerResponse, statusCode: number, message: string): void {
    sendJson(res, statusCode, {ok: false, error: message});
}

async function sendVendorAsset(res: ServerResponse, pathname: string): Promise<boolean> {
    const asset = VENDOR_ASSETS[pathname];
    if (!asset) return false;
    const body = await readFile(path.resolve(process.cwd(), asset.file));
    send(res, 200, body, {
        "cache-control": "public, max-age=86400",
        "content-type": asset.contentType,
    });
    return true;
}

function sendLogStream(req: IncomingMessage, res: ServerResponse): void {
    const rawLastId = req.headers["last-event-id"];
    const lastId = typeof rawLastId === "string" ? Number.parseInt(rawLastId, 10) : 0;
    res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "connection": "keep-alive",
        "x-accel-buffering": "no",
    });

    const backlog = Number.isFinite(lastId) && lastId > 0
        ? logger.recentAfter(lastId, MAX_LOG_BACKLOG_LINES)
        : logger.recent(MAX_LOG_BACKLOG_LINES) as unknown as LogEntry[];
    if (backlog.length) {
        res.write(sseEntries(backlog));
    }
    res.write(`event: ready\ndata: ${JSON.stringify({ok: true})}\n\n`);

    const heartbeat = setInterval(() => {
        if (res.destroyed || res.writableEnded) {
            clearInterval(heartbeat);
            return;
        }
        res.write(`: heartbeat ${Date.now()}\n\n`);
    }, 25000);

    const unsubscribe = logger.subscribe(res);
    req.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
    });
}

async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_BODY_BYTES) {
            throw new Error("请求体太大");
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
}

async function readJson<T extends Record<string, unknown>>(req: IncomingMessage): Promise<T> {
    const raw = await readBody(req);
    if (!raw.trim()) return {} as T;
    return JSON.parse(raw) as T;
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
    await mkdir(path.dirname(filePath), {recursive: true});
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, filePath);
}

function formatTomlValue(value: string | number | boolean | string[] | number[]): string {
    if (Array.isArray(value)) return `[${value.map((item) => typeof item === "string" ? JSON.stringify(item) : String(item)).join(", ")}]`;
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "boolean") return value ? "true" : "false";
    return String(value);
}

function upsertTomlSection(raw: string, section: string, values: Record<string, string | number | boolean | string[] | number[]>, removeKeys: string[] = []): string {
    const lines = raw.split(/\r?\n/);
    const sectionHeader = `[${section}]`;
    const sectionStart = lines.findIndex((line) => line.trim() === sectionHeader);
    const keys = new Set([...Object.keys(values), ...removeKeys]);

    if (sectionStart < 0) {
        const body = Object.entries(values).map(([key, value]) => `${key} = ${formatTomlValue(value)}`);
        return `${raw.trimEnd()}\n\n${sectionHeader}\n${body.join("\n")}\n`;
    }

    let sectionEnd = lines.length;
    for (let index = sectionStart + 1; index < lines.length; index += 1) {
        if (/^\s*\[[^\]]+]\s*$/.test(lines[index])) {
            sectionEnd = index;
            break;
        }
    }

    const nextSectionLines = lines.slice(sectionStart, sectionEnd).filter((line, index) => {
        if (index === 0) return true;
        const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
        if (!match) return true;
        const key = match[1];
        if (!keys.has(key)) return true;
        return false;
    });

    for (const [key, value] of Object.entries(values)) {
        nextSectionLines.push(`${key} = ${formatTomlValue(value)}`);
    }

    const nextLines = [
        ...lines.slice(0, sectionStart),
        ...nextSectionLines,
        ...lines.slice(sectionEnd),
    ];
    return `${nextLines.join("\n").trimEnd()}\n`;
}

function smsConfigJson(config: AppConfig): JsonValue {
    return {
        ...config.heroSMS,
        apiKey: config.heroSMS.apiKey ? redactHeroSmsApiKey(config.heroSMS.apiKey, 0) : "",
        apiKeys: config.heroSMS.apiKeys.map(redactHeroSmsApiKey),
        countries: config.heroSMS.countries,
        proxyUrls: config.heroSMS.proxyUrls,
        pollAttempts: fixedHeroSmsPollAttempts(config.heroSMS.pollIntervalMs),
    } as unknown as JsonValue;
}

function redactHeroSmsApiKey(apiKey: string, index: number): string {
    const tail = String(apiKey ?? "").trim().slice(-4) || "empty";
    return `Key #${index + 1} ****${tail}`;
}

function numberFromBody(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function integerFromBody(value: unknown, fallback: number): number {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function countriesFromBody(value: unknown, fallback: number[]): number[] {
    const source = Array.isArray(value) ? value : [];
    const seen = new Set<number>();
    const countries: number[] = [];
    for (const item of source) {
        const id = Math.floor(Number(item));
        if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
        seen.add(id);
        countries.push(id);
    }
    return countries.length ? countries : fallback;
}

function priorityFromBody(value: unknown, fallback: HeroSMSConfig["acquirePriority"]): HeroSMSConfig["acquirePriority"] {
    const normalized = String(value ?? "").trim();
    if (normalized === "country" || normalized === "price_low" || normalized === "price_high") return normalized;
    return fallback;
}

function apiKeyStrategyFromBody(value: unknown, fallback: HeroSMSConfig["apiKeyStrategy"]): HeroSMSConfig["apiKeyStrategy"] {
    const normalized = String(value ?? "").trim();
    if (normalized === "round_robin" || normalized === "fill_first") return normalized;
    return fallback;
}

function proxyStrategyFromBody(value: unknown, fallback: HeroSMSProxyStrategy): HeroSMSProxyStrategy {
    const normalized = String(value ?? "").trim();
    if (normalized === "hero_sms" || normalized === "proxies" || normalized === "direct") return normalized;
    return fallback;
}

function runConcurrencyModeFromBody(value: unknown, fallback: AppConfig["run"]["concurrencyMode"]): AppConfig["run"]["concurrencyMode"] {
    const normalized = String(value ?? "").trim();
    if (normalized === "fixed" || normalized === "adaptive") return normalized;
    return fallback;
}

function proxyModeFromBody(value: unknown, fallback: ProxyMode): ProxyMode {
    const normalized = String(value ?? "").trim();
    if (normalized === "pool" || normalized === "phone_country") return normalized;
    return fallback;
}

function publicConfigSummary(config: AppConfig): JsonValue {
    return {
        run: config.run as unknown as JsonValue,
        proxy: {
            ...config.proxy,
            urls: config.proxy.urls.map(redactProxy),
            phoneCountryTemplate: config.proxy.phoneCountryTemplate,
        } as unknown as JsonValue,
        proxies: config.proxies.map(redactProxy),
        emailPool: config.emailPool as unknown as JsonValue,
        cpaJson: config.cpaJson as unknown as JsonValue,
        cost: config.cost as unknown as JsonValue,
        sentinelSdk: config.sentinelSdk as unknown as JsonValue,
    };
}

function heroSmsBalanceCacheKey(config: AppConfig): string {
    return createHash("sha256")
        .update(config.heroSMS.apiKeys.join("\0"))
        .update("\0")
        .update(config.heroSMS.proxyStrategy)
        .update("\0")
        .update(config.heroSMS.proxyUrls.join("\0"))
        .update("\0")
        .update(config.proxies.join("\0"))
        .digest("hex");
}

function countryOptionsFromProvider(countries: HeroSmsCountry[]): HeroSmsCountryOption[] {
    const seen = new Set<number>();
    const options: HeroSmsCountryOption[] = [];
    for (const country of countries) {
        const id = Math.floor(Number(country.id));
        if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
        seen.add(id);
        const label = String(country.label || "").trim() || `Country #${id}`;
        options.push({
            id,
            label,
            english: extractHeroSmsCountryName(country) || undefined,
        });
    }
    return options;
}

function countryOptionsFromUnknown(value: unknown): HeroSmsCountryOption[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<number>();
    const options: HeroSmsCountryOption[] = [];
    for (const item of value) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        const id = Math.floor(Number(record.id));
        if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
        seen.add(id);
        const label = String(record.label || "").trim() || `Country #${id}`;
        const english = String(record.english || "").trim();
        options.push({id, label, ...(english ? {english} : {})});
    }
    return options;
}

function mergeSelectedCountries(countries: HeroSmsCountryOption[], selectedIds: number[]): HeroSmsCountryOption[] {
    const next = [...countries];
    const seen = new Set(next.map((country) => country.id));
    for (const item of selectedIds) {
        const id = Math.floor(Number(item));
        if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
        seen.add(id);
        next.push({id, label: `Country #${id}`});
    }
    return next;
}

function fallbackHeroSmsCountries(error?: unknown): HeroSmsCountriesStatus {
    return {
        source: "fallback",
        countries: HERO_SMS_FALLBACK_COUNTRIES,
        fetchedAt: new Date().toISOString(),
        ...(error ? {error: error instanceof Error ? error.message : String(error)} : {}),
    };
}

function heroSmsCountriesCachePath(): string {
    return path.resolve(process.cwd(), HERO_SMS_COUNTRIES_CACHE_FILE);
}

async function readHeroSmsCountriesCache(): Promise<HeroSmsCountriesStatus | null> {
    try {
        const parsed = JSON.parse(await readFile(heroSmsCountriesCachePath(), "utf8")) as Record<string, unknown>;
        if (Number(parsed.version) !== HERO_SMS_COUNTRIES_CACHE_VERSION) return null;
        const countries = countryOptionsFromUnknown(parsed.countries);
        if (!countries.length) return null;
        const fetchedAt = String(parsed.fetchedAt || "").trim() || new Date().toISOString();
        return {source: "api", countries, fetchedAt, cached: true};
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        console.warn(`[admin] HeroSMS 国家缓存读取失败: ${(error as Error).message}`);
        return null;
    }
}

async function writeHeroSmsCountriesCache(status: HeroSmsCountriesStatus): Promise<void> {
    if (status.source !== "api" || !status.countries.length) return;
    const file = heroSmsCountriesCachePath();
    await mkdir(path.dirname(file), {recursive: true});
    await writeFileAtomic(file, `${JSON.stringify({
        version: HERO_SMS_COUNTRIES_CACHE_VERSION,
        fetchedAt: status.fetchedAt,
        countries: status.countries,
    }, null, 2)}\n`);
}

async function fetchHeroSmsCountries(config: AppConfig): Promise<HeroSmsCountriesStatus> {
    const provider = createHeroSmsProvider({
        apiKey: config.heroSMS.apiKeys[0] ?? config.heroSMS.apiKey,
        proxyUrl: heroSmsProxyForWorker(config, 0),
        timeoutMs: HERO_SMS_COUNTRIES_TIMEOUT_MS,
        rpsLimit: config.heroSMS.rpsLimit,
        rateLimitLabel: redactHeroSmsApiKey(config.heroSMS.apiKeys[0] ?? config.heroSMS.apiKey, 0),
    });
    const countries = countryOptionsFromProvider(await provider.getCountries());
    if (!countries.length) {
        throw new Error("HeroSMS getCountries 返回国家列表为空");
    }
    const status: HeroSmsCountriesStatus = {
        source: "api",
        countries,
        fetchedAt: new Date().toISOString(),
    };
    await writeHeroSmsCountriesCache(status);
    return status;
}

async function heroSmsCountriesStatus(config: AppConfig, refresh = false): Promise<HeroSmsCountriesStatus> {
    if (!refresh && heroSmsCountriesCache) {
        return {...heroSmsCountriesCache, cached: true};
    }

    if (!refresh) {
        const cached = await readHeroSmsCountriesCache();
        if (cached) {
            heroSmsCountriesCache = cached;
            return cached;
        }
    }

    if (heroSmsCountriesInFlight) {
        return heroSmsCountriesInFlight;
    }

    const promise = (async (): Promise<HeroSmsCountriesStatus> => {
        try {
            const fresh = await fetchHeroSmsCountries(config);
            heroSmsCountriesCache = fresh;
            return fresh;
        } catch (error) {
            const cached = heroSmsCountriesCache ?? await readHeroSmsCountriesCache();
            if (cached) {
                heroSmsCountriesCache = cached;
                return {
                    ...cached,
                    cached: true,
                    error: error instanceof Error ? error.message : String(error),
                };
            }
            return fallbackHeroSmsCountries(error);
        }
    })();

    heroSmsCountriesInFlight = promise;
    try {
        return await promise;
    } finally {
        if (heroSmsCountriesInFlight === promise) {
            heroSmsCountriesInFlight = null;
        }
    }
}

async function heroSmsBalanceStatus(config: AppConfig, options: {forceRefresh?: boolean} = {}): Promise<JsonValue> {
    const apiKeys = config.heroSMS.apiKeys;
    if (!apiKeys.length) {
        return {ok: false, error: "HeroSMS api_keys/api_key 未配置"};
    }

    const key = heroSmsBalanceCacheKey(config);
    const now = Date.now();
    if (!options.forceRefresh && heroSmsBalanceCache?.key === key && heroSmsBalanceCache.expiresAt > now) {
        return {...heroSmsBalanceCache.value as Record<string, JsonValue>, cached: true};
    }

    if (heroSmsBalanceInFlight?.key === key) {
        return heroSmsBalanceInFlight.promise;
    }

    const promise: Promise<JsonValue> = (async (): Promise<JsonValue> => {
        const balances = await Promise.all(apiKeys.map(async (apiKey, index): Promise<JsonValue> => {
            const label = redactHeroSmsApiKey(apiKey, index);
            try {
                const provider = createHeroSmsProvider({
                    apiKey,
                    proxyUrl: heroSmsProxyForWorker(config, index),
                    timeoutMs: HERO_SMS_BALANCE_TIMEOUT_MS,
                    rpsLimit: config.heroSMS.rpsLimit,
                    rateLimitLabel: label,
                });
                const balance = await provider.getBalance();
                if (balance.amount <= 0) {
                    disableHeroSmsApiKey(apiKey, "no_balance", label);
                } else {
                    enableHeroSmsApiKeyIfReason(apiKey, "no_balance", label);
                }
                return {
                    ok: true,
                    index: index + 1,
                    label,
                    amount: balance.amount,
                    disabled: balance.amount <= 0,
                    disabledReason: balance.amount <= 0 ? "no_balance" : "",
                    raw: typeof balance.raw === "string" ? balance.raw : JSON.stringify(balance.raw),
                    fetchedAt: new Date().toISOString(),
                };
            } catch (error) {
                return {
                    ok: false,
                    index: index + 1,
                    label,
                    error: error instanceof Error ? error.message : String(error),
                    fetchedAt: new Date().toISOString(),
                };
            }
        }));

        const successful = balances.filter((item): item is Record<string, JsonValue> =>
            Boolean((item as Record<string, JsonValue>).ok) &&
            typeof (item as Record<string, JsonValue>).amount === "number",
        );
        const total = successful.reduce((sum, item) => sum + Number(item.amount), 0);

        if (successful.length > 0) {
            return {
                ok: true,
                amount: total,
                balances,
                successCount: successful.length,
                failureCount: balances.length - successful.length,
                fetchedAt: new Date().toISOString(),
            };
        }

        return {
            ok: false,
            balances,
            error: "所有 HeroSMS key 余额查询失败",
            fetchedAt: new Date().toISOString(),
        };
    })();

    heroSmsBalanceInFlight = {key, promise};
    try {
        const value = await promise;
        heroSmsBalanceCache = {
            key,
            expiresAt: Date.now() + HERO_SMS_BALANCE_TTL_MS,
            value,
        };
        return value;
    } finally {
        if (heroSmsBalanceInFlight?.promise === promise) {
            heroSmsBalanceInFlight = null;
        }
    }
}

interface CpaJsonFile {
    fileName: string;
    content: string;
    mtimeMs: number;
}

function normalizeEmail(value: string): string {
    return String(value ?? "").trim().toLowerCase();
}

function safeZipName(value: string): string {
    return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

async function collectCpaJsonFiles(cpaJsonDir: string, emails: string[]): Promise<Map<string, CpaJsonFile>> {
    const targets = new Set(emails.map(normalizeEmail).filter(Boolean));
    const matches = new Map<string, CpaJsonFile>();
    if (!targets.size) return matches;

    const absoluteDir = path.resolve(process.cwd(), cpaJsonDir);
    let entries;
    try {
        entries = await readdir(absoluteDir, {withFileTypes: true});
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return matches;
        }
        throw error;
    }

    await Promise.all(entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
        .map(async (entry) => {
            const filePath = path.join(absoluteDir, entry.name);
            let content = "";
            let recordEmail = "";
            try {
                content = await readFile(filePath, "utf8");
                const parsed = JSON.parse(content) as {email?: unknown};
                recordEmail = normalizeEmail(typeof parsed.email === "string" ? parsed.email : "");
            } catch {
                return;
            }
            if (!targets.has(recordEmail)) return;

            const fileStat = await stat(filePath);
            const current = matches.get(recordEmail);
            if (!current || fileStat.mtimeMs > current.mtimeMs) {
                matches.set(recordEmail, {
                    fileName: entry.name,
                    content,
                    mtimeMs: fileStat.mtimeMs,
                });
            }
        }));

    return matches;
}

async function buildSuccessExportZip(successLines: string[], cpaJsonDir: string, costLines: string[] = []): Promise<{buffer: Buffer; matched: number; missing: string[]}> {
    const zip = new JSZip();
    const successContent = successLines.length ? `${successLines.join("\n")}\n` : "";
    const emails = successLines.map(emailFromLine).filter(Boolean);
    const cpaFiles = await collectCpaJsonFiles(cpaJsonDir, emails);
    const missing: string[] = [];

    zip.file("email.success.txt", successContent);
    for (const email of emails) {
        const cpaFile = cpaFiles.get(email);
        if (!cpaFile) {
            missing.push(email);
            continue;
        }
        zip.file(`cpa_json/${safeZipName(cpaFile.fileName)}`, cpaFile.content.endsWith("\n") ? cpaFile.content : `${cpaFile.content}\n`);
    }

    if (missing.length) {
        zip.file("cpa_json_missing.txt", `${missing.join("\n")}\n`);
    }
    if (costLines.length) {
        zip.file("cost.success.jsonl", `${costLines.join("\n")}\n`);
    }

    const buffer = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        compressionOptions: {level: 6},
    });
    return {buffer, matched: cpaFiles.size, missing};
}

function formatSuccessExportFileName(count: number, value: Date | number | string = new Date()): string {
    const date = value instanceof Date ? value : new Date(value);
    const timestamp = date.getTime();
    const safeCount = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
    if (!Number.isFinite(timestamp)) {
        return `FREE-${safeCount}-0000000000.zip`;
    }

    const shifted = new Date(timestamp + 8 * 60 * 60 * 1000);
    const pad = (item: number) => String(item).padStart(2, "0");
    const timestampLabel = `${pad(shifted.getUTCMonth() + 1)}${pad(shifted.getUTCDate())}${pad(shifted.getUTCHours())}${pad(shifted.getUTCMinutes())}${pad(shifted.getUTCSeconds())}`;
    return `FREE-${safeCount}-${timestampLabel}.zip`;
}

function cleanupSuccessExportSnapshots(now = Date.now()): void {
    for (const [id, snapshot] of successExportSnapshots) {
        if (snapshot.expiresAt <= now) {
            successExportSnapshots.delete(id);
        }
    }
}

function createSuccessExportSnapshot(emails: string[]): string {
    const now = Date.now();
    cleanupSuccessExportSnapshots(now);
    const exportId = randomBytes(16).toString("hex");
    successExportSnapshots.set(exportId, {
        emails: [...emails],
        createdAt: now,
        expiresAt: now + SUCCESS_EXPORT_SNAPSHOT_TTL_MS,
    });
    return exportId;
}

function getSuccessExportSnapshot(exportId: unknown): {id: string; snapshot: SuccessExportSnapshot} | null {
    cleanupSuccessExportSnapshots();
    if (typeof exportId !== "string" || !/^[a-f0-9]{32}$/i.test(exportId)) {
        return null;
    }
    const snapshot = successExportSnapshots.get(exportId);
    return snapshot ? {id: exportId, snapshot} : null;
}

function heroSmsRpsStatus(config: AppConfig): JsonValue {
    const keys = getHeroSmsRpsStats(config.heroSMS.apiKeys, {rpsLimit: config.heroSMS.rpsLimit});
    const pendingTotal = keys.reduce((sum, item) => sum + (item.pendingTotal || 0), 0);
    return {
        ok: true,
        keys: keys as unknown as JsonValue,
        totalRps: Math.round(keys.reduce((sum, item) => sum + item.rps, 0) * 100) / 100,
        totalLimit: keys.reduce((sum, item) => sum + item.rpsLimit, 0),
        pendingTotal,
        fetchedAt: new Date().toISOString(),
    };
}

async function currentStatus(options: {refreshBalance?: boolean} = {}): Promise<JsonValue> {
    try {
        const config = loadConfig();
        const pool = new EmailPool(config.emailPool);
        const poolStats = await pool.stats();
        const successLines = await pool.successLines();
        return {
            ok: true,
            runner: runner.getSnapshot() as unknown as JsonValue,
            pool: poolStats as unknown as JsonValue,
            successCost: await summarizeSuccessCosts(config.cost, successLines) as unknown as JsonValue,
            heroSmsBalance: await heroSmsBalanceStatus(config, {forceRefresh: options.refreshBalance}),
            heroSmsRps: heroSmsRpsStatus(config),
            configPath: configPath(),
            effectiveConfig: publicConfigSummary(config),
        };
    } catch (error) {
        return {
            ok: false,
            runner: runner.getSnapshot() as unknown as JsonValue,
            configPath: configPath(),
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (pathname === "/api/login" && req.method === "POST") {
        const body = await readJson<{password?: unknown}>(req);
        const password = typeof body.password === "string" ? body.password : "";
        if (!safeEqual(password, adminPassword())) {
            sendError(res, 401, "密码错误");
            return;
        }
        const token = randomBytes(32).toString("hex");
        sessions.set(hashSessionToken(token), Date.now() + SESSION_TTL_MS);
        await flushSessionPersist();
        res.setHeader("set-cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
        sendJson(res, 200, {ok: true});
        return;
    }

    if (!isAuthenticated(req)) {
        sendError(res, 401, "需要登录");
        return;
    }

    if (pathname === "/api/logout" && req.method === "POST") {
        const token = parseCookies(req)[SESSION_COOKIE];
        if (token) {
            sessions.delete(hashSessionToken(token));
            await flushSessionPersist();
        }
        res.setHeader("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
        sendJson(res, 200, {ok: true});
        return;
    }

    if (pathname === "/api/status" && req.method === "GET") {
        const url = new URL(req.url ?? "/", "http://localhost");
        sendJson(res, 200, await currentStatus({refreshBalance: url.searchParams.get("refreshBalance") === "1"}));
        return;
    }

    if (pathname === "/api/sms-rps" && req.method === "GET") {
        const config = loadConfig();
        sendJson(res, 200, {ok: true, heroSmsRps: heroSmsRpsStatus(config)});
        return;
    }

    if (pathname === "/api/logs" && req.method === "GET") {
        sendJson(res, 200, {ok: true, lines: logger.recent()});
        return;
    }

    if (pathname === "/api/logs/stream" && req.method === "GET") {
        sendLogStream(req, res);
        return;
    }

    if (pathname === "/api/config" && req.method === "GET") {
        const file = configPath();
        let content = "";
        try {
            content = await readFile(file, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        sendJson(res, 200, {ok: true, path: file, content});
        return;
    }

    if (pathname === "/api/config" && req.method === "PUT") {
        const body = await readJson<{content?: unknown}>(req);
        const content = typeof body.content === "string" ? body.content : "";
        parseToml(content);
        await writeFileAtomic(configPath(), content.endsWith("\n") ? content : `${content}\n`);
        heroSmsBalanceCache = null;
        logger.info("[admin] config.toml 已保存，下次启动任务会读取最新配置");
        sendJson(res, 200, {ok: true});
        return;
    }

    if (pathname === "/api/sms-config" && req.method === "GET") {
        const config = loadConfig();
        const url = new URL(req.url ?? "/", "http://localhost");
        const refreshCountries = url.searchParams.get("refreshCountries") === "1";
        if (refreshCountries) heroSmsCountriesCache = null;
        const countryStatus = await heroSmsCountriesStatus(config, refreshCountries);
        sendJson(res, 200, {
            ok: true,
            run: config.run as unknown as JsonValue,
            proxy: config.proxy as unknown as JsonValue,
            heroSMS: smsConfigJson(config),
            countries: mergeSelectedCountries(countryStatus.countries, config.heroSMS.countries) as unknown as JsonValue,
            countriesSource: countryStatus.source,
            countriesError: countryStatus.error ?? "",
            countriesFetchedAt: countryStatus.fetchedAt,
            countriesCached: countryStatus.cached ?? false,
        });
        return;
    }

    if (pathname === "/api/sms-config" && req.method === "PUT") {
        const body = await readJson<Record<string, unknown>>(req);
        const config = loadConfig();
        const hero = config.heroSMS;
        const minPrice = numberFromBody(body.minPrice, hero.minPrice);
        const maxPrice = numberFromBody(body.maxPrice, hero.maxPrice);
        const priceStep = numberFromBody(body.priceStep, hero.priceStep);
        const runValues = {
            concurrency_mode: runConcurrencyModeFromBody(body.concurrencyMode, config.run.concurrencyMode),
            success_after_email_otp: Boolean(body.successAfterEmailOtp),
        };
        const proxyValues = {
            mode: proxyModeFromBody(body.proxyMode, config.proxy.mode),
            phone_country_template: typeof body.phoneCountryTemplate === "string" && body.phoneCountryTemplate.trim()
                ? body.phoneCountryTemplate.trim()
                : config.proxy.phoneCountryTemplate,
        };
        const values = {
            proxy_strategy: proxyStrategyFromBody(body.proxyStrategy, hero.proxyStrategy),
            api_key_strategy: apiKeyStrategyFromBody(body.apiKeyStrategy, hero.apiKeyStrategy),
            countries: countriesFromBody(body.countries, hero.countries),
            acquire_priority: priorityFromBody(body.acquirePriority, hero.acquirePriority),
            min_price: Math.min(minPrice, maxPrice),
            max_price: Math.max(minPrice, maxPrice),
            price_step: priceStep,
            max_phone_tries: integerFromBody(body.maxPhoneTries, hero.maxPhoneTries),
        };
        const file = configPath();
        let content = "";
        try {
            content = await readFile(file, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const nextContent = upsertTomlSection(
            upsertTomlSection(
                upsertTomlSection(content, "run", runValues),
                "proxies",
                proxyValues,
            ),
            "hero_sms",
            values,
            ["country", "price_tiers", "poll_attempts", "use_proxy"],
        );
        parseToml(nextContent);
        await writeFileAtomic(file, nextContent);
        heroSmsBalanceCache = null;
        logger.info(`[admin] 接码配置已保存 concurrency_mode=${runValues.concurrency_mode}，下次启动任务会读取最新配置`);
        const nextConfig = loadConfig();
        sendJson(res, 200, {ok: true, run: nextConfig.run as unknown as JsonValue, heroSMS: smsConfigJson(nextConfig)});
        return;
    }

    if (pathname === "/api/email/import" && req.method === "POST") {
        const body = await readJson<{text?: unknown}>(req);
        const text = typeof body.text === "string" ? body.text : "";
        const pool = new EmailPool(loadConfig().emailPool);
        const result = await pool.importToSource(text);
        logger.info(`[admin] 导入邮箱 total=${result.total} imported=${result.imported} duplicate=${result.duplicate} invalid=${result.invalid}`);
        sendJson(res, 200, {ok: true, result: result as unknown as JsonValue});
        return;
    }

    if (pathname === "/api/email/success/export" && req.method === "POST") {
        const config = loadConfig();
        const pool = new EmailPool(config.emailPool);
        const successLines = await pool.successLines();
        const successEmails = successLines.map(emailFromLine).filter(Boolean);
        const costLines = await successCostLinesForEmails(config.cost, successEmails);
        const {buffer, matched, missing} = await buildSuccessExportZip(successLines, config.cpaJson.dir, costLines);
        const exportId = createSuccessExportSnapshot(successEmails);
        const filename = formatSuccessExportFileName(successEmails.length);
        logger.info(`[admin] 导出成功邮箱快照 emails=${successLines.length} cpa_json=${matched} missing=${missing.length} export_id=${exportId} bytes=${buffer.length}`);
        send(res, 200, buffer, {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="${filename}"`,
            "x-export-id": exportId,
            "x-export-count": String(successEmails.length),
            "x-export-filename": filename,
        });
        return;
    }

    if (pathname === "/api/email/success/export/clear" && req.method === "POST") {
        const body = await readJson<{exportId?: unknown}>(req);
        const exportSnapshot = getSuccessExportSnapshot(body.exportId);
        if (!exportSnapshot) {
            sendError(res, 404, "导出快照已过期或不存在，请重新导出后再删除");
            return;
        }

        const config = loadConfig();
        const pool = new EmailPool(config.emailPool);
        await pool.clearSuccessEmails(exportSnapshot.snapshot.emails);
        let removedCostRecords = 0;
        try {
            removedCostRecords = (await removeSuccessCostRecords(config.cost, exportSnapshot.snapshot.emails)).removed;
        } catch (costError) {
            logger.warn(`[admin] 成功邮箱已删除，但成本流水清理失败: ${(costError as Error).message}`);
        }
        successExportSnapshots.delete(exportSnapshot.id);
        logger.info(`[admin] 清空已导出成功邮箱 emails=${exportSnapshot.snapshot.emails.length} cost_records=${removedCostRecords} export_id=${exportSnapshot.id}`);
        sendJson(res, 200, {
            ok: true,
            deleted: exportSnapshot.snapshot.emails.length,
            removedCostRecords,
        });
        return;
    }

    if (pathname === "/api/email/inflight/return" && req.method === "POST") {
        if (isRunnerBusy()) {
            sendError(res, 409, "任务运行中，不能操作进行中邮箱");
            return;
        }
        const pool = new EmailPool(loadConfig().emailPool);
        const result = await pool.returnInflightToSource();
        logger.info(`[admin] 进行中邮箱已归还到待使用 count=${result.returned}`);
        sendJson(res, 200, {ok: true, result: result as unknown as JsonValue});
        return;
    }

    if (pathname === "/api/email/inflight/fail" && req.method === "POST") {
        if (isRunnerBusy()) {
            sendError(res, 409, "任务运行中，不能操作进行中邮箱");
            return;
        }
        const pool = new EmailPool(loadConfig().emailPool);
        const result = await pool.markInflightFailed("admin_mark_inflight_failed");
        logger.warn(`[admin] 进行中邮箱已标记失败 failed=${result.failed} cleared=${result.cleared}`);
        sendJson(res, 200, {ok: true, result: result as unknown as JsonValue});
        return;
    }

    if (pathname === "/api/task/start" && req.method === "POST") {
        const config = loadConfig();
        const snapshot = runner.start(config);
        sendJson(res, 200, {ok: true, runner: snapshot as unknown as JsonValue});
        return;
    }

    if (pathname === "/api/task/pause" && req.method === "POST") {
        const snapshot = runner.pause();
        sendJson(res, 200, {ok: true, runner: snapshot as unknown as JsonValue});
        return;
    }

    if (pathname === "/api/task/force-pause" && req.method === "POST") {
        const snapshot = runner.forcePause();
        sendJson(res, 200, {ok: true, runner: snapshot as unknown as JsonValue});
        return;
    }

    sendError(res, 404, "接口不存在");
}

function html(): string {
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FreeRegister Admin</title>
  <link rel="stylesheet" href="/vendor/codemirror/codemirror.css">
  <style>
    :root { color-scheme: light; --bg: #f7f7f5; --panel: #ffffff; --text: #151515; --muted: #6f6f6a; --line: #dfdfda; --accent: #111111; --danger: #9f2a2a; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 13px/1.38 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    header { height: 52px; display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 12px; padding: 0 18px; border-bottom: 1px solid var(--line); background: rgba(247,247,245,.9); position: sticky; top: 0; backdrop-filter: blur(12px); }
    h1 { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: 0; }
    .header-actions { justify-self: end; }
    main { width: min(1280px, calc(100vw - 24px)); max-width: calc(100vw - 24px); min-width: 0; margin: 12px auto 28px; display: grid; gap: 10px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
    .panel { min-width: 0; max-width: 100%; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
    .panel h2 { margin: 0; font-size: 13px; font-weight: 650; }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .metric { color: var(--muted); font-size: 11px; padding-block: 8px; }
    .metric-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .metric strong { display: block; margin-top: 2px; color: var(--text); font-size: 20px; line-height: 1.05; font-weight: 680; }
    .metric .sub { display: block; margin-top: 3px; color: var(--muted); font-size: 11px; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #successCostMeta { white-space: pre-line; overflow: visible; text-overflow: clip; overflow-wrap: anywhere; }
    #heroSmsBalanceMeta { white-space: normal; overflow-wrap: anywhere; }
    .sms-rps-list { display: grid; gap: 2px; max-height: 74px; overflow: auto; margin-top: 4px; color: var(--muted); font-size: 11px; line-height: 1.25; }
    .sms-rps-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; white-space: nowrap; }
    .sms-rps-item span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .sms-rps-item.disabled { color: var(--danger); }
    .metric-actions { display: flex; align-items: center; gap: 4px; margin-top: 4px; }
    .metric-actions button { height: 24px; padding: 0 7px; font-size: 11px; }
    .metric-head button.secondary { height: 24px; padding: 0 7px; font-size: 11px; }
    .icon-button { width: 24px; height: 24px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border-color: var(--line); background: #fff; color: var(--text); line-height: 1; }
    .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .toolbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .split-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .stack { min-width: 0; display: grid; gap: 8px; }
    button, input, textarea { font: inherit; }
    button { height: 30px; padding: 0 10px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; }
    button.secondary { background: #fff; color: var(--text); border-color: var(--line); }
    button.danger { background: var(--danger); border-color: var(--danger); }
    button:disabled { opacity: .45; cursor: not-allowed; }
    input { height: 30px; padding: 0 8px; border: 1px solid var(--line); border-radius: 6px; background: #fff; min-width: 120px; }
    select { height: 30px; padding: 0 8px; border: 1px solid var(--line); border-radius: 6px; background: #fff; min-width: 120px; }
    label { display: grid; gap: 3px; color: var(--muted); font-size: 11px; }
    label span { color: var(--muted); }
    label input, label select, label textarea { color: var(--text); font-size: 13px; }
    .form-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; align-items: end; }
    .form-grid .wide { grid-column: span 2; }
    .form-grid .proxy-field { grid-column: span 3; }
    .readonly-field { display: flex; align-items: center; min-height: 34px; padding: 0 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--soft); color: var(--text); font-size: 13px; }
    .check-row { height: 30px; display: flex; align-items: center; gap: 6px; color: var(--text); font-size: 13px; }
    .check-row input { min-width: 0; width: 15px; height: 15px; }
    .form-grid .country-field { grid-column: span 3; }
    .country-picker-row { display: grid; grid-template-columns: minmax(120px, .8fr) minmax(150px, 1fr) auto; gap: 6px; align-items: center; }
    .country-picker-row input, .country-picker-row select { min-width: 0; width: 100%; }
    .country-list { display: flex; flex-wrap: wrap; gap: 6px; min-height: 30px; align-items: center; }
    .country-pill { display: inline-flex; align-items: center; gap: 4px; padding: 3px 5px; border: 1px solid var(--line); border-radius: 6px; background: #fafafa; }
    .country-pill button { width: 22px; height: 22px; padding: 0; border-color: var(--line); background: #fff; color: var(--text); }
    textarea { width: 100%; min-height: 160px; resize: vertical; border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: #fff; color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.42; }
    .form-grid textarea { min-height: 72px; max-height: 120px; padding: 7px 8px; border-radius: 6px; }
    #configText { min-height: 330px; }
    .CodeMirror { height: 340px; border: 1px solid var(--line); border-radius: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.42; }
    .CodeMirror-scroll { border-radius: 8px; }
    .CodeMirror-gutters { background: #fafafa; border-right: 1px solid var(--line); }
    .CodeMirror-linenumber { color: #9a9a94; }
    .cm-comment { color: #587d4b; }
    .cm-atom, .cm-number { color: #8a4d1c; }
    .cm-string { color: #1b6b68; }
    .cm-keyword, .cm-property { color: #403f3c; font-weight: 600; }
    .worker-table-wrap { max-height: 980px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
    .worker-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12px; }
    .worker-table th, .worker-table td { padding: 6px 7px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .worker-table th { position: sticky; top: 0; z-index: 1; background: #fafafa; color: var(--muted); font-weight: 650; }
    .worker-table tr:last-child td { border-bottom: 0; }
    .worker-table .worker-col-id { width: 48px; }
    .worker-table .worker-col-status { width: 82px; }
    .worker-table .worker-col-stage { width: 108px; }
    .worker-table .worker-col-job { width: 64px; }
    .worker-table .worker-col-phone { width: 118px; }
    .worker-table .worker-col-time { width: 72px; }
    .worker-table .worker-col-log { width: 34%; }
    .worker-status { display: inline-flex; align-items: center; max-width: 100%; min-height: 20px; padding: 1px 6px; border-radius: 999px; background: #ececea; color: #333; font-size: 11px; }
    .worker-status.running { background: #dff2ea; color: #14533e; }
    .worker-status.failed { background: #fde5df; color: #7a2a16; }
    .worker-status.success { background: #e1edf9; color: #174166; }
    #logsBody { min-width: 0; max-width: 100%; overflow: hidden; }
    #logsBody[hidden] { display: none; }
    #logs { width: 100%; max-width: 100%; min-height: 260px; max-height: 420px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: #111; color: #eee; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.38; }
    #login { max-width: 360px; margin: 18vh auto; }
    #app { display: none; }
    .modal-backdrop { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; padding: 20px; background: rgba(20,20,18,.42); z-index: 20; }
    .modal-backdrop.open { display: flex; }
    .modal { width: min(720px, calc(100vw - 32px)); max-height: min(760px, calc(100vh - 40px)); overflow: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; box-shadow: 0 24px 80px rgba(0,0,0,.22); }
    .modal-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
    .modal-head h2 { margin: 0; font-size: 13px; font-weight: 650; }
    .modal textarea { min-height: 360px; }
    .muted { color: var(--muted); }
    .status { padding: 3px 8px; border-radius: 999px; background: #ececea; color: #333; font-size: 12px; }
    .runner-status-main { justify-self: center; min-width: 128px; padding: 5px 14px; text-align: center; font-size: 15px; font-weight: 680; letter-spacing: 0; }
    .msg { min-height: 18px; color: var(--muted); }
    @media (max-width: 900px) { .form-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .form-grid .wide, .form-grid .country-field, .form-grid .proxy-field { grid-column: span 2; } }
    @media (max-width: 760px) { header { padding: 0 12px; grid-template-columns: minmax(0, 1fr) auto auto; } .runner-status-main { min-width: 0; font-size: 13px; padding-inline: 9px; } .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .country-picker-row { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <section id="login" class="panel stack">
    <h1>FreeRegister Admin</h1>
    <input id="password" type="password" placeholder="管理员密码" autocomplete="current-password">
    <button id="loginBtn">登录</button>
    <div id="loginMsg" class="msg"></div>
  </section>

  <section id="app">
    <header>
      <h1>FreeRegister Admin</h1>
      <span id="runnerStatus" class="status runner-status-main">idle</span>
      <div class="row header-actions">
        <button id="logoutBtn" class="secondary">退出</button>
      </div>
    </header>
    <main>
      <section class="grid">
        <div class="panel metric"><div class="metric-head"><span>待使用</span><button id="openImportModalBtn" type="button" class="secondary">导入</button></div><strong id="countSource">0</strong><span id="importMsg" class="sub"></span></div>
        <div class="panel metric"><div class="metric-head"><span>成功</span><button id="exportBtn" type="button" class="secondary">导出</button></div><strong id="countSuccess">0</strong><span id="successCostMeta" class="sub"></span><span id="successRunMeta" class="sub"></span></div>
        <div class="panel metric"><span>进行中</span><strong id="countInflight">0</strong><div class="metric-actions"><button id="returnInflightBtn" type="button" class="secondary">归还</button><button id="failInflightBtn" type="button" class="secondary">标失败</button></div></div>
        <div class="panel metric">失败<strong id="countFailed">0</strong></div>
        <div class="panel metric">进程内存<strong id="memoryUsed">-</strong><span id="memoryMeta" class="sub"></span></div>
        <div class="panel metric"><div class="metric-head"><span>HeroSMS 余额</span><button id="refreshHeroSmsBalanceBtn" type="button" class="icon-button" title="刷新余额" aria-label="刷新余额"><span aria-hidden="true">&#8635;</span></button></div><strong id="heroSmsBalance">-</strong><span id="heroSmsBalanceMeta" class="sub"></span></div>
        <div class="panel metric"><span>HeroSMS API RPS</span><strong id="heroSmsRpsTotal">0 / 0</strong><div id="heroSmsRpsList" class="sms-rps-list"></div></div>
      </section>

      <section class="panel stack">
        <div class="panel-head">
          <h2>任务</h2>
          <span id="taskConfig" class="muted"></span>
        </div>
        <div class="split-row">
          <div class="toolbar">
            <button id="startBtn">开始</button>
            <button id="pauseBtn" class="secondary">暂停</button>
            <button id="forcePauseBtn" class="danger">强制暂停</button>
          </div>
          <div class="row">
            <span id="taskMsg" class="msg"></span>
          </div>
        </div>
        <div class="panel-head">
          <h2>线程状态</h2>
          <span id="workerSummary" class="muted">0 / 0 running</span>
        </div>
        <div class="worker-table-wrap">
          <table class="worker-table">
            <thead>
              <tr>
                <th class="worker-col-id">线程</th>
                <th class="worker-col-status">状态</th>
                <th class="worker-col-stage">阶段</th>
                <th class="worker-col-job">Job</th>
                <th>邮箱</th>
                <th class="worker-col-phone">手机号</th>
                <th class="worker-col-time">耗时</th>
                <th class="worker-col-log">最新日志</th>
              </tr>
            </thead>
            <tbody id="workerRows">
              <tr><td colspan="8">暂无线程</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel stack">
        <div class="panel-head">
          <h2>运行模式</h2>
        </div>
        <div class="form-grid">
          <label><span>并发模式</span><select id="runConcurrencyMode">
            <option value="fixed">fixed</option>
            <option value="adaptive">adaptive</option>
          </select></label>
          <label><span>邮箱 OTP 后成功</span><span class="check-row"><input id="successAfterEmailOtp" type="checkbox">开启</span></label>
          <label><span>注册代理模式</span><select id="proxyMode">
            <option value="pool">代理池</option>
            <option value="phone_country">手机号国家</option>
          </select></label>
          <label class="proxy-field"><span>手机号国家代理模板</span><input id="phoneCountryTemplate" placeholder="socks5://...-region-{code}-sid-{sid}-..."></label>
        </div>
      </section>

      <section class="panel stack">
        <div class="panel-head">
          <h2>接码配置</h2>
          <span id="smsCountrySource" class="muted"></span>
        </div>
        <div class="form-grid">
          <label><span>接口代理策略</span><select id="smsProxyStrategy">
            <option value="hero_sms">专用代理</option>
            <option value="proxies">共用代理池</option>
            <option value="direct">不走代理</option>
          </select></label>
          <label><span>API Key 策略</span><select id="smsApiKeyStrategy">
            <option value="round_robin">轮询</option>
            <option value="fill_first">填充优先</option>
          </select></label>
          <label><span>取号策略</span><select id="smsAcquirePriority">
            <option value="country">国家优先</option>
            <option value="price_low">低价优先</option>
            <option value="price_high">高价优先</option>
          </select></label>
          <label><span>最低价格</span><input id="smsMinPrice" type="number" min="0" step="0.0001"></label>
          <label><span>最高价格</span><input id="smsMaxPrice" type="number" min="0" step="0.0001"></label>
          <label><span>价格档位</span><input id="smsPriceStep" type="number" min="0" step="0.0001"></label>
          <label><span>最多换号</span><input id="smsMaxPhoneTries" type="number" min="1" step="1"></label>
          <label class="country-field"><span>添加国家</span><span class="country-picker-row"><input id="smsCountrySearch" placeholder="搜索国家 / ID" autocomplete="off"><select id="smsCountryPicker"></select><button id="smsAddCountryBtn" type="button" class="secondary">添加</button></span></label>
        </div>
        <div id="smsCountryList" class="country-list"></div>
      </section>

      <section class="panel stack">
        <div class="panel-head">
          <h2>配置操作</h2>
          <span id="smsConfigMsg" class="msg"></span>
        </div>
        <div class="row">
          <button id="saveSmsConfigBtn">保存配置</button>
          <button id="reloadSmsConfigBtn" class="secondary">重新加载</button>
        </div>
      </section>

      <section class="panel stack">
        <div class="panel-head">
          <h2>日志</h2>
          <div class="row">
            <span id="logsState" class="muted">已折叠</span>
            <button id="copyLogsBtn" type="button" class="secondary" hidden>复制</button>
            <button id="toggleLogsBtn" type="button" class="secondary" aria-expanded="false">展开</button>
          </div>
        </div>
        <div id="logsBody" hidden>
          <pre id="logs"></pre>
        </div>
      </section>

      <section class="panel stack">
        <div class="panel-head">
          <h2>config.toml</h2>
          <span id="configPath" class="muted"></span>
        </div>
        <textarea id="configText" spellcheck="false"></textarea>
        <div class="row">
          <button id="saveConfigBtn">保存配置</button>
          <button id="reloadConfigBtn" class="secondary">重新加载</button>
          <span id="configMsg" class="msg"></span>
        </div>
      </section>
    </main>
  </section>

  <div id="importModal" class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="importModalTitle">
    <section class="modal stack">
      <div class="modal-head">
        <h2 id="importModalTitle">导入邮箱</h2>
        <button id="closeImportModalBtn" class="secondary">取消</button>
      </div>
      <textarea id="emailText" placeholder="email----password----clientId----refreshToken"></textarea>
      <div class="row">
        <button id="importBtn">导入</button>
        <span id="importModalMsg" class="msg"></span>
      </div>
    </section>
  </div>

  <script src="/vendor/codemirror/codemirror.js"></script>
  <script src="/vendor/codemirror/toml.js"></script>
  <script>
    const $ = (id) => document.getElementById(id);
    const state = {
      authed: false,
      logSource: null,
      logLines: [],
      pendingLogs: [],
      logFlushTimer: 0,
      lastLogStreamErrorAt: 0,
      maxVisibleLogs: 300,
      logsExpanded: false,
      logsFollowTail: true,
      heroSmsBalanceRefreshing: false,
      inflightCount: 0,
      runnerBusy: false,
      smsConfigDirty: false,
      configEditor: null,
      smsCountries: [],
      selectedSmsCountries: []
    };

    async function api(path, options = {}) {
      const headers = Object.assign({"content-type": "application/json"}, options.headers || {});
      const res = await fetch(path, Object.assign({}, options, {headers}));
      if (res.status === 401) {
        state.authed = false;
        showLogin();
      }
      return res;
    }

    async function apiJson(path, options = {}) {
      const res = await api(path, options);
      const data = await res.json().catch(() => ({ok:false, error:"响应解析失败"}));
      if (!res.ok || data.ok === false) throw new Error(data.error || "请求失败");
      return data;
    }

    function showLogin() {
      closeLogStream();
      $("login").style.display = "grid";
      $("app").style.display = "none";
    }

    function showApp() {
      $("login").style.display = "none";
      $("app").style.display = "block";
    }

    function setText(id, value) {
      $(id).textContent = value == null ? "" : String(value);
    }

    const workerStageLabels = {
      idle: "空闲",
      leasing_email: "租邮箱",
      phone_acquire: "取号",
      phone_signup: "手机注册",
      phone_sms_wait: "手机 OTP",
      phone_registered: "手机已注册",
      oauth_start: "OAuth",
      email_otp_wait: "邮箱 OTP",
      oauth_exchange: "换授权",
      success: "成功",
      failed: "失败",
      skipped: "跳过",
      force_paused: "强制暂停"
    };

    const workerStatusLabels = {
      idle: "空闲",
      running: "运行中",
      success: "成功",
      failed: "失败",
      skipped: "跳过",
      paused: "暂停",
      force_paused: "强停"
    };

    function formatElapsedMs(value) {
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms <= 0) return "-";
      const seconds = Math.floor(ms / 1000);
      if (seconds < 60) return seconds + "s";
      const minutes = Math.floor(seconds / 60);
      const rest = seconds % 60;
      if (minutes < 60) return minutes + "m" + String(rest).padStart(2, "0") + "s";
      const hours = Math.floor(minutes / 60);
      return hours + "h" + String(minutes % 60).padStart(2, "0") + "m";
    }

    function updateMemory(memory) {
      if (!memory || typeof memory !== "object") {
        setText("memoryUsed", "-");
        setText("memoryMeta", "");
        return;
      }
      const used = Number(memory.guardUsedMb || 0);
      const hard = Number(memory.hardLimitMb || 0);
      const heap = Number(memory.heapUsedMb || 0);
      const heapLimit = Number(memory.heapLimitMb || 0);
      const level = memory.level && memory.level !== "ok" ? " · " + memory.level : "";
      setText("memoryUsed", used && hard ? used + " / " + hard + " MB" : (used ? used + " MB" : "-"));
      setText("memoryMeta", "heap " + (heap || "-") + " / " + (heapLimit || "-") + " MB" + level);
    }

    function appendCell(row, value, className) {
      const cell = document.createElement("td");
      if (className) cell.className = className;
      cell.title = value == null ? "" : String(value);
      cell.textContent = value == null ? "" : String(value);
      row.appendChild(cell);
      return cell;
    }

    function renderWorkers(workers) {
      const rows = $("workerRows");
      rows.textContent = "";
      const list = Array.isArray(workers) ? workers.slice().sort((a, b) => Number(a.workerId || 0) - Number(b.workerId || 0)) : [];
      const running = list.filter((worker) => worker.status === "running").length;
      setText("workerSummary", running + " / " + list.length + " running");
      if (!list.length) {
        const row = document.createElement("tr");
        appendCell(row, "暂无线程").colSpan = 8;
        rows.appendChild(row);
        return;
      }

      const fragment = document.createDocumentFragment();
      for (const worker of list) {
        const row = document.createElement("tr");
        appendCell(row, worker.workerId || "-", "worker-col-id");
        const statusCell = appendCell(row, "", "worker-col-status");
        const pill = document.createElement("span");
        pill.className = "worker-status " + (worker.status || "idle");
        pill.textContent = workerStatusLabels[worker.status] || worker.status || "idle";
        statusCell.appendChild(pill);
        appendCell(row, workerStageLabels[worker.stage] || worker.stage || "-", "worker-col-stage");
        appendCell(row, worker.jobId || "-", "worker-col-job");
        appendCell(row, worker.email || "-");
        appendCell(row, worker.phone || "-", "worker-col-phone");
        appendCell(row, formatElapsedMs(worker.elapsedMs), "worker-col-time");
        appendCell(row, worker.latestLog || worker.error || "-", "worker-col-log");
        fragment.appendChild(row);
      }
      rows.appendChild(fragment);
    }

    function ensureConfigEditor() {
      if (state.configEditor || !window.CodeMirror) return;
      state.configEditor = window.CodeMirror.fromTextArea($("configText"), {
        mode: "toml",
        lineNumbers: true,
        lineWrapping: false,
        tabSize: 2,
        indentUnit: 2,
        viewportMargin: 80,
        extraKeys: {
          "Tab": function(cm) {
            if (cm.somethingSelected()) {
              cm.indentSelection("add");
            } else {
              cm.replaceSelection("  ", "end");
            }
          }
        }
      });
    }

    function setConfigContent(content) {
      ensureConfigEditor();
      if (state.configEditor) {
        state.configEditor.setValue(content || "");
        window.setTimeout(() => state.configEditor.refresh(), 0);
      } else {
        $("configText").value = content || "";
      }
    }

    function getConfigContent() {
      return state.configEditor ? state.configEditor.getValue() : $("configText").value;
    }

    function formatBalanceAmount(value) {
      const amount = Number(value);
      if (!Number.isFinite(amount)) return "-";
      return amount.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 4});
    }

    function formatCostAmount(value, currency) {
      const amount = Number(value);
      if (!Number.isFinite(amount)) return "-";
      const formatted = amount.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 4});
      return (currency ? String(currency) + " " : "") + formatted;
    }

    function formatRpsAmount(value) {
      const amount = Number(value);
      if (!Number.isFinite(amount)) return "0";
      if (amount >= 100) return amount.toFixed(0);
      if (amount >= 10) return amount.toFixed(1);
      return amount.toFixed(2).replace(/\\.00$/, "");
    }

    function formatPercent(value) {
      const amount = Number(value);
      if (!Number.isFinite(amount)) return "-";
      return Math.round(amount * 100) + "%";
    }

    function formatUtc8Timestamp(value) {
      const parsed = value == null ? Date.now() : Date.parse(value || "");
      if (!Number.isFinite(parsed)) return "";
      const shifted = new Date(parsed + 8 * 60 * 60 * 1000);
      const pad = (item) => String(item).padStart(2, "0");
      return shifted.getUTCFullYear() + "-" +
        pad(shifted.getUTCMonth() + 1) + "-" +
        pad(shifted.getUTCDate()) + " " +
        pad(shifted.getUTCHours()) + ":" +
        pad(shifted.getUTCMinutes()) + ":" +
        pad(shifted.getUTCSeconds()) + " UTC+8";
    }

    function formatUtc8TimeOnly(value) {
      const text = formatUtc8Timestamp(value);
      const matched = text.match(/\\b(\\d{2}:\\d{2}:\\d{2})\\b/);
      return matched ? matched[1] : "";
    }

    function exportFileNameFromResponse(res) {
      const explicit = res.headers.get("x-export-filename");
      if (explicit) return explicit;
      const disposition = res.headers.get("content-disposition") || "";
      const matched = disposition.match(/filename="?([^";]+)"?/i);
      return matched ? matched[1] : "free-register-success.zip";
    }

    function sleep(ms) {
      return new Promise((resolve) => window.setTimeout(resolve, ms));
    }

    function updateHeroSmsBalance(balance) {
      const meta = $("heroSmsBalanceMeta");
      meta.title = "";
      if (!balance) {
        setText("heroSmsBalance", "-");
        setText("heroSmsBalanceMeta", "");
        return;
      }
      if (Array.isArray(balance.balances)) {
        const parts = balance.balances.map((item) => {
          if (item && item.ok && item.amount != null) {
            const suffix = item.disabled ? " (停用)" : "";
            return String(item.label || ("Key #" + item.index)) + ": " + formatBalanceAmount(item.amount) + suffix;
          }
          return String((item && item.label) || "Key") + ": 查询失败";
        });
        setText("heroSmsBalance", balance.ok && balance.amount != null ? "合计 " + formatBalanceAmount(balance.amount) : "查询失败");
        const time = formatUtc8TimeOnly(balance.fetchedAt);
        const text = parts.join(" | ") + (time ? " · " + (balance.cached ? "缓存 " : "刚更新 ") + time : "");
        setText("heroSmsBalanceMeta", text);
        meta.title = text;
        return;
      }
      if (balance.ok && balance.amount != null) {
        setText("heroSmsBalance", formatBalanceAmount(balance.amount));
        const time = formatUtc8TimeOnly(balance.fetchedAt);
        setText("heroSmsBalanceMeta", (balance.cached ? "缓存" : "刚更新") + (time ? " " + time : ""));
        return;
      }
      setText("heroSmsBalance", "查询失败");
      setText("heroSmsBalanceMeta", String(balance.error || "").slice(0, 64));
    }

    function updateHeroSmsRps(status) {
      const list = $("heroSmsRpsList");
      list.textContent = "";
      if (!status || !Array.isArray(status.keys) || status.keys.length === 0) {
        setText("heroSmsRpsTotal", "0 / 0");
        return;
      }

      const totalRps = Number(status.totalRps || 0);
      const totalLimit = Number(status.totalLimit || 0);
      const pendingTotal = Number(status.pendingTotal || 0);
      setText("heroSmsRpsTotal", formatRpsAmount(totalRps) + " / " + (totalLimit || 0) + (pendingTotal > 0 ? " · 等 " + pendingTotal : ""));
      const fragment = document.createDocumentFragment();
      for (const item of status.keys) {
        const pending = Number(item.pendingTotal || 0);
        const row = document.createElement("div");
        row.className = "sms-rps-item" + (item.disabled ? " disabled" : "");
        row.title = String(item.label || "Key") + " · " + String(item.windowCount || 0) + " req/" + String(item.windowMs || 1000) + "ms" + (pending > 0 ? " · pending " + pending : "");
        const label = document.createElement("span");
        label.textContent = String(item.label || ("Key #" + item.index));
        const value = document.createElement("span");
        value.textContent = (item.disabled ? "停用 " : "") + formatRpsAmount(item.rps) + " / " + String(item.rpsLimit || 0) + (pending > 0 ? " 等" + pending : "");
        row.appendChild(label);
        row.appendChild(value);
        fragment.appendChild(row);
      }
      list.appendChild(fragment);
    }

    function updateSuccessCost(cost) {
      if (!cost || Number(cost.count || 0) <= 0) {
        setText("successCostMeta", "");
        return;
      }
      const lines = [
        "总 " + formatCostAmount(cost.total, cost.currency),
        "均 " + formatCostAmount(cost.average, cost.currency)
      ];
      const estimated = Number(cost.estimatedCount || 0);
      if (estimated > 0) lines.push(estimated + " 估算");
      setText("successCostMeta", lines.join("\\n"));
    }

    function updateSuccessRunMeta(runner) {
      const okCount = Number(runner && runner.okCount || 0);
      const avgMs = Number(runner && runner.avgSuccessIntervalMs || 0);
      setText("successRunMeta", "本轮 " + okCount + " · 均时 " + formatElapsedMs(avgMs));
    }

    function countryLabel(id) {
      const matched = state.smsCountries.find((item) => Number(item.id) === Number(id));
      return matched ? matched.label + " #" + matched.id : "Country #" + id;
    }

    function countrySearchText(country) {
      return (String(country.label || "") + " " + String(country.id || "")).toLowerCase();
    }

    function renderCountryPicker() {
      const picker = $("smsCountryPicker");
      const query = ($("smsCountrySearch").value || "").trim().toLowerCase();
      picker.innerHTML = "";
      let visibleCount = 0;
      for (const country of state.smsCountries) {
        if (state.selectedSmsCountries.includes(Number(country.id))) continue;
        if (query && !countrySearchText(country).includes(query)) continue;
        const option = document.createElement("option");
        option.value = String(country.id);
        option.textContent = country.label + " #" + country.id;
        picker.appendChild(option);
        visibleCount += 1;
      }
      if (!visibleCount) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = query ? "无匹配国家" : "没有可添加国家";
        picker.appendChild(option);
      }
      $("smsAddCountryBtn").disabled = visibleCount === 0;
    }

    function renderSelectedCountries() {
      const box = $("smsCountryList");
      box.innerHTML = "";
      state.selectedSmsCountries.forEach((id, index) => {
        const pill = document.createElement("span");
        pill.className = "country-pill";
        const text = document.createElement("span");
        text.textContent = countryLabel(id);
        pill.appendChild(text);
        const up = document.createElement("button");
        up.type = "button";
        up.textContent = "U";
        up.title = "上移";
        up.setAttribute("aria-label", "上移");
        up.disabled = index === 0;
        up.onclick = () => {
          markSmsConfigDirty();
          const next = [...state.selectedSmsCountries];
          [next[index - 1], next[index]] = [next[index], next[index - 1]];
          state.selectedSmsCountries = next;
          renderSelectedCountries();
        };
        const down = document.createElement("button");
        down.type = "button";
        down.textContent = "D";
        down.title = "下移";
        down.setAttribute("aria-label", "下移");
        down.disabled = index === state.selectedSmsCountries.length - 1;
        down.onclick = () => {
          markSmsConfigDirty();
          const next = [...state.selectedSmsCountries];
          [next[index], next[index + 1]] = [next[index + 1], next[index]];
          state.selectedSmsCountries = next;
          renderSelectedCountries();
        };
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "X";
        remove.title = "删除";
        remove.setAttribute("aria-label", "删除");
        remove.onclick = () => {
          markSmsConfigDirty();
          state.selectedSmsCountries = state.selectedSmsCountries.filter((item) => item !== id);
          renderCountryPicker();
          renderSelectedCountries();
        };
        pill.appendChild(up);
        pill.appendChild(down);
        pill.appendChild(remove);
        box.appendChild(pill);
      });
      renderCountryPicker();
    }

    function setInputValue(id, value) {
      $(id).value = value == null ? "" : String(value);
    }

    function normalizeSmsProxyStrategy(hero) {
      if (hero && (hero.proxyStrategy === "hero_sms" || hero.proxyStrategy === "proxies" || hero.proxyStrategy === "direct")) {
        return hero.proxyStrategy;
      }
      return hero && hero.useProxy === true ? "proxies" : "direct";
    }

    function normalizeProxyMode(proxy) {
      return proxy && proxy.mode === "phone_country" ? "phone_country" : "pool";
    }

    function fillProxyForm(proxy) {
      $("proxyMode").value = normalizeProxyMode(proxy);
      setInputValue("phoneCountryTemplate", proxy && proxy.phoneCountryTemplate || "");
    }

    function markSmsConfigDirty() {
      state.smsConfigDirty = true;
      setText("smsConfigMsg", "有未保存改动");
    }

    function fillSmsForm(hero) {
      $("smsProxyStrategy").value = normalizeSmsProxyStrategy(hero);
      $("smsApiKeyStrategy").value = hero.apiKeyStrategy === "fill_first" ? "fill_first" : "round_robin";
      $("smsAcquirePriority").value = hero.acquirePriority || "country";
      setInputValue("smsMinPrice", hero.minPrice);
      setInputValue("smsMaxPrice", hero.maxPrice);
      setInputValue("smsPriceStep", hero.priceStep);
      setInputValue("smsMaxPhoneTries", hero.maxPhoneTries);
      state.selectedSmsCountries = Array.isArray(hero.countries) ? hero.countries.map(Number).filter(Boolean) : [];
      renderSelectedCountries();
    }

    async function loadSmsConfig(refreshCountries = false) {
      const data = await apiJson("/api/sms-config" + (refreshCountries ? "?refreshCountries=1" : ""));
      state.smsCountries = data.countries || [];
      const source = data.countriesSource === "api" ? "HeroSMS 接口" : "内置兜底";
      const cached = data.countriesCached ? " / 永久缓存" : "";
      setText("smsCountrySource", "国家列表：" + source + cached);
      if (data.countriesError) {
        const prefix = data.countriesSource === "fallback" ? "国家列表接口失败，已用内置列表：" : "国家列表刷新失败，继续使用永久缓存：";
        setText("smsConfigMsg", prefix + String(data.countriesError).slice(0, 80));
      }
      if (data.run) $("runConcurrencyMode").value = data.run.concurrencyMode === "adaptive" ? "adaptive" : "fixed";
      if (data.run) $("successAfterEmailOtp").checked = data.run.successAfterEmailOtp === true;
      fillProxyForm(data.proxy || {});
      fillSmsForm(data.heroSMS || {});
      state.smsConfigDirty = false;
      renderCountryPicker();
    }

    function smsPayloadFromForm() {
      return {
        concurrencyMode: $("runConcurrencyMode").value,
        successAfterEmailOtp: $("successAfterEmailOtp").checked,
        proxyMode: $("proxyMode").value,
        phoneCountryTemplate: $("phoneCountryTemplate").value,
        countries: state.selectedSmsCountries,
        apiKeyStrategy: $("smsApiKeyStrategy").value,
        acquirePriority: $("smsAcquirePriority").value,
        minPrice: Number($("smsMinPrice").value),
        maxPrice: Number($("smsMaxPrice").value),
        priceStep: Number($("smsPriceStep").value),
        maxPhoneTries: Number($("smsMaxPhoneTries").value),
        proxyStrategy: $("smsProxyStrategy").value
      };
    }

    function openImportModal() {
      setText("importModalMsg", "");
      $("importModal").classList.add("open");
      $("emailText").focus();
    }

    function closeImportModal() {
      $("importModal").classList.remove("open");
    }

    function applyStatusData(data) {
      state.authed = true;
      showApp();
      const pool = data.pool || {};
      const runner = data.runner || {};
      state.inflightCount = Number(pool.inflight || 0);
      state.runnerBusy = runner.status === "running" || runner.status === "pausing" || runner.status === "force_pausing" || Number(runner.activeWorkers || 0) > 0;
      setText("countSource", pool.source || 0);
      setText("countSuccess", pool.success || 0);
      updateSuccessCost(data.successCost);
      updateSuccessRunMeta(runner);
      setText("countInflight", state.inflightCount);
      setText("countFailed", pool.failed || 0);
      updateInflightButtons();
      updateHeroSmsBalance(data.heroSmsBalance);
      updateHeroSmsRps(data.heroSmsRps);
      setText("runnerStatus", runner.status || "idle");
      updateMemory(runner.memory);
      renderWorkers(runner.workers || []);
      if (data.configPath) setText("configPath", data.configPath);
      if (data.effectiveConfig && data.effectiveConfig.run) {
        const run = data.effectiveConfig.run;
        const proxy = data.effectiveConfig.proxy || {};
        const mode = run.runUntilEmpty ? "持续运行到邮箱池为空" : "固定数量";
        const concurrencyMode = (runner.concurrencyMode || run.concurrencyMode) === "adaptive" ? "adaptive" : "fixed";
        if (!state.smsConfigDirty) {
          $("runConcurrencyMode").value = run.concurrencyMode === "adaptive" ? "adaptive" : "fixed";
          $("successAfterEmailOtp").checked = run.successAfterEmailOtp === true;
          fillProxyForm(proxy);
        }
        const proxyMode = normalizeProxyMode(proxy) === "phone_country" ? "手机号国家代理" : "代理池";
        const otpMode = run.successAfterEmailOtp === true ? "邮箱OTP即成功" : "完整OAuth";
        const parts = ["模式 " + mode, "并发 " + concurrencyMode, "OAuth " + otpMode, "注册代理 " + proxyMode, "total " + run.total, "concurrency " + run.concurrency];
        if (concurrencyMode === "adaptive") {
          parts.push("worker " + Number(runner.currentConcurrency || 0) + "/" + Number(runner.targetConcurrency || 0) + "/max " + Number(runner.maxConcurrency || 0));
          parts.push("HeroSMS " + formatRpsAmount(runner.adaptiveSmsRps || 0) + "/" + Number(runner.adaptiveSmsRpsLimit || 0) + " target " + formatPercent(runner.adaptiveTargetSmsRpsUtilization || run.adaptiveTargetSmsRpsUtilization || 0));
          if (Number(runner.adaptiveSlotWaiters || 0) > 0) parts.push("等待 " + Number(runner.adaptiveSlotWaiters || 0));
          if (runner.adaptiveReason) parts.push(String(runner.adaptiveReason));
        }
        setText("taskConfig", parts.join(" · "));
      }
    }

    function updateInflightButtons() {
      const disabled = state.runnerBusy || state.inflightCount <= 0;
      $("returnInflightBtn").disabled = disabled;
      $("failInflightBtn").disabled = disabled;
      $("returnInflightBtn").title = state.runnerBusy ? "任务运行中不能操作" : "归还进行中邮箱到待使用";
      $("failInflightBtn").title = state.runnerBusy ? "任务运行中不能操作" : "标记进行中邮箱为失败";
    }

    async function refreshStatus() {
      try {
        applyStatusData(await apiJson("/api/status"));
      } catch (error) {
        if (state.authed) setText("taskMsg", error.message);
      }
    }

    async function refreshHeroSmsRps() {
      if (!state.authed) return;
      try {
        const data = await apiJson("/api/sms-rps");
        updateHeroSmsRps(data.heroSmsRps);
      } catch {
        // RPS 是辅助状态，失败时等待下一轮刷新即可。
      }
    }

    async function refreshHeroSmsBalance() {
      if (state.heroSmsBalanceRefreshing) return;
      state.heroSmsBalanceRefreshing = true;
      $("refreshHeroSmsBalanceBtn").disabled = true;
      setText("heroSmsBalanceMeta", "刷新中");
      try {
        applyStatusData(await apiJson("/api/status?refreshBalance=1"));
      } catch (error) {
        setText("heroSmsBalance", "查询失败");
        setText("heroSmsBalanceMeta", error.message);
      } finally {
        state.heroSmsBalanceRefreshing = false;
        $("refreshHeroSmsBalanceBtn").disabled = false;
      }
    }

    async function mutateInflight(path, confirmMessage, doneMessage) {
      if (state.runnerBusy) {
        setText("taskMsg", "任务运行中，不能操作进行中邮箱");
        return;
      }
      if (state.inflightCount <= 0) {
        setText("taskMsg", "没有进行中邮箱");
        return;
      }
      if (!window.confirm(confirmMessage.replace("{count}", String(state.inflightCount)))) return;
      $("returnInflightBtn").disabled = true;
      $("failInflightBtn").disabled = true;
      try {
        const data = await apiJson(path, {method: "POST", body: "{}"});
        const result = data.result || {};
        setText("taskMsg", doneMessage(result));
        await refreshStatus();
      } catch (error) {
        setText("taskMsg", error.message);
        await refreshStatus();
      }
    }

    function formatLog(item) {
      return "[" + item.time + "] " + item.level + " " + item.message;
    }

    function closeLogStream() {
      if (state.logSource) {
        state.logSource.close();
        state.logSource = null;
      }
    }

    function scheduleLogFlush() {
      if (state.logFlushTimer) return;
      state.logFlushTimer = window.setTimeout(flushLogs, 300);
    }

    function isLogNearBottom(logBox) {
      return logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 48;
    }

    function updateLogFollowTail() {
      if (!state.logsExpanded) return;
      state.logsFollowTail = isLogNearBottom($("logs"));
    }

    function renderLogBox() {
      const logBox = $("logs");
      logBox.textContent = state.logLines.join("\\n");
      logBox.scrollTop = logBox.scrollHeight;
      state.logsFollowTail = true;
    }

    function setLogsExpanded(expanded) {
      state.logsExpanded = Boolean(expanded);
      $("logsBody").hidden = !state.logsExpanded;
      $("copyLogsBtn").hidden = !state.logsExpanded;
      $("toggleLogsBtn").textContent = state.logsExpanded ? "折叠" : "展开";
      $("toggleLogsBtn").setAttribute("aria-expanded", String(state.logsExpanded));
      setText("logsState", state.logsExpanded ? "实时" : "已折叠" + (state.logLines.length ? " · " + state.logLines.length + " 行" : ""));
      if (state.logsExpanded) {
        renderLogBox();
        connectLogStream();
      } else {
        closeLogStream();
      }
    }

    function flushLogs() {
      state.logFlushTimer = 0;
      if (!state.pendingLogs.length) return;
      const logBox = state.logsExpanded ? $("logs") : null;
      const shouldFollowTail = Boolean(logBox && state.logsFollowTail);
      const previousScrollTop = logBox ? logBox.scrollTop : 0;
      state.logLines.push(...state.pendingLogs.splice(0));
      if (state.logLines.length > state.maxVisibleLogs) {
        state.logLines.splice(0, state.logLines.length - state.maxVisibleLogs);
      }
      if (!state.logsExpanded) {
        setText("logsState", "已折叠 · " + state.logLines.length + " 行");
        return;
      }
      logBox.textContent = state.logLines.join("\\n");
      if (shouldFollowTail) {
        logBox.scrollTop = logBox.scrollHeight;
      } else {
        logBox.scrollTop = previousScrollTop;
      }
    }

    async function copyVisibleLogs() {
      try {
        const text = $("logs").textContent || "";
        if (!text) {
          setText("logsState", "暂无日志可复制");
          return;
        }
        await navigator.clipboard.writeText(text);
        setText("logsState", "已复制 " + state.logLines.length + " 行");
      } catch (error) {
        setText("logsState", "复制失败：" + (error.message || error));
      }
    }

    function appendLog(item) {
      appendLogs([item]);
    }

    function appendLogs(items) {
      if (!Array.isArray(items) || !items.length) return;
      state.pendingLogs.push(...items.map(formatLog));
      if (state.pendingLogs.length > state.maxVisibleLogs) {
        state.pendingLogs.splice(0, state.pendingLogs.length - state.maxVisibleLogs);
      }
      scheduleLogFlush();
    }

    function connectLogStream() {
      if (!state.authed || !state.logsExpanded || state.logSource) return;
      const source = new EventSource("/api/logs/stream");
      state.logSource = source;
      source.addEventListener("log", (event) => {
        try {
          appendLog(JSON.parse(event.data));
        } catch {}
      });
      source.addEventListener("logs", (event) => {
        try {
          appendLogs(JSON.parse(event.data));
        } catch {}
      });
      source.addEventListener("ready", () => {
        appendLog({time: formatUtc8Timestamp(), level: "info", message: "[admin] 实时日志已连接"});
      });
      source.onerror = () => {
        const now = Date.now();
        if (now - state.lastLogStreamErrorAt > 10000) {
          state.lastLogStreamErrorAt = now;
          appendLog({time: formatUtc8Timestamp(), level: "warn", message: "[admin] 实时日志连接中断，浏览器会自动重连"});
        }
      };
    }

    async function loadConfig() {
      const data = await apiJson("/api/config");
      setConfigContent(data.content || "");
      setText("configPath", data.path || "");
    }

    $("loginBtn").onclick = async () => {
      try {
        await apiJson("/api/login", {method: "POST", body: JSON.stringify({password: $("password").value})});
        $("password").value = "";
        setText("loginMsg", "");
        state.authed = true;
        showApp();
        await Promise.all([refreshStatus(), loadConfig(), loadSmsConfig()]);
      } catch (error) {
        setText("loginMsg", error.message);
      }
    };

    $("password").addEventListener("keydown", (event) => {
      if (event.key === "Enter") $("loginBtn").click();
    });

    $("logoutBtn").onclick = async () => {
      await api("/api/logout", {method: "POST", body: "{}"});
      state.authed = false;
      closeLogStream();
      showLogin();
    };

    $("startBtn").onclick = async () => {
      try {
        await apiJson("/api/task/start", {method: "POST", body: "{}"});
        setText("taskMsg", "任务已启动");
        await refreshStatus();
      } catch (error) {
        setText("taskMsg", error.message);
      }
    };

    $("pauseBtn").onclick = async () => {
      try {
        await apiJson("/api/task/pause", {method: "POST", body: "{}"});
        setText("taskMsg", "暂停请求已发送");
        await refreshStatus();
      } catch (error) {
        setText("taskMsg", error.message);
      }
    };

    $("forcePauseBtn").onclick = async () => {
      try {
        await apiJson("/api/task/force-pause", {method: "POST", body: "{}"});
        setText("taskMsg", "强制暂停请求已发送");
        await refreshStatus();
      } catch (error) {
        setText("taskMsg", error.message);
      }
    };

    $("returnInflightBtn").onclick = () => mutateInflight(
      "/api/email/inflight/return",
      "确认把 {count} 个进行中邮箱归还到待使用？",
      (result) => "已归还进行中邮箱 " + (result.returned || 0) + " 个",
    );

    $("failInflightBtn").onclick = () => mutateInflight(
      "/api/email/inflight/fail",
      "确认把 {count} 个进行中邮箱标记为失败？",
      (result) => "已标记失败 " + (result.failed || 0) + " 个，清理进行中 " + (result.cleared || 0) + " 个",
    );

    ["runConcurrencyMode", "successAfterEmailOtp", "proxyMode", "phoneCountryTemplate", "smsProxyStrategy", "smsApiKeyStrategy", "smsAcquirePriority", "smsMinPrice", "smsMaxPrice", "smsPriceStep", "smsMaxPhoneTries"].forEach((id) => {
      $(id).addEventListener("input", markSmsConfigDirty);
      $(id).addEventListener("change", markSmsConfigDirty);
    });
    $("smsCountrySearch").addEventListener("input", renderCountryPicker);
    $("logs").addEventListener("scroll", updateLogFollowTail, {passive: true});
    $("copyLogsBtn").onclick = copyVisibleLogs;
    $("toggleLogsBtn").onclick = () => setLogsExpanded(!state.logsExpanded);
    $("refreshHeroSmsBalanceBtn").onclick = refreshHeroSmsBalance;
    $("openImportModalBtn").onclick = openImportModal;
    $("closeImportModalBtn").onclick = closeImportModal;
    $("smsAddCountryBtn").onclick = () => {
      const id = Number($("smsCountryPicker").value);
      if (!Number.isFinite(id) || id <= 0 || state.selectedSmsCountries.includes(id)) return;
      markSmsConfigDirty();
      state.selectedSmsCountries = [...state.selectedSmsCountries, id];
      $("smsCountrySearch").value = "";
      renderSelectedCountries();
    };
    $("reloadSmsConfigBtn").onclick = async () => {
      try {
        await loadSmsConfig(true);
        state.smsConfigDirty = false;
        setText("smsConfigMsg", "已重新加载");
      } catch (error) {
        setText("smsConfigMsg", error.message);
      }
    };
    $("saveSmsConfigBtn").onclick = async () => {
      try {
        await apiJson("/api/sms-config", {method: "PUT", body: JSON.stringify(smsPayloadFromForm())});
        state.smsConfigDirty = false;
        await Promise.all([refreshStatus(), loadConfig(), loadSmsConfig()]);
        setText("smsConfigMsg", "已保存");
      } catch (error) {
        setText("smsConfigMsg", error.message);
      }
    };
    $("importModal").addEventListener("click", (event) => {
      if (event.target === $("importModal")) closeImportModal();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && $("importModal").classList.contains("open")) {
        closeImportModal();
      }
    });

    $("importBtn").onclick = async () => {
      try {
        const data = await apiJson("/api/email/import", {method: "POST", body: JSON.stringify({text: $("emailText").value})});
        const r = data.result || {};
        const summary = "导入 " + (r.imported || 0) + "，重复 " + (r.duplicate || 0) + "，无效 " + (r.invalid || 0);
        setText("importMsg", summary);
        setText("importModalMsg", summary);
        $("emailText").value = "";
        closeImportModal();
        await refreshStatus();
      } catch (error) {
        setText("importModalMsg", error.message);
      }
    };

    $("exportBtn").onclick = async () => {
      try {
        const res = await api("/api/email/success/export", {method: "POST", body: "{}"});
        if (!res.ok) throw new Error("导出失败");
        const exportId = res.headers.get("x-export-id") || "";
        const exportCount = Number(res.headers.get("x-export-count") || "0");
        const fileName = exportFileNameFromResponse(res);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
        setText("taskMsg", "导出包已下载：" + fileName);
        if (exportCount > 0 && exportId) {
          await sleep(800);
          const shouldClear = window.confirm("确认已经保存 " + fileName + " 后，删除这 " + exportCount + " 个成功邮箱？");
          if (shouldClear) {
            const data = await apiJson("/api/email/success/export/clear", {method: "POST", body: JSON.stringify({exportId})});
            setText("taskMsg", "已删除 " + (data.deleted || exportCount) + " 个已导出成功邮箱");
          } else {
            setText("taskMsg", "已导出，成功邮箱已保留");
          }
        } else if (exportCount > 0) {
          setText("taskMsg", "已导出，但没有删除令牌，成功邮箱已保留");
        } else {
          setText("taskMsg", "导出完成，没有成功邮箱需要删除");
        }
        await refreshStatus();
      } catch (error) {
        setText("taskMsg", error.message);
      }
    };

    $("saveConfigBtn").onclick = async () => {
      try {
        await apiJson("/api/config", {method: "PUT", body: JSON.stringify({content: getConfigContent()})});
        setText("configMsg", "已保存");
        await Promise.all([refreshStatus(), loadSmsConfig()]);
      } catch (error) {
        setText("configMsg", error.message);
      }
    };

    $("reloadConfigBtn").onclick = async () => {
      try {
        await loadConfig();
        await loadSmsConfig();
        setText("configMsg", "已重新加载");
      } catch (error) {
        setText("configMsg", error.message);
      }
    };

    refreshStatus().then(() => {
      if (state.authed) {
        connectLogStream();
        Promise.all([loadConfig(), loadSmsConfig()]);
      }
    });
    setInterval(refreshStatus, 2500);
    setInterval(refreshHeroSmsRps, 1000);
  </script>
</body>
</html>`;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
        if (req.method === "GET" && await sendVendorAsset(res, url.pathname)) {
            return;
        }
        if (url.pathname === "/" && req.method === "GET") {
            send(res, 200, html(), {"content-type": "text/html; charset=utf-8"});
            return;
        }
        if (url.pathname.startsWith("/api/")) {
            await handleApi(req, res, url.pathname);
            return;
        }
        sendError(res, 404, "Not found");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendError(res, 500, message);
    }
}

function installShutdownHandlers(server: ReturnType<typeof createServer>): void {
    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals, exitCode: number): void => {
        if (shuttingDown) {
            process.exit(exitCode);
        }
        shuttingDown = true;
        logger.warn(`[admin] 收到 ${signal}，强制暂停任务并退出`);
        runner.forcePause();
        server.close((error) => {
            if (error) {
                logger.error(`[admin] 关闭 HTTP 服务失败: ${error.message}`);
            }
        });
        const forceExitTimer = setTimeout(() => {
            logger.error(`[admin] ${signal} 后等待任务退出超时，强制退出`);
            process.exit(exitCode);
        }, 9000);
        forceExitTimer.unref?.();
        void runner.wait().finally(() => {
            clearTimeout(forceExitTimer);
            process.exit(exitCode);
        });
    };

    process.once("SIGINT", () => shutdown("SIGINT", 130));
    process.once("SIGTERM", () => shutdown("SIGTERM", 143));
}

async function main(): Promise<void> {
    installConsoleCapture();
    await loadPersistentSessions();
    const port = adminPort();
    if (adminPassword() === "changeme") {
        logger.warn("[admin] FREE_REGISTER_ADMIN_PASSWORD 未设置，当前使用默认密码 changeme");
    }
    const server = createServer((req, res) => {
        void handleRequest(req, res);
    });
    installShutdownHandlers(server);
    server.listen(port, "0.0.0.0", () => {
        logger.info(`[admin] listening on http://0.0.0.0:${port}`);
    });
}

main().catch((error) => {
    console.error(`[admin] failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    process.exitCode = 1;
});
