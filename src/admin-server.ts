import {createHash, randomBytes, timingSafeEqual} from "node:crypto";
import {createServer, type IncomingMessage, type ServerResponse} from "node:http";
import {mkdir, readFile, readdir, rename, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import {EmailPool, emailFromLine} from "./email-pool.js";
import {loadConfig, parseToml, proxyForWorker, redactProxy, type AppConfig} from "./config.js";
import {RegisterTaskRunner, type RegisterLogger} from "./runner.js";
import {createHeroSmsProvider} from "./sms/heroSMS.js";

type JsonValue = null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue};
type LogLevel = "info" | "warn" | "error";

interface LogEntry {
    id: number;
    time: string;
    level: LogLevel;
    message: string;
}

const DEFAULT_PORT = 8788;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_LOG_LINES = 2000;
const MAX_LOG_LINE_CHARS = 5000;
const SESSION_COOKIE = "fr_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const HERO_SMS_BALANCE_TTL_MS = 30 * 1000;
const HERO_SMS_BALANCE_TIMEOUT_MS = 5000;
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

class LogBuffer implements RegisterLogger {
    private readonly lines: LogEntry[] = [];
    private readonly subscribers = new Map<number, ServerResponse>();
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
        const time = new Date().toISOString();
        for (const line of String(message).split(/\r?\n/)) {
            const entry = {
                id: this.nextId,
                time,
                level,
                message: truncateLogLine(line),
            };
            this.nextId += 1;
            this.lines.push(entry);
            this.broadcast(entry);
        }
        if (this.lines.length > MAX_LOG_LINES) {
            this.lines.splice(0, this.lines.length - MAX_LOG_LINES);
        }
    }

    private broadcast(entry: LogEntry): void {
        const payload = sseEntry(entry);
        for (const [id, res] of this.subscribers) {
            if (res.destroyed || res.writableEnded) {
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
let heroSmsBalanceCache: {key: string; expiresAt: number; value: JsonValue} | null = null;
let heroSmsBalanceInFlight: {key: string; promise: Promise<JsonValue>} | null = null;
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

function sseEntry(entry: LogEntry): string {
    return `id: ${entry.id}\nevent: log\ndata: ${JSON.stringify(entry)}\n\n`;
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
    const expiresAt = sessions.get(token);
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) {
        sessions.delete(token);
        return false;
    }
    sessions.set(token, Date.now() + SESSION_TTL_MS);
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
        ? logger.recentAfter(lastId)
        : logger.recent(250) as unknown as LogEntry[];
    for (const entry of backlog) {
        res.write(sseEntry(entry));
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

function publicConfigSummary(config: AppConfig): JsonValue {
    return {
        run: config.run as unknown as JsonValue,
        proxies: config.proxies.map(redactProxy),
        emailPool: config.emailPool as unknown as JsonValue,
        cpaJson: config.cpaJson as unknown as JsonValue,
        sentinelSdk: config.sentinelSdk as unknown as JsonValue,
    };
}

function heroSmsBalanceCacheKey(config: AppConfig): string {
    return createHash("sha256")
        .update(config.heroSMS.apiKey)
        .update("\0")
        .update(proxyForWorker(config, 0))
        .digest("hex");
}

async function heroSmsBalanceStatus(config: AppConfig): Promise<JsonValue> {
    if (!config.heroSMS.apiKey) {
        return {ok: false, error: "HeroSMS api_key 未配置"};
    }

    const key = heroSmsBalanceCacheKey(config);
    const now = Date.now();
    if (heroSmsBalanceCache?.key === key && heroSmsBalanceCache.expiresAt > now) {
        return {...heroSmsBalanceCache.value as Record<string, JsonValue>, cached: true};
    }

    if (heroSmsBalanceInFlight?.key === key) {
        return heroSmsBalanceInFlight.promise;
    }

    const promise: Promise<JsonValue> = (async (): Promise<JsonValue> => {
        try {
            const provider = createHeroSmsProvider({
                apiKey: config.heroSMS.apiKey,
                proxyUrl: proxyForWorker(config, 0),
                timeoutMs: HERO_SMS_BALANCE_TIMEOUT_MS,
            });
            const balance = await provider.getBalance();
            return {
                ok: true,
                amount: balance.amount,
                raw: typeof balance.raw === "string" ? balance.raw : JSON.stringify(balance.raw),
                fetchedAt: new Date().toISOString(),
            };
        } catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
                fetchedAt: new Date().toISOString(),
            };
        }
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

async function buildSuccessExportZip(successLines: string[], cpaJsonDir: string): Promise<{buffer: Buffer; matched: number; missing: string[]}> {
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

    const buffer = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        compressionOptions: {level: 6},
    });
    return {buffer, matched: cpaFiles.size, missing};
}

async function currentStatus(): Promise<JsonValue> {
    try {
        const config = loadConfig();
        const pool = new EmailPool(config.emailPool);
        return {
            ok: true,
            runner: runner.getSnapshot() as unknown as JsonValue,
            pool: await pool.stats() as unknown as JsonValue,
            heroSmsBalance: await heroSmsBalanceStatus(config),
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
        sessions.set(token, Date.now() + SESSION_TTL_MS);
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
        if (token) sessions.delete(token);
        res.setHeader("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
        sendJson(res, 200, {ok: true});
        return;
    }

    if (pathname === "/api/status" && req.method === "GET") {
        sendJson(res, 200, await currentStatus());
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
        logger.info("[admin] config.toml 已保存，下次启动任务会读取最新配置");
        sendJson(res, 200, {ok: true});
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
        const {buffer, matched, missing} = await buildSuccessExportZip(successLines, config.cpaJson.dir);
        await pool.clearSuccessEmails(successLines.map(emailFromLine));
        const filename = `free-register-success.${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
        logger.info(`[admin] 导出并清空成功邮箱 emails=${successLines.length} cpa_json=${matched} missing=${missing.length} bytes=${buffer.length}`);
        send(res, 200, buffer, {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="${filename}"`,
        });
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
    header { height: 48px; display: flex; align-items: center; justify-content: space-between; padding: 0 18px; border-bottom: 1px solid var(--line); background: rgba(247,247,245,.9); position: sticky; top: 0; backdrop-filter: blur(12px); }
    h1 { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: 0; }
    main { width: min(1280px, calc(100vw - 24px)); margin: 12px auto 28px; display: grid; gap: 10px; }
    .grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
    .panel h2 { margin: 0; font-size: 13px; font-weight: 650; }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .metric { color: var(--muted); font-size: 11px; padding-block: 8px; }
    .metric strong { display: block; margin-top: 2px; color: var(--text); font-size: 20px; line-height: 1.05; font-weight: 680; }
    .metric .sub { display: block; margin-top: 3px; color: var(--muted); font-size: 11px; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .toolbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .split-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .stack { display: grid; gap: 8px; }
    button, input, textarea { font: inherit; }
    button { height: 30px; padding: 0 10px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; }
    button.secondary { background: #fff; color: var(--text); border-color: var(--line); }
    button.danger { background: var(--danger); border-color: var(--danger); }
    button:disabled { opacity: .45; cursor: not-allowed; }
    input { height: 30px; padding: 0 8px; border: 1px solid var(--line); border-radius: 6px; background: #fff; min-width: 120px; }
    textarea { width: 100%; min-height: 160px; resize: vertical; border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: #fff; color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.42; }
    #configText { min-height: 330px; }
    .CodeMirror { height: 340px; border: 1px solid var(--line); border-radius: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.42; }
    .CodeMirror-scroll { border-radius: 8px; }
    .CodeMirror-gutters { background: #fafafa; border-right: 1px solid var(--line); }
    .CodeMirror-linenumber { color: #9a9a94; }
    .cm-comment { color: #587d4b; }
    .cm-atom, .cm-number { color: #8a4d1c; }
    .cm-string { color: #1b6b68; }
    .cm-keyword, .cm-property { color: #403f3c; font-weight: 600; }
    #logs { min-height: 260px; max-height: 420px; overflow: auto; white-space: pre-wrap; border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: #111; color: #eee; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.38; }
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
    .msg { min-height: 18px; color: var(--muted); }
    @media (max-width: 760px) { header { padding: 0 12px; } .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
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
      <div class="row">
        <span id="runnerStatus" class="status">idle</span>
        <button id="logoutBtn" class="secondary">退出</button>
      </div>
    </header>
    <main>
      <section class="grid">
        <div class="panel metric">待使用<strong id="countSource">0</strong></div>
        <div class="panel metric">成功<strong id="countSuccess">0</strong></div>
        <div class="panel metric">进行中<strong id="countInflight">0</strong></div>
        <div class="panel metric">失败<strong id="countFailed">0</strong></div>
        <div class="panel metric">HeroSMS 余额<strong id="heroSmsBalance">-</strong><span id="heroSmsBalanceMeta" class="sub"></span></div>
      </section>

      <section class="panel stack">
        <div class="panel-head">
          <h2>任务与邮箱</h2>
          <span id="taskConfig" class="muted"></span>
        </div>
        <div class="split-row">
          <div class="toolbar">
            <button id="startBtn">开始</button>
            <button id="pauseBtn" class="secondary">暂停</button>
            <button id="openImportModalBtn" class="secondary">导入邮箱</button>
            <button id="exportBtn" class="secondary">导出成功邮箱与 CPA JSON</button>
          </div>
          <div class="row">
            <span id="taskMsg" class="msg"></span>
            <span id="importMsg" class="msg"></span>
          </div>
        </div>
      </section>

      <section class="panel stack">
        <div class="panel-head">
          <h2>日志</h2>
          <span class="muted">实时</span>
        </div>
        <pre id="logs"></pre>
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
      maxVisibleLogs: 600,
      configEditor: null
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

    function formatBalanceTime(value) {
      const time = Date.parse(value || "");
      if (!Number.isFinite(time)) return "";
      return new Date(time).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit"});
    }

    function updateHeroSmsBalance(balance) {
      if (!balance) {
        setText("heroSmsBalance", "-");
        setText("heroSmsBalanceMeta", "");
        return;
      }
      if (balance.ok && balance.amount != null) {
        setText("heroSmsBalance", formatBalanceAmount(balance.amount));
        const time = formatBalanceTime(balance.fetchedAt);
        setText("heroSmsBalanceMeta", (balance.cached ? "缓存" : "刚更新") + (time ? " " + time : ""));
        return;
      }
      setText("heroSmsBalance", "查询失败");
      setText("heroSmsBalanceMeta", String(balance.error || "").slice(0, 64));
    }

    function openImportModal() {
      setText("importModalMsg", "");
      $("importModal").classList.add("open");
      $("emailText").focus();
    }

    function closeImportModal() {
      $("importModal").classList.remove("open");
    }

    async function refreshStatus() {
      try {
        const data = await apiJson("/api/status");
        state.authed = true;
        showApp();
        const pool = data.pool || {};
        const runner = data.runner || {};
        setText("countSource", pool.source || 0);
        setText("countSuccess", pool.success || 0);
        setText("countInflight", pool.inflight || 0);
        setText("countFailed", pool.failed || 0);
        updateHeroSmsBalance(data.heroSmsBalance);
        setText("runnerStatus", runner.status || "idle");
        if (data.configPath) setText("configPath", data.configPath);
        if (data.effectiveConfig && data.effectiveConfig.run) {
          const run = data.effectiveConfig.run;
          const mode = run.runUntilEmpty ? "持续运行到邮箱池为空" : "固定数量";
          setText("taskConfig", "模式 " + mode + " · total " + run.total + " · concurrency " + run.concurrency);
        }
      } catch (error) {
        if (state.authed) setText("taskMsg", error.message);
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
      state.logFlushTimer = window.setTimeout(flushLogs, 200);
    }

    function flushLogs() {
      state.logFlushTimer = 0;
      if (!state.pendingLogs.length) return;
      const logBox = $("logs");
      const wasNearBottom = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 48;
      state.logLines.push(...state.pendingLogs.splice(0));
      if (state.logLines.length > state.maxVisibleLogs) {
        state.logLines.splice(0, state.logLines.length - state.maxVisibleLogs);
      }
      logBox.textContent = state.logLines.join("\\n");
      if (wasNearBottom) {
        logBox.scrollTop = logBox.scrollHeight;
      }
    }

    function appendLog(item) {
      state.pendingLogs.push(formatLog(item));
      if (state.pendingLogs.length > state.maxVisibleLogs) {
        state.pendingLogs.splice(0, state.pendingLogs.length - state.maxVisibleLogs);
      }
      scheduleLogFlush();
    }

    function connectLogStream() {
      if (!state.authed || state.logSource) return;
      const source = new EventSource("/api/logs/stream");
      state.logSource = source;
      source.addEventListener("log", (event) => {
        try {
          appendLog(JSON.parse(event.data));
        } catch {}
      });
      source.addEventListener("ready", () => {
        appendLog({time: new Date().toISOString(), level: "info", message: "[admin] 实时日志已连接"});
      });
      source.onerror = () => {
        const now = Date.now();
        if (now - state.lastLogStreamErrorAt > 10000) {
          state.lastLogStreamErrorAt = now;
          appendLog({time: new Date().toISOString(), level: "warn", message: "[admin] 实时日志连接中断，浏览器会自动重连"});
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
        connectLogStream();
        await Promise.all([refreshStatus(), loadConfig()]);
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

    $("openImportModalBtn").onclick = openImportModal;
    $("closeImportModalBtn").onclick = closeImportModal;
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
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "free-register-success.zip";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setText("taskMsg", "成功邮箱已导出并清空");
        await refreshStatus();
      } catch (error) {
        setText("taskMsg", error.message);
      }
    };

    $("saveConfigBtn").onclick = async () => {
      try {
        await apiJson("/api/config", {method: "PUT", body: JSON.stringify({content: getConfigContent()})});
        setText("configMsg", "已保存");
        await refreshStatus();
      } catch (error) {
        setText("configMsg", error.message);
      }
    };

    $("reloadConfigBtn").onclick = async () => {
      try {
        await loadConfig();
        setText("configMsg", "已重新加载");
      } catch (error) {
        setText("configMsg", error.message);
      }
    };

    refreshStatus().then(() => {
      if (state.authed) {
        connectLogStream();
        Promise.all([loadConfig()]);
      }
    });
    setInterval(refreshStatus, 2500);
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

async function main(): Promise<void> {
    installConsoleCapture();
    const port = adminPort();
    if (adminPassword() === "changeme") {
        logger.warn("[admin] FREE_REGISTER_ADMIN_PASSWORD 未设置，当前使用默认密码 changeme");
    }
    const server = createServer((req, res) => {
        void handleRequest(req, res);
    });
    server.listen(port, "0.0.0.0", () => {
        logger.info(`[admin] listening on http://0.0.0.0:${port}`);
    });
}

main().catch((error) => {
    console.error(`[admin] failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    process.exitCode = 1;
});
