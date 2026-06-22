// @ts-nocheck
import {readFile, writeFile} from "node:fs/promises";
import {existsSync, readFileSync} from "node:fs";
import path from "node:path";
import {ImapFlow} from "imapflow";
import {findLatestVerificationMail} from "./verification-matcher.js";
import {appConfig} from "../config.js";
import type {EmailLease, EmailPool} from "../email-pool.js";
import {formatUtc8Timestamp} from "../utils.js";

const HOTMAIL_TOKEN_DIR = path.resolve(process.cwd(), "hotmail");

function projectRoot() {
    const cwd = process.cwd();
    if (path.basename(cwd) === "codex_register" && path.basename(path.dirname(cwd)) === "codexrigester") {
        return path.resolve(cwd, "..", "..");
    }
    return path.resolve(cwd, "..");
}

const PROJECT_ROOT = projectRoot();

/**
 * 解析 hotmail 卡密文件路径。
 * 优先级：
 *   1. HOTMAIL_TOKENS_FILE 环境变量（batch_runner 每 worker 独立隔离，绝不 fallback）
 *   2. 单跑场景：第一个存在且非空的候选文件
 *        a. codex_register/hotmail/tokens.txt
 *        b. 项目根 hotmail_inbox.txt（cwd 是 codex_register/，上一级即项目根）
 *   3. 都没有：返回默认 a 路径（仅用于报错信息）
 */
function resolveTokensFile() {
    if (process.env.HOTMAIL_TOKENS_FILE) {
        return path.resolve(process.env.HOTMAIL_TOKENS_FILE);
    }
    const candidates = [
        path.join(HOTMAIL_TOKEN_DIR, "tokens.txt"),
        path.resolve(PROJECT_ROOT, "pool_emails.txt"),
        path.resolve(PROJECT_ROOT, "hotmail_inbox.txt"),
        path.resolve(PROJECT_ROOT, "3p_free_account_hotmail.txt"),
    ];
    for (const file of candidates) {
        try {
            if (existsSync(file) && readFileSync(file, "utf8").trim()) {
                return file;
            }
        } catch {
            // 忽略读取异常，尝试下一个候选
        }
    }
    return candidates[0];
}

const HOTMAIL_TOKENS_FILE = resolveTokensFile();
const HOTMAIL_REST_BASE_URL = "https://outlook.office.com/api/v2.0";
const HOTMAIL_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const HOTMAIL_OAUTH_TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const HOTMAIL_DEFAULT_REDIRECT_URI = "http://localhost:8787/callback";
const HOTMAIL_DEFAULT_SCOPE = "openid profile User.Read Mail.ReadWrite Mail.Send Mail.Read";
const HOTMAIL_IMAP_HOST = "outlook.office365.com";
const HOTMAIL_IMAP_PORT = 993;
const HOTMAIL_POLL_ATTEMPTS = 24;
const HOTMAIL_POLL_INTERVAL_MS = 5000;
const HOTMAIL_IDLE_TIMEOUT_MS = 45_000;
const HOTMAIL_FAST_POLL_ATTEMPTS = 45;
const HOTMAIL_FAST_POLL_INTERVAL_MS = 3000;
const HOTMAIL_MESSAGE_FETCH_LIMIT = 10;
const HOTMAIL_FOLDER_IDS = ["inbox", "junkemail"];
const HOTMAIL_IMAP_FOLDERS = ["INBOX", "Junk"];
const aliasAccountMap = new Map();
let accountCache = null;

function toError(value) {
    return value instanceof Error ? value : new Error(String(value ?? "unknown error"));
}

export function protectImapClient(client, label = "imap") {
    let lastError = null;
    let closed = false;
    const waiters = new Set();

    client.on("error", (err) => {
        const error = toError(err);
        lastError = error;
        if (!closed) {
            console.warn(`Hotmail IMAP error (${label}): ${error.message}`);
        }
        for (const reject of Array.from(waiters)) {
            reject(error);
        }
        waiters.clear();
    });

    function makeErrorWaiter(signal) {
        let settled = false;
        let rejectOnce = null;
        let onAbort = null;
        let cleanup = () => {};

        const promise = new Promise((_, reject) => {
            rejectOnce = (error) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(error);
            };
            cleanup = () => {
                waiters.delete(rejectOnce);
                if (onAbort && signal?.removeEventListener) {
                    signal.removeEventListener("abort", onAbort);
                }
            };
            waiters.add(rejectOnce);

            if (signal) {
                onAbort = () => rejectOnce(new Error("aborted"));
                if (signal.aborted) {
                    onAbort();
                } else {
                    signal.addEventListener("abort", onAbort, {once: true});
                }
            }
        });

        return {promise, cleanup};
    }

    return {
        get lastError() {
            return lastError;
        },
        throwIfError() {
            if (lastError) throw lastError;
        },
        async race(operation, signal) {
            if (lastError) throw lastError;
            const waiter = makeErrorWaiter(signal);
            try {
                return await Promise.race([operation, waiter.promise]);
            } finally {
                waiter.cleanup();
            }
        },
        close() {
            closed = true;
            for (const reject of Array.from(waiters)) {
                reject(new Error("aborted"));
            }
            waiters.clear();
        },
    };
}

