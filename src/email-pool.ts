import {mkdir, open, readFile, rename, unlink, writeFile} from "node:fs/promises";
import path from "node:path";
import type {EmailPoolConfig} from "./config.js";
import {formatUtc8Timestamp} from "./utils.js";

const LOCK_RETRY_MS = 40;
const LOCK_STALE_MS = 5 * 60 * 1000;

export interface EmailLease {
    email: string;
    line: string;
}

export interface EmailPoolPaths {
    source: string;
    success: string;
    inflight: string;
    failed: string;
    lock: string;
}

export interface EmailPoolStats {
    source: number;
    success: number;
    inflight: number;
    failed: number;
}

export interface ImportEmailsResult {
    imported: number;
    duplicate: number;
    invalid: number;
    total: number;
}

export interface InflightReturnResult {
    returned: number;
}

export interface InflightFailResult {
    failed: number;
    cleared: number;
}

export class EmailPool {
    readonly paths: EmailPoolPaths;

    constructor(config: EmailPoolConfig, private readonly baseDir = process.cwd()) {
        this.paths = {
            source: this.resolve(config.source),
            success: this.resolve(config.success),
            inflight: this.resolve(config.inflight),
            failed: this.resolve(config.failed),
            lock: this.resolve(config.lock),
        };
    }

    async leaseEmail(): Promise<EmailLease | null> {
        return this.withLock(async () => {
            const sourceLines = await readPoolLines(this.paths.source);
            const [line, ...remaining] = sourceLines;
            if (!line) {
                return null;
            }
            const email = emailFromLine(line);
            if (!email) {
                throw new Error(`邮箱池行格式错误: ${line.slice(0, 80)}`);
            }
            await writePoolLinesAtomic(this.paths.source, remaining);
            const inflightLines = await readPoolLines(this.paths.inflight);
            await writePoolLinesAtomic(this.paths.inflight, appendUniqueByEmail(inflightLines, line));
            return {email, line};
        });
    }

    async returnToSource(lease: EmailLease): Promise<void> {
        await this.withLock(async () => {
            const currentLine = await this.currentLineForEmail(lease.email, lease.line);
            const sourceLines = await readPoolLines(this.paths.source);
            const inflightLines = await readPoolLines(this.paths.inflight);
            await writePoolLinesAtomic(this.paths.inflight, removeByEmail(inflightLines, lease.email));
            await writePoolLinesAtomic(this.paths.source, prependUniqueByEmail(sourceLines, currentLine));
        });
    }

    async markSuccess(lease: EmailLease): Promise<void> {
        await this.withLock(async () => {
            const currentLine = await this.currentLineForEmail(lease.email, lease.line);
            await this.removeFromActivePools(lease.email);
            const successLines = await readPoolLines(this.paths.success);
            await writePoolLinesAtomic(this.paths.success, appendUniqueByEmail(successLines, currentLine));
        });
    }

    async markFailed(lease: EmailLease, reason: string): Promise<void> {
        await this.withLock(async () => {
            const currentLine = await this.currentLineForEmail(lease.email, lease.line);
            await this.removeFromActivePools(lease.email);
            const failedRaw = await readRawFile(this.paths.failed);
            const failedLines = splitLines(failedRaw);
            if (hasEmail(failedLines, lease.email)) {
                return;
            }
            const comment = `# failed at ${formatUtc8Timestamp()} reason=${reason.replace(/\s+/g, " ").slice(0, 240)}`;
            await writeRawFileAtomic(this.paths.failed, ensureTrailingNewline([...failedLines, comment, currentLine].join("\n")));
        });
    }

    async updateLeaseLine(email: string, nextLine: string): Promise<void> {
        const target = normalizeEmail(email);
        if (!target) {
            throw new Error("updateLeaseLine email 为空");
        }
        await this.withLock(async () => {
            let updated = false;
            for (const file of [this.paths.inflight, this.paths.source, this.paths.success, this.paths.failed]) {
                const raw = await readRawFile(file);
                const lines = splitLines(raw);
                const nextLines = lines.map((line) => {
                    if (emailFromLine(line) === target) {
                        updated = true;
                        return nextLine;
                    }
                    return line;
                });
                if (updated) {
                    await writeRawFileAtomic(file, ensureTrailingNewline(nextLines.join("\n")));
                    return;
                }
            }
            throw new Error(`未找到可更新的邮箱行: ${email}`);
        });
    }

