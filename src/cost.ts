import {appendFile, mkdir, open, readFile, rename, unlink, writeFile} from "node:fs/promises";
import path from "node:path";
import type {CostConfig} from "./config.js";
import {emailFromLine} from "./email-pool.js";

const LOCK_RETRY_MS = 40;
const LOCK_STALE_MS = 5 * 60 * 1000;
const COST_PRECISION = 1_000_000;

export interface SuccessCostRecord {
    time: string;
    email: string;
    phone: string;
    emailCost: number;
    smsGrossCost: number;
    smsRefundCost: number;
    smsCost: number;
    totalCost: number;
    currency: string;
}

export interface SuccessCostSummary {
    count: number;
    ledgerCount: number;
    estimatedCount: number;
    emailTotal: number;
    smsGrossTotal: number;
    smsRefundTotal: number;
    smsTotal: number;
    total: number;
    average: number;
    currency: string;
    ledger: string;
}

interface LedgerLine {
    raw: string;
    record: SuccessCostRecord | null;
}

export async function appendSuccessCostRecord(
    config: CostConfig,
    input: {
        email: string;
        phone: string;
        emailCost?: number;
        smsGrossCost?: number;
        smsRefundCost?: number;
        smsCost?: number;
        currency?: string;
        time?: string;
    },
): Promise<SuccessCostRecord> {
    const email = normalizeEmail(input.email);
    if (!email) {
        throw new Error("成本流水 email 为空");
    }

    const emailCost = nonNegativeCost(input.emailCost ?? config.emailUnitCost);
    const smsGrossCost = nonNegativeCost(input.smsGrossCost ?? input.smsCost ?? 0);
    const smsRefundCost = nonNegativeCost(input.smsRefundCost ?? 0);
    const smsCost = nonNegativeCost(input.smsCost ?? Math.max(0, smsGrossCost - smsRefundCost));
    const record: SuccessCostRecord = {
        time: input.time || new Date().toISOString(),
        email,
        phone: String(input.phone ?? "").trim(),
        emailCost,
        smsGrossCost,
        smsRefundCost,
        smsCost,
        totalCost: roundCost(emailCost + smsCost),
        currency: String(input.currency || config.currency || "USD").trim() || "USD",
    };

    await withCostLock(config, async () => {
        await mkdir(path.dirname(config.successLedger), {recursive: true});
        await appendFile(config.successLedger, `${JSON.stringify(record)}\n`, "utf8");
    });

    return record;
}

export async function summarizeSuccessCosts(config: CostConfig, successLines: string[]): Promise<SuccessCostSummary> {
    const successEmails = successLines.map(emailFromLine).filter(Boolean);
    const successEmailSet = new Set(successEmails);
    const recordsByEmail = new Map<string, SuccessCostRecord>();

    for (const line of await readLedgerLines(config.successLedger)) {
        if (!line.record || !successEmailSet.has(line.record.email)) continue;
        recordsByEmail.set(line.record.email, line.record);
    }

    let ledgerCount = 0;
    let emailTotal = 0;
    let smsGrossTotal = 0;
    let smsRefundTotal = 0;
    let smsTotal = 0;

    for (const email of successEmails) {
        const record = recordsByEmail.get(email);
        if (record) {
            ledgerCount += 1;
            emailTotal += nonNegativeCost(record.emailCost);
            smsGrossTotal += nonNegativeCost(record.smsGrossCost);
            smsRefundTotal += nonNegativeCost(record.smsRefundCost);
            smsTotal += nonNegativeCost(record.smsCost);
        } else {
            emailTotal += nonNegativeCost(config.emailUnitCost);
        }
    }

    const total = roundCost(emailTotal + smsTotal);
    const count = successEmails.length;
    return {
        count,
        ledgerCount,
        estimatedCount: Math.max(0, count - ledgerCount),
        emailTotal: roundCost(emailTotal),
        smsGrossTotal: roundCost(smsGrossTotal),
        smsRefundTotal: roundCost(smsRefundTotal),
        smsTotal: roundCost(smsTotal),
        total,
        average: count ? roundCost(total / count) : 0,
        currency: config.currency || "USD",
        ledger: config.successLedger,
    };
}

export async function successCostLinesForEmails(config: CostConfig, emails: string[]): Promise<string[]> {
    const targets = new Set(emails.map(normalizeEmail).filter(Boolean));
    if (!targets.size) return [];
    const matched: string[] = [];
    for (const line of await readLedgerLines(config.successLedger)) {
        if (line.record && targets.has(line.record.email)) {
            matched.push(line.raw);
        }
    }
    return matched;
}

export async function removeSuccessCostRecords(config: CostConfig, emails: string[]): Promise<{removed: number}> {
    const targets = new Set(emails.map(normalizeEmail).filter(Boolean));
    if (!targets.size) return {removed: 0};

    return withCostLock(config, async () => {
        const lines = await readLedgerLines(config.successLedger);
        let removed = 0;
        const kept: string[] = [];
        for (const line of lines) {
            if (line.record && targets.has(line.record.email)) {
                removed += 1;
                continue;
            }
            kept.push(line.raw);
        }
        await writeFileAtomic(config.successLedger, kept.length ? `${kept.join("\n")}\n` : "");
        return {removed};
    });
}

async function readLedgerLines(filePath: string): Promise<LedgerLine[]> {
    let raw = "";
    try {
        raw = await readFile(filePath, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }

    const lines: LedgerLine[] = [];
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        lines.push({raw: trimmed, record: parseCostRecord(trimmed)});
    }
    return lines;
}

function parseCostRecord(line: string): SuccessCostRecord | null {
    try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const email = normalizeEmail(parsed.email);
        if (!email) return null;
        const emailCost = nonNegativeCost(Number(parsed.emailCost));
        const fallbackSmsCost = nonNegativeCost(Number(parsed.smsCost));
        const smsGrossCost = "smsGrossCost" in parsed
            ? nonNegativeCost(Number(parsed.smsGrossCost))
            : fallbackSmsCost;
        const smsRefundCost = "smsRefundCost" in parsed
            ? nonNegativeCost(Number(parsed.smsRefundCost))
            : 0;
        const smsCost = "smsCost" in parsed
            ? fallbackSmsCost
            : nonNegativeCost(smsGrossCost - smsRefundCost);
        return {
            time: String(parsed.time || ""),
            email,
            phone: String(parsed.phone || ""),
            emailCost,
            smsGrossCost,
            smsRefundCost,
            smsCost,
            totalCost: nonNegativeCost(Number(parsed.totalCost ?? emailCost + smsCost)),
            currency: String(parsed.currency || "USD"),
        };
    } catch {
        return null;
    }
}

function normalizeEmail(value: unknown): string {
    return String(value ?? "").trim().toLowerCase();
}

function nonNegativeCost(value: number): number {
    return Number.isFinite(value) && value > 0 ? roundCost(value) : 0;
}

function roundCost(value: number): number {
    return Math.round(value * COST_PRECISION) / COST_PRECISION;
}

async function withCostLock<T>(config: CostConfig, fn: () => Promise<T>): Promise<T> {
    await acquireLock(config.lock);
    try {
        return await fn();
    } finally {
        await unlink(config.lock).catch(() => undefined);
    }
}

async function acquireLock(lockPath: string): Promise<void> {
    const dir = path.dirname(lockPath);
    await mkdir(dir, {recursive: true});

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

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
    await mkdir(path.dirname(filePath), {recursive: true});
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, filePath);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
}