function createImapClient(account, label) {
    const client = new ImapFlow({
        host: HOTMAIL_IMAP_HOST,
        port: HOTMAIL_IMAP_PORT,
        secure: true,
        auth: {
            user: account.loginHint,
            accessToken: account.accessToken,
        },
        logger: false,
        emitLogs: false,
        proxy: account.proxyUrl ?? appConfig.defaultProxyUrl,
    });

    return {
        client,
        guard: protectImapClient(client, `${label}:${account.loginHint}`),
    };
}

async function* guardedAsyncIterator(guard, iterable, signal) {
    const iterator = iterable[Symbol.asyncIterator]();
    let completed = false;
    try {
        for (;;) {
            const item = await guard.race(iterator.next(), signal);
            if (item.done) {
                completed = true;
                return;
            }
            yield item.value;
        }
    } finally {
        if (!completed && typeof iterator.return === "function") {
            try { await iterator.return(); } catch (_) { /* ignore */ }
        }
    }
}

function normalizeEmail(value) {
    return String(value ?? "").trim().toLowerCase();
}

function resolveApiMode(account) {
    const scope = String(account?.scope ?? "").toLowerCase();
    return scope.includes("outlook.office.com") ? "rest" : "graph";
}

function decodeJwtPayload(token) {
    const parts = String(token ?? "").split(".");
    if (parts.length < 2) {
        return {};
    }
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    try {
        return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    } catch {
        return {};
    }
}

function getTokenExpireAtMs(account) {
    const payload = decodeJwtPayload(account.accessToken);
    const exp = Number(payload.exp ?? 0);
    if (exp > 0) {
        return exp * 1000;
    }

    const obtainedAt = Date.parse(String(account.obtainedAt ?? ""));
    const expiresIn = Number(account.expiresIn ?? 0);
    if (Number.isFinite(obtainedAt) && expiresIn > 0) {
        return obtainedAt + expiresIn * 1000;
    }

    return 0;
}

function isAccessTokenExpired(account) {
    const expireAtMs = getTokenExpireAtMs(account);
    if (!expireAtMs) {
        return false;
    }
    return Date.now() >= expireAtMs - 60 * 1000;
}

async function loadTextAccounts() {
    const tokensFile = process.env.HOTMAIL_TOKENS_FILE
        ? path.resolve(process.env.HOTMAIL_TOKENS_FILE)
        : HOTMAIL_TOKENS_FILE;
    try {
        const raw = await readFile(tokensFile, "utf8");
        return raw
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line, index) => {
                const [email, password, clientId, refreshToken] = line.split("----");
                const loginHint = normalizeEmail(email);
                const account = {
                    sourceType: "txt",
                    fileName: path.basename(tokensFile),
                    filePath: tokensFile,
                    lineIndex: index,
                    lineRaw: line,
                    loginHint,
                    password: String(password ?? "").trim(),
                    sourceAccount: loginHint,
                    tenant: "consumers",
                    clientId: String(clientId ?? "").trim(),
                    redirectUri: "",
                    scope: "",
                    tokenType: "Bearer",
                    accessToken: "",
                    refreshToken: String(refreshToken ?? "").trim(),
                    idToken: "",
                    obtainedAt: "",
                    expiresIn: 0,
                    extExpiresIn: 0,
                    raw: {},
                };
                return loginHint && account.clientId && account.refreshToken ? account : null;
            })
            .filter(Boolean);
    } catch (error) {
        if (error?.code === "ENOENT") {
            return [];
        }
        throw error;
    }
}

async function loadAccounts() {
    if (accountCache) {
        return accountCache;
    }

    const textAccounts = await loadTextAccounts();
    const accounts = textAccounts;
    if (!accounts.length) {
        throw new Error(`未在文件找到 Hotmail token: ${HOTMAIL_TOKENS_FILE}`);
    }

    accountCache = accounts;
    return accounts;
}

async function persistTextAccount(account) {
    const nextLine = [
        account.loginHint,
        account.password ?? "",
        account.clientId ?? "",
        account.refreshToken ?? "",
    ].join("----");

    if (account.pool) {
        await account.pool.updateLeaseLine(account.loginHint, nextLine);
        account.lineRaw = nextLine;
        return;
    }

    const tokensFile = account.filePath || HOTMAIL_TOKENS_FILE;
    const raw = await readFile(tokensFile, "utf8");
    const lines = raw.split(/\r?\n/);
    const index = Number(account.lineIndex ?? -1);

    if (index >= 0 && index < lines.length) {
        lines[index] = nextLine;
    } else {
        lines.push(nextLine);
        account.lineIndex = lines.length - 1;
    }

    await writeFile(tokensFile, `${lines.filter((line) => line != null).join("\n").replace(/\n+$/g, "")}\n`, "utf8");
    account.lineRaw = nextLine;
}