    async stats(): Promise<EmailPoolStats> {
        return this.withLock(async () => ({
            source: (await readPoolLines(this.paths.source)).length,
            success: (await readPoolLines(this.paths.success)).length,
            inflight: (await readPoolLines(this.paths.inflight)).length,
            failed: (await readPoolLines(this.paths.failed)).length,
        }));
    }

    async importToSource(rawInput: string): Promise<ImportEmailsResult> {
        const incoming = rawInput
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith("#"));

        return this.withLock(async () => {
            const sourceLines = await readPoolLines(this.paths.source);
            const inflightLines = await readPoolLines(this.paths.inflight);
            const successLines = await readPoolLines(this.paths.success);
            const failedLines = await readPoolLines(this.paths.failed);
            const knownEmails = new Set(
                [...sourceLines, ...inflightLines, ...successLines, ...failedLines]
                    .map(emailFromLine)
                    .filter(Boolean),
            );

            let imported = 0;
            let duplicate = 0;
            let invalid = 0;
            const nextSourceLines = [...sourceLines];

            for (const line of incoming) {
                const email = emailFromLine(line);
                if (!email || line.split("----").length < 4) {
                    invalid += 1;
                    continue;
                }
                if (knownEmails.has(email)) {
                    duplicate += 1;
                    continue;
                }
                knownEmails.add(email);
                nextSourceLines.push(line);
                imported += 1;
            }

            await writePoolLinesAtomic(this.paths.source, nextSourceLines);
            return {imported, duplicate, invalid, total: incoming.length};
        });
    }

    async exportAndClearSuccess(): Promise<string> {
        return this.withLock(async () => {
            const successLines = await readPoolLines(this.paths.success);
            await writePoolLinesAtomic(this.paths.success, []);
            return ensureTrailingNewline(successLines.join("\n"));
        });
    }

    async successLines(): Promise<string[]> {
        return this.withLock(async () => await readPoolLines(this.paths.success));
    }

    async clearSuccessEmails(emails: string[]): Promise<void> {
        const targets = new Set(emails.map(normalizeEmail).filter(Boolean));
        if (!targets.size) {
            return;
        }
        await this.withLock(async () => {
            const successLines = await readPoolLines(this.paths.success);
            await writePoolLinesAtomic(
                this.paths.success,
                successLines.filter((line) => !targets.has(emailFromLine(line))),
            );
        });
    }

    async returnInflightToSource(): Promise<InflightReturnResult> {
        return this.withLock(async () => {
            const inflightLines = await readPoolLines(this.paths.inflight);
            if (!inflightLines.length) {
                return {returned: 0};
            }

            let sourceLines = await readPoolLines(this.paths.source);
            for (const line of [...inflightLines].reverse()) {
                sourceLines = prependUniqueByEmail(sourceLines, line);
            }
            await writePoolLinesAtomic(this.paths.source, sourceLines);
            await writePoolLinesAtomic(this.paths.inflight, []);
            return {returned: inflightLines.length};
        });
    }

    async markInflightFailed(reason: string): Promise<InflightFailResult> {
        return this.withLock(async () => {
            const inflightLines = await readPoolLines(this.paths.inflight);
            if (!inflightLines.length) {
                return {failed: 0, cleared: 0};
            }

            const failedRaw = await readRawFile(this.paths.failed);
            const failedLines = splitLines(failedRaw);
            const nextFailedLines = [...failedLines];
            let failed = 0;
            const normalizedReason = reason.replace(/\s+/g, " ").slice(0, 240);
            for (const line of inflightLines) {
                const email = emailFromLine(line);
                if (!email || hasEmail(nextFailedLines, email)) {
                    continue;
                }
                nextFailedLines.push(`# failed at ${formatUtc8Timestamp()} reason=${normalizedReason}`, line);
                failed += 1;
            }

            await writeRawFileAtomic(this.paths.failed, ensureTrailingNewline(nextFailedLines.join("\n")));
            await writePoolLinesAtomic(this.paths.inflight, []);
            return {failed, cleared: inflightLines.length};
        });
    }

    private async currentLineForEmail(email: string, fallback: string): Promise<string> {
        const target = normalizeEmail(email);
        for (const file of [this.paths.inflight, this.paths.source, this.paths.success, this.paths.failed]) {
            const lines = await readPoolLines(file);
            const line = lines.find((candidate) => emailFromLine(candidate) === target);
            if (line) {
                return line;
            }
        }
        return fallback;
    }

    private async removeFromActivePools(email: string): Promise<void> {
        for (const file of [this.paths.source, this.paths.inflight]) {
            const lines = await readPoolLines(file);
            await writePoolLinesAtomic(file, removeByEmail(lines, email));
        }
    }

    private resolve(filePath: string): string {
        return path.isAbsolute(filePath) ? filePath : path.resolve(this.baseDir, filePath);
    }

    private async withLock<T>(fn: () => Promise<T>): Promise<T> {
        await acquireLock(this.paths.lock);
        try {
            return await fn();
        } finally {
            await unlink(this.paths.lock).catch(() => undefined);
        }
    }
}