async function persistAccount(account) {
    await persistTextAccount(account);
}

function buildRefreshVariants(account) {
    const redirectUri = String(account.redirectUri ?? "").trim();
    const scope = String(account.scope ?? "").trim();
    const variants = [
        {redirectUri, scope},
        {redirectUri: "", scope: ""},
        {redirectUri: HOTMAIL_DEFAULT_REDIRECT_URI, scope: ""},
        {redirectUri, scope: HOTMAIL_DEFAULT_SCOPE},
    ];
    const seen = new Set();

    return variants.filter((item) => {
        const key = `${item.redirectUri}|||${item.scope}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

async function refreshAccessToken(account) {
    if (!account.clientId || !account.refreshToken) {
        throw new Error(`Hotmail token 缺少刷新所需字段: ${account.fileName}`);
    }

    let lastError = "";
    for (const variant of buildRefreshVariants(account)) {
        const body = new URLSearchParams({
            client_id: account.clientId,
            grant_type: "refresh_token",
            refresh_token: account.refreshToken,
        });

        if (variant.redirectUri) {
            body.set("redirect_uri", variant.redirectUri);
        }
        if (variant.scope) {
            body.set("scope", variant.scope);
        }

        // 网络层重试：login.microsoftonline.com 偶发 TLS / ECONNRESET
        let response = null;
        let networkErr = null;
        for (let attempt = 1; attempt <= 4; attempt += 1) {
            try {
                response = await fetch(HOTMAIL_OAUTH_TOKEN_URL, {
                    method: "POST",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    body: body.toString(),
                });
                networkErr = null;
                break;
            } catch (err) {
                networkErr = err;
                const wait = 1000 * attempt;
                console.warn(`hotmailTokenRefreshNetErr: attempt=${attempt}/4 ${(err as Error).message}, ${wait}ms 后重试`);
                await new Promise((r) => setTimeout(r, wait));
            }
        }
        if (!response) {
            lastError = `network: ${(networkErr as Error)?.message ?? "unknown"}`;
            continue;
        }

        const rawBody = await response.text();
        if (!response.ok) {
            lastError = `redirect=${variant.redirectUri || "(empty)"} scope=${variant.scope || "(empty)"} status=${response.status} body=${rawBody}`;
            continue;
        }

        const payload = JSON.parse(rawBody);
        account.accessToken = String(payload?.access_token ?? "").trim();
        account.refreshToken = String(payload?.refresh_token ?? account.refreshToken).trim();
        account.idToken = String(payload?.id_token ?? account.idToken ?? "").trim();
        account.tokenType = String(payload?.token_type ?? account.tokenType ?? "Bearer").trim();
        account.scope = String(payload?.scope ?? variant.scope ?? account.scope).trim();
        account.redirectUri = variant.redirectUri || account.redirectUri || HOTMAIL_DEFAULT_REDIRECT_URI;
        account.expiresIn = Number(payload?.expires_in ?? account.expiresIn ?? 0);
        account.extExpiresIn = Number(payload?.ext_expires_in ?? account.extExpiresIn ?? 0);
        account.obtainedAt = new Date().toISOString();
        account.apiMode = resolveApiMode(account);

        await persistAccount(account);
        console.log(`hotmailTokenRefreshed: ${account.loginHint} mode=${account.apiMode} scope=${account.scope}`);
        return account;
    }

    throw new Error(`Hotmail 刷新 token 失败: ${lastError}`);
}

async function ensureFreshAccount(account) {
    if (!account.accessToken || isAccessTokenExpired(account)) {
        await refreshAccessToken(account);
    }
    return account;
}

function buildAuthHeaders(account) {
    return {
        Accept: "application/json",
        Authorization: `Bearer ${account.accessToken}`,
    };
}

async function restRequest(account, url) {
    await ensureFreshAccount(account);

    let response: Response | null = null;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            response = await fetch(url, {
                method: "GET",
                headers: buildAuthHeaders(account),
            });
            lastErr = null;
            break;
        } catch (err) {
            lastErr = err;
            await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
    }
    if (!response) {
        throw new Error(`Hotmail REST 网络错误: ${(lastErr as Error)?.message ?? "unknown"}`);
    }

    if (response.status === 401) {
        await refreshAccessToken(account);
        response = await fetch(url, {
            method: "GET",
            headers: buildAuthHeaders(account),
        });
    }

    if (!response.ok) {
        throw new Error(`Hotmail REST 请求失败: ${response.status} body=${await response.text()}`);
    }

    return response.json();
}

async function graphRequest(account, url) {
    await ensureFreshAccount(account);

    let response: Response | null = null;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            response = await fetch(url, {
                method: "GET",
                headers: buildAuthHeaders(account),
            });
            lastErr = null;
            break;
        } catch (err) {
            lastErr = err;
            await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
    }
    if (!response) {
        throw new Error(`Hotmail Graph 网络错误: ${(lastErr as Error)?.message ?? "unknown"}`);
    }

    if (response.status === 401) {
        await refreshAccessToken(account);
        response = await fetch(url, {
            method: "GET",
            headers: buildAuthHeaders(account),
        });
    }

    if (!response.ok) {
        throw new Error(`Hotmail Graph 请求失败: ${response.status} body=${await response.text()}`);
    }

    return response.json();
}

function chooseRandomAccount(accounts) {
    return accounts[Math.floor(Math.random() * accounts.length)];
}

function buildAliasAddress(account) {
    const mailbox = normalizeEmail(account.loginHint);
    const [localPart, domain] = mailbox.split("@");
    if (!localPart || !domain) {
        throw new Error(`Hotmail 邮箱格式不正确: ${account.loginHint}`);
    }
    // 不使用 + 别名，直接用原邮箱注册
    return `${localPart}@${domain}`;
}

function normalizeRecipientList(recipients) {
    if (!Array.isArray(recipients)) {
        return [];
    }
    return recipients
        .map((item) => normalizeEmail(item?.EmailAddress?.Address ?? item?.emailAddress?.address ?? item?.address ?? ""))
        .filter(Boolean);
}

function normalizeMessage(message, folderId) {
    const bodyContent = String(message?.Body?.Content ?? message?.body?.content ?? "");
    return {
        id: String(message?.Id ?? message?.id ?? ""),
        folderId,
        subject: String(message?.Subject ?? message?.subject ?? ""),
        bodyContent,
        bodyPreview: String(message?.BodyPreview ?? message?.bodyPreview ?? ""),
        from: normalizeEmail(message?.From?.EmailAddress?.Address ?? message?.from?.emailAddress?.address ?? ""),
        toRecipients: normalizeRecipientList(message?.ToRecipients ?? message?.toRecipients),
        receivedDateTime: String(message?.ReceivedDateTime ?? message?.receivedDateTime ?? ""),
        receivedAtMs: Date.parse(String(message?.ReceivedDateTime ?? message?.receivedDateTime ?? "")) || 0,
        raw: message,
    };
}

async function listFolderMessages(account, folderId, options = {}) {
    // 先刷新 token，确保 scope 已就绪
    await ensureFreshAccount(account);
    const apiMode = account.apiMode ?? resolveApiMode(account);

    // IMAP 模式（卡密 scope 是 IMAP/POP/SMTP，REST/Graph 都不可用）
    // 优先尝试 IMAP，失败再 fallback 到 REST/Graph
    if (apiMode === "rest") {
        try {
            return await listFolderMessagesViaImap(account, folderId, options);
        } catch (err) {
            console.warn(`Hotmail IMAP 读邮件失败，fallback REST: ${err?.message ?? err}`);
        }
    }

    const isRest = apiMode === "rest";
    const url = new URL(
        isRest
            ? `${HOTMAIL_REST_BASE_URL}/me/mailfolders/${encodeURIComponent(folderId)}/messages`
            : `${HOTMAIL_GRAPH_BASE_URL}/me/mailFolders/${encodeURIComponent(folderId)}/messages`,
    );
    url.searchParams.set("$top", String(HOTMAIL_MESSAGE_FETCH_LIMIT));
    url.searchParams.set("$orderby", isRest ? "ReceivedDateTime desc" : "receivedDateTime desc");
    if (!isRest) {
        url.searchParams.set("$select", "id,subject,bodyPreview,body,from,toRecipients,receivedDateTime");
    }

    const payload = isRest
        ? await restRequest(account, url)
        : await graphRequest(account, url);
    return Array.isArray(payload?.value)
        ? payload.value.map((item) => normalizeMessage(item, folderId))
        : [];
}

function mapFolderIdToImap(folderId) {
    const v = String(folderId ?? "").toLowerCase();
    if (v === "inbox") return "INBOX";
    if (v === "junkemail" || v === "junk") return "Junk";
    return folderId;
}

async function listFolderMessagesViaImap(account, folderId, options = {}) {
    const mailbox = mapFolderIdToImap(folderId);
    const {client, guard} = createImapClient(account, `list:${folderId}`);

    const messages = [];
    try {
        await guard.race(client.connect());
        // 尝试解析实际的 mailbox 名（Outlook 上 Junk 真实路径可能是 "Junk Email"）
        let resolvedMailbox = mailbox;
        try {
            const list = await guard.race(client.list());
            const norm = (s) => String(s ?? "").toLowerCase();
            const match = list.find((b) => {
                const p = norm(b.path);
                if (mailbox.toUpperCase() === "INBOX") return p === "inbox";
                return p === "junk" || p === "junk email" || (b.specialUse && norm(b.specialUse) === "\\junk");
            });
            if (match?.path) resolvedMailbox = match.path;
        } catch (_) { /* ignore */ }

        const lock = await guard.race(client.getMailboxLock(resolvedMailbox));
        try {
            const status = client.mailbox;
            const total = Number(status?.exists ?? 0);
            if (options.logSummary) {
                console.log(`hotmailImapMailbox: account=${account.loginHint} folder=${folderId} resolved=${resolvedMailbox} total=${total}`);
            }
            if (!total) {
                return [];
            }
            const seqStart = Math.max(1, total - HOTMAIL_MESSAGE_FETCH_LIMIT + 1);
            const fetchStream = client.fetch(`${seqStart}:${total}`, {
                envelope: true,
                bodyStructure: false,
                source: true,
            }, {uid: false});
            for await (const msg of guardedAsyncIterator(guard, fetchStream)) {
                const env = msg.envelope ?? {};
                const fromAddr = (env.from?.[0]?.address ?? "").toLowerCase();
                const toAddrs = Array.isArray(env.to)
                    ? env.to.map((t) => (t?.address ?? "").toLowerCase()).filter(Boolean)
                    : [];
                const receivedDate = env.date instanceof Date
                    ? env.date.toISOString()
                    : (env.date ? new Date(env.date).toISOString() : "");
                let bodyPreview = "";
                // 用 fetch 时带 source:true 直接拿到原始 RFC822
                try {
                    if (msg.source) {
                        const raw = Buffer.isBuffer(msg.source)
                            ? msg.source.toString("utf8")
                            : String(msg.source);
                        const idx = raw.indexOf("\r\n\r\n");
                        bodyPreview = (idx >= 0 ? raw.slice(idx + 4) : raw).slice(0, 16000);
                    }
                } catch (_) {
                    // ignore
                }
                messages.push({
                    id: String(msg.uid ?? msg.seq ?? ""),
                    folderId,
                    subject: String(env.subject ?? ""),
                    bodyContent: bodyPreview,
                    bodyPreview,
                    from: fromAddr,
                    toRecipients: toAddrs,
                    receivedDateTime: receivedDate,
                    receivedAtMs: receivedDate ? Date.parse(receivedDate) : 0,
                    raw: env,
                });
            }
        } finally {
            lock.release();
        }
    } finally {
        try { await client.logout(); } catch (_) { /* ignore */ }
        guard.close();
    }

    messages.sort((a, b) => b.receivedAtMs - a.receivedAtMs);
    return messages;
}

async function getLatestVerificationMessage(targetEmail, account, minTimestampMs = 0, options = {}) {
    const messages = [];

    for (const folderId of HOTMAIL_FOLDER_IDS) {
        const folderMessages = await listFolderMessages(account, folderId, options);
        messages.push(...folderMessages);
    }

    messages.sort((a, b) => b.receivedAtMs - a.receivedAtMs);

    // 时间戳过滤：只接受指定时间之后到的邮件（避免读到老的 OTP）
    const filtered = minTimestampMs > 0
        ? messages.filter((m) => (m.receivedAtMs ?? 0) >= minTimestampMs - 60_000) // 给 60s 时钟偏移
        : messages;

    // Debug：打印最近 5 封邮件的 subject + from + recipient
    const debugLines = filtered.slice(0, 5).map((m) =>
        `  [${m.folderId}] from=${m.from} to=${(m.toRecipients ?? []).join(',')} subject=${(m.subject ?? '').slice(0, 80)} bodyLen=${(m.bodyPreview ?? '').length} time=${formatUtc8Timestamp(m.receivedAtMs ?? 0)}`
    );
    if (options.logDetails && debugLines.length) {
        console.log(`hotmailMessagesDebug: targetEmail=${targetEmail} (after=${minTimestampMs ? formatUtc8Timestamp(minTimestampMs) : 'any'})\n${debugLines.join("\n")}`);
    }
    if (options.logDetails && filtered[0]?.bodyPreview) {
        console.log(`hotmailFirstBodyPreview: ${filtered[0].bodyPreview.slice(0, 300).replace(/\s+/g, " ")}`);
    }

    const matched = findLatestVerificationMail(
        filtered.map((message) => ({
            ...message,
            recipient: message.toRecipients,
            content: message.bodyContent,
            timestamp: message.receivedAtMs,
            extraTexts: [message.bodyPreview],
        })),
        {
            targetEmail,
            candidateMatcher: (mail) =>
                /(OpenAI|ChatGPT)/i.test(
                    `${mail.subject ?? ""}\n${mail.bodyPreview ?? ""}\n${mail.from ?? ""}`,
                ),
        },
    );
    if (options.logSummary || matched?.verificationCode) {
        console.log(`hotmailMessagesFetched: targetEmail=${targetEmail} mailbox=${account.loginHint} total=${messages.length} kept=${filtered.length} matched=${Boolean(matched?.verificationCode)}`);
    }
    return matched;
}

function delay(ms, signal) {
    if (signal?.aborted) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
        }, {once: true});
    });
}

function shouldLogPollProgress(attempt, total, every = 10) {
    return attempt === 1 || attempt === total || attempt % every === 0;
}

async function pollHotmailVerificationCode(targetEmail, account, minTimestampMs = 0, options = {}) {
    const attempts = options.attempts ?? HOTMAIL_FAST_POLL_ATTEMPTS;
    const intervalMs = options.intervalMs ?? HOTMAIL_FAST_POLL_INTERVAL_MS;
    const signal = options.signal;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (signal?.aborted) return null;
        const logProgress = shouldLogPollProgress(attempt, attempts);
        if (logProgress) {
            console.log(`pollHotmailOtp: attempt=${attempt}/${attempts} targetEmail=${targetEmail}`);
        }
        try {
            const message = await getLatestVerificationMessage(targetEmail, account, minTimestampMs, {
                logSummary: logProgress,
                logDetails: attempt === attempts,
            });
            if (message?.verificationCode) {
                console.log(`hotmailOtpCode: ${message.verificationCode} (via poll)`);
                console.log(`hotmailOtpFolder: ${message.folderId}`);
                return message.verificationCode;
            }
        } catch (err) {
            if (logProgress) {
                console.warn(`pollHotmailOtp: attempt=${attempt} 读邮件失败: ${(err as Error).message}`);
            }
        }
        if (attempt < attempts) {
            await delay(intervalMs, signal);
        }
    }

    return null;
}

async function firstResolvedCode(promises, controller) {
    const pending = new Set(promises);
    while (pending.size) {
        const wrapped = [...pending].map((promise) =>
            promise.then(
                (code) => ({promise, code}),
                () => ({promise, code: null}),
            )
        );
        const {promise, code} = await Promise.race(wrapped);
        pending.delete(promise);
        if (code) {
            controller.abort();
            return code;
        }
    }
    return null;
}

async function resolveAccountForEmail(email) {
    const normalizedEmail = normalizeEmail(email);
    const mapped = aliasAccountMap.get(normalizedEmail);
    if (mapped) {
        return mapped;
    }

    const accounts = await loadAccounts();
    const [localPart, domain] = normalizedEmail.split("@");
    const baseLocalPart = String(localPart ?? "").split("+")[0];

    const matched = accounts.find((account) => {
        const [accountLocalPart, accountDomain] = normalizeEmail(account.loginHint).split("@");
        return accountLocalPart === baseLocalPart && accountDomain === domain;
    });

    if (matched) {
        aliasAccountMap.set(normalizeEmail(email), matched);
        return matched;
    }

    throw new Error(`Hotmail 未找到与邮箱匹配的 token: ${email}`);
}

/**
 * IMAP IDLE 实时等待新邮件。连上后保持连接，收到 EXISTS 通知立即 fetch 新邮件。
 * 相比轮训：无 sleep 间隔，邮件一到立即拿到，平均快 30-60 秒。
 *
 * 流程：
 *   1. 连接 IMAP，先扫一次已有邮件（快速命中旧邮件场景）
 *   2. 没找到 → 进入 IDLE，等 server 推送 EXISTS
 *   3. 收到新邮件通知 → 立即 fetch → 匹配验证码
 *   4. 超时 HOTMAIL_IDLE_TIMEOUT_MS 后放弃
 *
 * 同时监控 INBOX 和 Junk（Outlook 可能把 OpenAI 邮件投入垃圾箱）。
 */
async function waitForVerificationViaIdle(targetEmail, account, minTimestampMs = 0, options = {}) {
    await ensureFreshAccount(account);
    const timeoutMs = options.timeoutMs ?? HOTMAIL_IDLE_TIMEOUT_MS;
    const externalSignal = options.signal;

    // 解析真实 mailbox 路径
    async function resolveMailboxPaths(client, guard) {
        const paths = {inbox: "INBOX", junk: "Junk"};
        try {
            const list = guard ? await guard.race(client.list()) : await client.list();
            const norm = (s) => String(s ?? "").toLowerCase();
            for (const box of list) {
                const p = norm(box.path);
                if (p === "inbox") paths.inbox = box.path;
                if (p === "junk" || p === "junk email" || (box.specialUse && norm(box.specialUse) === "\\junk")) {
                    paths.junk = box.path;
                }
            }
        } catch (_) { /* ignore */ }
        return paths;
    }

    // 从当前 mailbox 拉最近邮件并匹配
    async function fetchAndMatch(client, guard, signal) {
        const status = client.mailbox;
        const total = Number(status?.exists ?? 0);
        if (!total) return null;

        const seqStart = Math.max(1, total - HOTMAIL_MESSAGE_FETCH_LIMIT + 1);
        const messages = [];
        const fetchStream = client.fetch(`${seqStart}:${total}`, {
            envelope: true,
            bodyStructure: false,
            source: true,
        }, {uid: false});
        for await (const msg of guardedAsyncIterator(guard, fetchStream, signal)) {
            const env = msg.envelope ?? {};
            const fromAddr = (env.from?.[0]?.address ?? "").toLowerCase();
            const toAddrs = Array.isArray(env.to)
                ? env.to.map((t) => (t?.address ?? "").toLowerCase()).filter(Boolean)
                : [];
            const receivedDate = env.date instanceof Date
                ? env.date.toISOString()
                : (env.date ? new Date(env.date).toISOString() : "");
            let bodyPreview = "";
            try {
                if (msg.source) {
                    const raw = Buffer.isBuffer(msg.source)
                        ? msg.source.toString("utf8")
                        : String(msg.source);
                    const idx = raw.indexOf("\r\n\r\n");
                    bodyPreview = (idx >= 0 ? raw.slice(idx + 4) : raw).slice(0, 16000);
                }
            } catch (_) { /* ignore */ }

            messages.push({
                id: String(msg.uid ?? msg.seq ?? ""),
                folderId: "imap",
                subject: String(env.subject ?? ""),
                bodyContent: bodyPreview,
                bodyPreview,
                from: fromAddr,
                toRecipients: toAddrs,
                receivedDateTime: receivedDate,
                receivedAtMs: receivedDate ? Date.parse(receivedDate) : 0,
                raw: env,
            });
        }

        // 时间过滤
        const filtered = minTimestampMs > 0
            ? messages.filter((m) => (m.receivedAtMs ?? 0) >= minTimestampMs - 60_000)
            : messages;

        return findLatestVerificationMail(
            filtered.map((message) => ({
                ...message,
                recipient: message.toRecipients,
                content: message.bodyContent,
                timestamp: message.receivedAtMs,
                extraTexts: [message.bodyPreview],
            })),
            {
                targetEmail,
                candidateMatcher: (mail) =>
                    /(OpenAI|ChatGPT)/i.test(
                        `${mail.subject ?? ""}\n${mail.bodyPreview ?? ""}\n${mail.from ?? ""}`,
                    ),
            },
        );
    }

    // 在单个文件夹上做 IDLE 等待
    async function idleOnFolder(mailboxPath: string, signal: AbortSignal): Promise<string | null> {
        const {client, guard} = createImapClient(account, `idle:${mailboxPath}`);

        try {
            await guard.race(client.connect(), signal);
            const lock = await guard.race(client.getMailboxLock(mailboxPath), signal);
            try {
                // 先扫一次已有邮件
                const existing = await fetchAndMatch(client, guard, signal);
                if (existing?.verificationCode) {
                    return existing.verificationCode;
                }

                // 进入 IDLE 循环：等待新邮件到达
                console.log(`hotmailIdle: waiting on ${mailboxPath} for ${targetEmail}...`);
                while (!signal.aborted) {
                    // idle() 会阻塞直到有新事件或超时
                    // imapflow 的 idle() 在收到 EXISTS 等通知后自动 resolve
                    await guard.race(client.idle(), signal);

                    if (signal.aborted) break;

                    // 收到通知，立即 fetch
                    console.log(`hotmailIdle: new mail event on ${mailboxPath}, fetching...`);
                    const result = await fetchAndMatch(client, guard, signal);
                    if (result?.verificationCode) {
                        return result.verificationCode;
                    }
                }
            } finally {
                lock.release();
            }
        } catch (err) {
            if ((err as Error).message === "aborted") return null;
            throw err;
        } finally {
            try { await client.logout(); } catch (_) { /* ignore */ }
            guard.close();
        }
        return null;
    }

    // 并行在 INBOX + Junk 上 IDLE，任一找到验证码立即返回
    const {client: client0, guard: client0Guard} = createImapClient(account, "resolve-mailboxes");
    let paths = {inbox: "INBOX", junk: "Junk"};
    try {
        await client0Guard.race(client0.connect());
        paths = await resolveMailboxPaths(client0, client0Guard);
    } finally {
        try { await client0.logout(); } catch (_) { /* ignore */ }
        client0Guard.close();
    }

    const folders = [paths.inbox, paths.junk];
    const controller = new AbortController();
    const {signal} = controller;
    const abortFromExternal = () => controller.abort();
    externalSignal?.addEventListener("abort", abortFromExternal, {once: true});

    // 超时保底
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        if (externalSignal?.aborted) return null;
        const result = await firstResolvedCode(
            folders.map((folder) =>
                idleOnFolder(folder, signal).catch((err) => {
                    console.warn(`hotmailIdle: ${folder} error: ${(err as Error).message}`);
                    return null;
                })
            ),
            controller,
        );

        if (result) return result;
    } finally {
        clearTimeout(timeout);
        controller.abort();
        externalSignal?.removeEventListener("abort", abortFromExternal);
    }

    return null;
}

function accountFromLease(lease: EmailLease, pool: EmailPool, proxyUrl = "") {
    const [email, password, clientId, refreshToken] = lease.line.split("----");
    const loginHint = normalizeEmail(email);
    if (!loginHint || !String(clientId ?? "").trim() || !String(refreshToken ?? "").trim()) {
        throw new Error(`Hotmail 租约行格式错误: ${lease.line.slice(0, 80)}`);
    }
    return {
        sourceType: "lease",
        fileName: "email.inflight.txt",
        filePath: "",
        lineIndex: 0,
        lineRaw: lease.line,
        loginHint,
        password: String(password ?? "").trim(),
        sourceAccount: loginHint,
        tenant: "consumers",
        clientId: String(clientId ?? "").trim(),
        redirectUri: "",
        scope: "",
        tokenType: "Bearer",
        accessToken: "",
        refreshToken: String(refreshToken ?? "").trim(),
        idToken: "",
        obtainedAt: "",
        expiresIn: 0,
        extExpiresIn: 0,
        raw: {},
        pool,
        proxyUrl,
    };
}

export function createHotmailProvider(options?: {lease?: EmailLease; pool?: EmailPool; proxyUrl?: string}) {
    const leasedAccount = options?.lease && options.pool
        ? accountFromLease(options.lease, options.pool, options.proxyUrl ?? "")
        : null;
    const providerAliasMap = new Map();

    async function providerAccounts() {
        if (leasedAccount) {
            return [leasedAccount];
        }
        return loadAccounts();
    }

    async function providerResolveAccount(email) {
        const normalizedEmail = normalizeEmail(email);
        const mapped = providerAliasMap.get(normalizedEmail) || aliasAccountMap.get(normalizedEmail);
        if (mapped) {
            return mapped;
        }

        const accounts = await providerAccounts();
        const [localPart, domain] = normalizedEmail.split("@");
        const baseLocalPart = String(localPart ?? "").split("+")[0];
        const matched = accounts.find((account) => {
            const [accountLocalPart, accountDomain] = normalizeEmail(account.loginHint).split("@");
            return accountLocalPart === baseLocalPart && accountDomain === domain;
        });
        if (matched) {
            providerAliasMap.set(normalizedEmail, matched);
            return matched;
        }
        throw new Error(`Hotmail 未找到与邮箱匹配的 token: ${email}`);
    }

    return {
        async getEmailAddress() {
            const accounts = await providerAccounts();
            const account = chooseRandomAccount(accounts);
            const aliasEmail = buildAliasAddress(account);
            providerAliasMap.set(normalizeEmail(aliasEmail), account);
            aliasAccountMap.set(normalizeEmail(aliasEmail), account);
            return aliasEmail;
        },
        async getEmailVerificationCode(email, options) {
            const account = await providerResolveAccount(email);
            const minTimestampMs = options?.minTimestampMs || 0;
            const externalSignal = options?.signal;
            if (externalSignal?.aborted) {
                throw new Error("aborted");
            }
            await ensureFreshAccount(account);

            console.log(`hotmailOtp: 使用 IMAP IDLE + 快速轮询并行等待 targetEmail=${email} mailbox=${account.loginHint}`);
            const controller = new AbortController();

            try {
                const code = await firstResolvedCode([
                    waitForVerificationViaIdle(email, account, minTimestampMs, {
                        signal: controller.signal,
                        timeoutMs: HOTMAIL_IDLE_TIMEOUT_MS,
                    }).then((code) => {
                        if (code) console.log(`hotmailOtpCode: ${code} (via IDLE)`);
                        return code;
                    }),
                    pollHotmailVerificationCode(email, account, minTimestampMs, {
                        signal: controller.signal,
                        attempts: HOTMAIL_FAST_POLL_ATTEMPTS,
                        intervalMs: HOTMAIL_FAST_POLL_INTERVAL_MS,
                    }),
                ], controller);
                if (code) {
                    return code;
                }
            } catch (err) {
                console.warn(`hotmailOtp: 并行等待失败，fallback 最后一轮轮询: ${(err as Error).message}`);
            } finally {
                controller.abort();
            }

            console.log(`hotmailOtp: 并行等待未命中，fallback 最后一轮轮询...`);
            const fallbackCode = await pollHotmailVerificationCode(email, account, minTimestampMs, {
                attempts: 10,
                intervalMs: 2000,
                signal: externalSignal,
            });
            if (fallbackCode) {
                return fallbackCode;
            }

            throw new Error(`Hotmail 中未找到验证码: targetEmail=${email}`);
        },
    };
}