export function emailFromLine(line: string): string {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
        return "";
    }
    return normalizeEmail(trimmed.split("----", 1)[0]);
}

function normalizeEmail(value: string): string {
    return String(value ?? "").trim().toLowerCase();
}

async function acquireLock(lockPath: string): Promise<void> {
    const dir = path.dirname(lockPath);
    await mkdir(dir, {recursive: true});
    await writeFile(path.join(dir, ".free-register-dir-check"), "", {flag: "a"}).catch(() => undefined);
    await unlink(path.join(dir, ".free-register-dir-check")).catch(() => undefined);

    for (;;) {
        try {
            const handle = await open(lockPath, "wx");
            await handle.writeFile(JSON.stringify({pid: process.pid, createdAt: Date.now()}) + "\n", "utf8");
            await handle.close();
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "EEXIST") {
                throw error;
            }
            if (await isStaleLock(lockPath)) {
                await unlink(lockPath).catch(() => undefined);
                continue;
            }
            await sleep(LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_RETRY_MS));
        }
    }
}

async function isStaleLock(lockPath: string): Promise<boolean> {
    try {
        const raw = await readFile(lockPath, "utf8");
        const payload = JSON.parse(raw) as {createdAt?: number};
        return typeof payload.createdAt === "number" && Date.now() - payload.createdAt > LOCK_STALE_MS;
    } catch {
        return false;
    }
}

async function readPoolLines(filePath: string): Promise<string[]> {
    const raw = await readRawFile(filePath);
    return splitLines(raw).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

async function readRawFile(filePath: string): Promise<string> {
    try {
        return await readFile(filePath, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return "";
        }
        throw error;
    }
}

function splitLines(raw: string): string[] {
    return raw.split(/\r?\n/).filter((line) => line.length > 0);
}

async function writePoolLinesAtomic(filePath: string, lines: string[]): Promise<void> {
    await writeRawFileAtomic(filePath, lines.length ? `${lines.join("\n")}\n` : "");
}

async function writeRawFileAtomic(filePath: string, content: string): Promise<void> {
    await mkdir(path.dirname(filePath), {recursive: true});
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, filePath);
}

function appendUniqueByEmail(lines: string[], line: string): string[] {
    const email = emailFromLine(line);
    if (hasEmail(lines, email)) {
        return lines;
    }
    return [...lines, line];
}

function prependUniqueByEmail(lines: string[], line: string): string[] {
    const email = emailFromLine(line);
    if (hasEmail(lines, email)) {
        return lines;
    }
    return [line, ...lines];
}

function removeByEmail(lines: string[], email: string): string[] {
    const target = normalizeEmail(email);
    return lines.filter((line) => emailFromLine(line) !== target);
}

function hasEmail(lines: string[], email: string): boolean {
    const target = normalizeEmail(email);
    return lines.some((line) => emailFromLine(line) === target);
}

function ensureTrailingNewline(value: string): string {
    if (!value) return "";
    return value.endsWith("\n") ? value : `${value}\n`;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
