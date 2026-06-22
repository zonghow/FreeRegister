import {getHeapStatistics} from "node:v8";
import {heroSmsProxyForWorker, proxyForWorker, redactProxy, type AppConfig, type RunConcurrencyMode} from "./config.js";
import {EmailPool, type EmailLease} from "./email-pool.js";
import {appendSuccessCostRecord} from "./cost.js";
import {generateRandomDeviceProfile} from "./device-profile.js";
import {createHotmailProvider} from "./mail/hotmail.js";
import {OpenAIClient} from "./openai.js";
import {createSMSBroker, getHeroSmsRpsStats} from "./sms/index.js";
import {formatUtc8Timestamp} from "./utils.js";

export interface JobResult {
    ok: boolean;
    skipped?: boolean;
    forced?: boolean;
}

export interface RegisterLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

export type RunnerStatus = "idle" | "running" | "pausing" | "force_pausing" | "paused" | "force_paused" | "completed" | "failed";
export type WorkerStatus = "idle" | "running" | "success" | "failed" | "skipped" | "paused" | "force_paused";
export type WorkerStage =
    | "idle"
    | "leasing_email"
    | "phone_acquire"
    | "phone_signup"
    | "phone_sms_wait"
    | "phone_registered"
    | "oauth_start"
    | "email_otp_wait"
    | "oauth_exchange"
    | "success"
    | "failed"
    | "skipped"
    | "force_paused";

export interface WorkerSnapshot {
    workerId: number;
    status: WorkerStatus;
    stage: WorkerStage;
    jobId: number;
    email: string;
    phone: string;
    proxy: string;
    startedAt: string;
    updatedAt: string;
    elapsedMs: number;
    latestLog: string;
    error: string;
}

export type MemoryGuardLevel = "ok" | "soft" | "hard";

export interface RuntimeMemorySnapshot {
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
    heapLimitMb: number;
    externalMb: number;
    arrayBuffersMb: number;
    guardUsedMb: number;
    softLimitMb: number;
    hardLimitMb: number;
    level: MemoryGuardLevel;
    checkedAt: string;
}

export interface RunnerSnapshot {
    status: RunnerStatus;
    total: number;
    concurrency: number;
    concurrencyMode: RunConcurrencyMode;
    runUntilEmpty: boolean;
    nextJob: number;
    activeWorkers: number;
    currentConcurrency: number;
    targetConcurrency: number;
    maxConcurrency: number;
    adaptiveReason: string;
    adaptiveSmsRps: number;
    adaptiveSmsRpsLimit: number;
    adaptiveSmsRpsUtilization: number;
    adaptiveTargetSmsRpsUtilization: number;
    adaptiveSlotWaiters: number;
    okCount: number;
    failedCount: number;
    skippedCount: number;
    startedAt: string;
    endedAt: string;
    activeRunElapsedMs: number;
    avgSuccessIntervalMs: number;
    lastError: string;
    memory: RuntimeMemorySnapshot;
    workers: WorkerSnapshot[];
}

const DEFAULT_LOGGER: RegisterLogger = {
    info: (message) => console.log(message),
    warn: (message) => console.warn(message),
    error: (message) => console.error(message),
};

const FORCE_PAUSE_MESSAGE = "任务已被强制暂停";
const MEMORY_MONITOR_INTERVAL_MS = 5000;
const AUTO_MEMORY_SOFT_RATIO = 0.82;
const AUTO_MEMORY_HARD_RATIO = 0.9;
const ADAPTIVE_ABSOLUTE_MAX_CONCURRENCY = 1000;
const ADAPTIVE_WARMUP_BATCH = 5;
const ADAPTIVE_WARMUP_INTERVAL_MS = 250;
const ADAPTIVE_EWMA_ALPHA = 0.35;
const ADAPTIVE_DEFAULT_WORKER_MB = 64;
const ADAPTIVE_MIN_WORKER_MB = 16;
const MB = 1024 * 1024;

function bytesToMb(bytes: number): number {
    return Math.round(bytes / MB);
}

function runtimeMemorySnapshot(config?: AppConfig): RuntimeMemorySnapshot {
    const usage = process.memoryUsage();
    const heapLimitMb = bytesToMb(getHeapStatistics().heap_size_limit);
    const autoSoftLimitMb = Math.max(256, Math.floor(heapLimitMb * AUTO_MEMORY_SOFT_RATIO));
    const autoHardLimitMb = Math.max(autoSoftLimitMb + 1, Math.floor(heapLimitMb * AUTO_MEMORY_HARD_RATIO));
    const configuredHardLimitMb = Math.floor(config?.run.memoryHardLimitMb ?? 0);
    const hardLimitMb = configuredHardLimitMb > 0 ? configuredHardLimitMb : autoHardLimitMb;
    const configuredSoftLimitMb = Math.floor(config?.run.memorySoftLimitMb ?? 0);
    const softLimitMb = configuredSoftLimitMb > 0
        ? Math.min(configuredSoftLimitMb, Math.max(1, hardLimitMb - 1))
        : Math.min(autoSoftLimitMb, Math.max(1, hardLimitMb - 1));
    const rssMb = bytesToMb(usage.rss);
    const heapUsedMb = bytesToMb(usage.heapUsed);
    const guardUsedMb = Math.max(rssMb, heapUsedMb);
    const level: MemoryGuardLevel = guardUsedMb >= hardLimitMb
        ? "hard"
        : (guardUsedMb >= softLimitMb ? "soft" : "ok");
    return {
        rssMb,
        heapUsedMb,
        heapTotalMb: bytesToMb(usage.heapTotal),
        heapLimitMb,
        externalMb: bytesToMb(usage.external),
        arrayBuffersMb: bytesToMb(usage.arrayBuffers),
        guardUsedMb,
        softLimitMb,
        hardLimitMb,
        level,
        checkedAt: new Date().toISOString(),
    };
}

function createForcePauseError(): Error {
    const error = new Error(FORCE_PAUSE_MESSAGE);
    error.name = "ForcePauseError";
    return error;
}

function isForcePauseError(error: unknown): boolean {
    return error instanceof Error && (error.name === "ForcePauseError" || /aborted|abort|强制暂停/i.test(error.message));
}

function throwIfForcePaused(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw createForcePauseError();
    }
}

function emptySnapshot(): RunnerSnapshot {
    return {
        status: "idle",
        total: 0,
        concurrency: 0,
        concurrencyMode: "fixed",
        runUntilEmpty: false,
        nextJob: 1,
        activeWorkers: 0,
        currentConcurrency: 0,
        targetConcurrency: 0,
        maxConcurrency: 0,
        adaptiveReason: "idle",
        adaptiveSmsRps: 0,
        adaptiveSmsRpsLimit: 0,
        adaptiveSmsRpsUtilization: 0,
        adaptiveTargetSmsRpsUtilization: 0,
        adaptiveSlotWaiters: 0,
        okCount: 0,
        failedCount: 0,
        skippedCount: 0,
        startedAt: "",
        endedAt: "",
        activeRunElapsedMs: 0,
        avgSuccessIntervalMs: 0,
        lastError: "",
        memory: runtimeMemorySnapshot(),
        workers: [],
    };
}

function emptyWorkerSnapshot(workerId: number): WorkerSnapshot {
    return {
        workerId,
        status: "idle",
        stage: "idle",
        jobId: 0,
        email: "",
        phone: "",
        proxy: "",
        startedAt: "",
        updatedAt: "",
        elapsedMs: 0,
        latestLog: "等待任务",
        error: "",
    };
}

function withElapsed(worker: WorkerSnapshot): WorkerSnapshot {
    const startedAt = Date.parse(worker.startedAt);
    const updatedAt = Date.parse(worker.updatedAt);
    const end = Number.isFinite(updatedAt) ? updatedAt : Date.now();
    return {
        ...worker,
        elapsedMs: Number.isFinite(startedAt) ? Math.max(0, end - startedAt) : 0,
    };
}

export function computeRunnerThroughput(
    snapshot: Pick<RunnerSnapshot, "status" | "startedAt" | "endedAt" | "okCount">,
    nowMs = Date.now(),
): Pick<RunnerSnapshot, "activeRunElapsedMs" | "avgSuccessIntervalMs"> {
    const startedAtMs = Date.parse(snapshot.startedAt);
    if (!Number.isFinite(startedAtMs)) {
        return {activeRunElapsedMs: 0, avgSuccessIntervalMs: 0};
    }

    const activeStatuses: RunnerStatus[] = ["running", "pausing", "force_pausing"];
    const endedAtMs = Date.parse(snapshot.endedAt);
    const endMs = activeStatuses.includes(snapshot.status) || !Number.isFinite(endedAtMs)
        ? nowMs
        : endedAtMs;
    const activeRunElapsedMs = Math.max(0, Math.round(endMs - startedAtMs));
    const okCount = Math.max(0, Math.floor(snapshot.okCount));
    return {
        activeRunElapsedMs,
        avgSuccessIntervalMs: okCount > 0 ? Math.round(activeRunElapsedMs / okCount) : 0,
    };
}

export interface HeroSmsPressureSnapshot {
    totalRps: number;
    totalLimit: number;
    utilization: number;
    pendingHigh: number;
    pendingLow: number;
    pendingTotal: number;
    oldestPendingMs: number;
}

export interface AdaptiveMaxConcurrencyInput {
    memory: Pick<RuntimeMemorySnapshot, "guardUsedMb" | "softLimitMb" | "hardLimitMb">;
    baselineGuardUsedMb: number;
    currentConcurrency: number;
    absoluteMax?: number;
}

export interface AdaptiveTargetInput {
    currentConcurrency: number;
    targetConcurrency: number;
    maxConcurrency: number;
    memoryLevel: MemoryGuardLevel;
    rpsEwma: number;
    targetSmsRpsUtilization: number;
    pendingTotal: number;
    totalRpsLimit: number;
    oldestPendingMs: number;
    controlIntervalMs: number;
}

export interface AdaptiveTargetDecision {
    targetConcurrency: number;
    reason: string;
}

export function heroSmsPressureSnapshot(config: AppConfig): HeroSmsPressureSnapshot {
    const keys = getHeroSmsRpsStats(config.heroSMS.apiKeys, {rpsLimit: config.heroSMS.rpsLimit});
    const activeKeys = keys.filter((item) => !item.disabled);
    const totalRps = Math.round(keys.reduce((sum, item) => sum + item.rps, 0) * 100) / 100;
    const totalLimit = activeKeys.reduce((sum, item) => sum + item.rpsLimit, 0);
    const pendingHigh = keys.reduce((sum, item) => sum + (item.pendingHigh || 0), 0);
    const pendingLow = keys.reduce((sum, item) => sum + (item.pendingLow || 0), 0);
    const oldestPendingMs = keys.reduce((max, item) => Math.max(max, item.oldestPendingMs || 0), 0);
    return {
        totalRps,
        totalLimit,
        utilization: totalLimit > 0 ? totalRps / totalLimit : 0,
        pendingHigh,
        pendingLow,
        pendingTotal: pendingHigh + pendingLow,
        oldestPendingMs,
    };
}

export function estimateAdaptiveMaxConcurrency(input: AdaptiveMaxConcurrencyInput): number {
    const absoluteMax = Math.max(1, Math.floor(input.absoluteMax ?? ADAPTIVE_ABSOLUTE_MAX_CONCURRENCY));
    const softLimitMb = Math.max(1, Math.floor(input.memory.softLimitMb || input.memory.hardLimitMb || 1));
    const baselineMb = Math.max(0, Math.floor(input.baselineGuardUsedMb || 0));
    const currentConcurrency = Math.max(0, Math.floor(input.currentConcurrency || 0));
    const usedOverBaseline = Math.max(0, input.memory.guardUsedMb - baselineMb);
    const observedWorkerMb = currentConcurrency > 0 && usedOverBaseline > 0
        ? Math.max(ADAPTIVE_MIN_WORKER_MB, usedOverBaseline / currentConcurrency)
        : ADAPTIVE_DEFAULT_WORKER_MB;
    const capacityMb = Math.max(0, softLimitMb - baselineMb);
    const estimated = Math.floor(capacityMb / observedWorkerMb);
    return Math.min(absoluteMax, Math.max(1, estimated));
}

export function computeAdaptiveTargetConcurrency(input: AdaptiveTargetInput): AdaptiveTargetDecision {
    const current = Math.max(0, Math.floor(input.currentConcurrency || 0));
    let target = Math.max(1, Math.floor(input.targetConcurrency || 1));
    const maxConcurrency = Math.max(1, Math.floor(input.maxConcurrency || 1));
    const targetUtil = Math.min(1, Math.max(0.1, input.targetSmsRpsUtilization || 0.9));
    const waitBackpressure =
        input.pendingTotal > Math.max(2, Math.ceil(Math.max(1, input.totalRpsLimit) * 0.25)) ||
        input.oldestPendingMs > Math.max(1000, Math.floor(input.controlIntervalMs / 2));
    let reason = "steady";

    if (input.memoryLevel !== "ok") {
        target = Math.max(1, Math.min(target, current - adaptiveScaleStep(current)));
        reason = input.memoryLevel === "hard" ? "memory_hard_force_pause" : "memory_high_drain";
    } else if (target > maxConcurrency) {
        target = Math.max(1, maxConcurrency);
        reason = "memory_cap_drain";
    } else if (waitBackpressure) {
        target = Math.max(1, target - adaptiveScaleStep(target));
        reason = "slot_wait_backpressure";
    } else if (input.totalRpsLimit <= 0) {
        reason = "no_sms_keys";
    } else if (input.rpsEwma < targetUtil * 0.75 && current < maxConcurrency) {
        target = Math.min(maxConcurrency, target + adaptiveScaleStep(target));
        reason = "rps_low_scale_up";
    } else if (input.rpsEwma >= targetUtil) {
        reason = "rps_target_reached";
    }

    return {targetConcurrency: target, reason};
}

type WorkerUpdate = (patch: Partial<Omit<WorkerSnapshot, "workerId" | "elapsedMs">>) => void;
type WorkerLoop = (workerId: number, adaptive: boolean) => Promise<void>;

interface WorkerRunState {
    sourceEmpty: boolean;
    retireRequests: number;
}

function sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
}

function adaptiveScaleStep(value: number): number {
    return Math.max(1, Math.ceil(Math.max(1, value) * 0.2));
}

function createBroker(config: AppConfig, proxyUrl: string) {
    const hero = config.heroSMS;
    if (!hero.apiKeys.length) {
        throw new Error("缺少 [hero_sms].api_keys 或 [hero_sms].api_key");
    }
    return createSMSBroker({
        apiKeys: hero.apiKeys,
        apiKeyStrategy: hero.apiKeyStrategy,
        rpsLimit: hero.rpsLimit,
        proxyUrl,
        pollIntervalMs: hero.pollIntervalMs,
        countries: hero.countries,
        acquirePriority: hero.acquirePriority,
        minPrice: hero.minPrice,
        maxPrice: hero.maxPrice,
        priceStep: hero.priceStep,
        autoReleaseOnTimeout: hero.autoReleaseOnTimeout,
    });
}

function isEmailTouchedError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /add-email|email-verification|email_already_in_use|Hotmail|邮箱|OTP/i.test(message);
}

async function phoneSignup(
    config: AppConfig,
    proxyUrl: string,
    workerId: number,
    logger: RegisterLogger,
    signal?: AbortSignal,
    updateWorker?: WorkerUpdate,
): Promise<{phone: string; smsCost: number; smsGrossCost: number; smsRefundCost: number}> {
    const smsBroker = createBroker(config, heroSmsProxyForWorker(config, workerId - 1));
    let lastErr: unknown = null;

    for (let phoneTry = 1; phoneTry <= config.heroSMS.maxPhoneTries; phoneTry += 1) {
        throwIfForcePaused(signal);
        updateWorker?.({
            status: "running",
            stage: "phone_acquire",
            latestLog: `取号 (${phoneTry}/${config.heroSMS.maxPhoneTries})`,
        });
        logger.info(`\n[worker-${workerId}] [phone] (${phoneTry}/${config.heroSMS.maxPhoneTries}) 取号...`);
        const lease = await smsBroker.getActivation();
        throwIfForcePaused(signal);
        const phoneNumber = `+${lease.phoneNumber}`;
        updateWorker?.({
            status: "running",
            stage: "phone_signup",
            phone: phoneNumber,
            latestLog: `取到号码 ${phoneNumber}`,
        });
        logger.info(`[worker-${workerId}] [phone] 取到号码 ${phoneNumber}`);

        const signupClient = new OpenAIClient({
            email: undefined,
            password: config.openai.defaultPassword,
            deviceProfile: generateRandomDeviceProfile(),
            manualMode: false,
            smsBroker,
            proxyUrl,
            useBrowserSentinel: config.run.useBrowserSentinel,
            sentinelBrowserPath: config.sentinelBrowser.path,
            saveAuthJson: false,
            abortSignal: signal,
        });

        try {
            await signupClient.authPhoneSignupHTTP(phoneNumber, async () => {
                throwIfForcePaused(signal);
                updateWorker?.({
                    status: "running",
                    stage: "phone_sms_wait",
                    phone: phoneNumber,
                    latestLog: "等待手机 OTP",
                });
                logger.info(`[worker-${workerId}] [phone] 等待 OTP...`);
                const {code} = await lease.waitForVerificationCode({signal});
                throwIfForcePaused(signal);
                updateWorker?.({
                    status: "running",
                    stage: "phone_signup",
                    phone: phoneNumber,
                    latestLog: "收到手机 OTP",
                });
                logger.info(`[worker-${workerId}] [phone] 收到 OTP: ${code}`);
                return code;
            });
            throwIfForcePaused(signal);
            updateWorker?.({
                status: "running",
                stage: "phone_registered",
                phone: phoneNumber,
                latestLog: `手机注册成功 ${phoneNumber}`,
            });
            logger.info(`[worker-${workerId}] [phone] 注册成功 ${phoneNumber}`);
            const cost = smsBroker.getCostSummary();
            return {
                phone: phoneNumber,
                smsCost: cost.netCost,
                smsGrossCost: cost.grossCost,
                smsRefundCost: cost.refundCost,
            };
        } catch (error) {
            if (signal?.aborted) {
                try {
                    await smsBroker.markAsFailed(true);
                } catch {
                    // 忽略接码平台回收失败，继续结束任务。
                }
                throw createForcePauseError();
            }
            lastErr = error;
            updateWorker?.({
                status: "running",
                stage: "phone_acquire",
                phone: phoneNumber,
                latestLog: `手机号失败，准备换号: ${(error as Error).message}`,
                error: (error as Error).message,
            });
            logger.warn(`[worker-${workerId}] [phone] (${phoneTry}/${config.heroSMS.maxPhoneTries}) 失败: ${(error as Error).message}`);
            try {
                await smsBroker.markAsFailed(true);
            } catch {
                // 忽略接码平台回收失败，继续换号。
            }
        } finally {
            try {
                await signupClient.close();
            } catch (closeError) {
                logger.warn(`[worker-${workerId}] [phone] OpenAI client 关闭失败: ${(closeError as Error).message}`);
            }
        }
    }

    throw lastErr ?? new Error("phone signup 多次换号均失败");
}

async function bindEmailViaOAuth(
    config: AppConfig,
    pool: EmailPool,
    lease: EmailLease,
    phone: string,
    proxyUrl: string,
    workerId: number,
    logger: RegisterLogger,
    signal?: AbortSignal,
    updateWorker?: WorkerUpdate,
): Promise<void> {
    throwIfForcePaused(signal);
    const hotmailProvider = createHotmailProvider({lease, pool, proxyUrl});
    const bindEmail = await hotmailProvider.getEmailAddress();
    updateWorker?.({
        status: "running",
        stage: "oauth_start",
        email: bindEmail,
        phone,
        latestLog: `绑定邮箱候选 ${bindEmail}`,
        error: "",
    });
    logger.info(`[worker-${workerId}] [oauth] 绑定邮箱候选: ${bindEmail}`);

    const oauthClient = new OpenAIClient({
        email: phone,
        password: config.openai.defaultPassword,
        deviceProfile: generateRandomDeviceProfile(),
        manualMode: false,
        bindEmail,
        fetchAddEmailOtp: async () => {
            throwIfForcePaused(signal);
            const startedAt = Date.now();
            updateWorker?.({
                status: "running",
                stage: "email_otp_wait",
                email: bindEmail,
                phone,
                latestLog: "等待邮箱 OTP",
            });
            logger.info(`[worker-${workerId}] [email] 等待 OTP for ${bindEmail} (after=${formatUtc8Timestamp(startedAt)})`);
            const code = await hotmailProvider.getEmailVerificationCode(bindEmail, {minTimestampMs: startedAt, signal});
            throwIfForcePaused(signal);
            updateWorker?.({
                status: "running",
                stage: "oauth_exchange",
                email: bindEmail,
                phone,
                latestLog: "收到邮箱 OTP，继续 OAuth",
            });
            return code;
        },
        proxyUrl,
        useBrowserSentinel: config.run.useBrowserSentinel,
        sentinelBrowserPath: config.sentinelBrowser.path,
        saveAuthJson: true,
        authJsonDir: config.cpaJson.dir,
        abortSignal: signal,
    });

    updateWorker?.({
        status: "running",
        stage: "oauth_exchange",
        email: bindEmail,
        phone,
        latestLog: "Codex OAuth 中",
    });
    try {
        const authResult = await oauthClient.authLoginHTTP();
        throwIfForcePaused(signal);
        updateWorker?.({
            status: "running",
            stage: "oauth_exchange",
            email: bindEmail,
            phone,
            latestLog: `OAuth 完成 cpa_json=${authResult.authFile || "not-saved"}`,
        });
        logger.info(`[worker-${workerId}] [oauth] 完成 phone=${phone} email=${bindEmail} cpa_json=${authResult.authFile || "not-saved"}`);
    } finally {
        try {
            await oauthClient.close();
        } catch (closeError) {
            logger.warn(`[worker-${workerId}] [oauth] OpenAI client 关闭失败: ${(closeError as Error).message}`);
        }
    }
}

export async function runOne(
    config: AppConfig,
    pool: EmailPool,
    jobId: number,
    workerId: number,
    logger: RegisterLogger = DEFAULT_LOGGER,
    signal?: AbortSignal,
    updateWorker?: WorkerUpdate,
): Promise<JobResult> {
    throwIfForcePaused(signal);
    const proxyUrl = proxyForWorker(config, workerId - 1);
    const smsProxyUrl = heroSmsProxyForWorker(config, workerId - 1);
    const totalLabel = config.run.runUntilEmpty ? "until-empty" : String(config.run.total);
    updateWorker?.({
        status: "running",
        stage: "leasing_email",
        jobId,
        email: "",
        phone: "",
        proxy: redactProxy(proxyUrl),
        startedAt: new Date().toISOString(),
        latestLog: `job ${jobId}/${totalLabel} 开始`,
        error: "",
    });
    logger.info(`\n========== [job ${jobId}/${totalLabel}] worker=${workerId} proxy=${redactProxy(proxyUrl)} heroSmsProxy=${redactProxy(smsProxyUrl)} ==========`);

    const emailLease = await pool.leaseEmail();
    if (!emailLease) {
        updateWorker?.({
            status: "skipped",
            stage: "skipped",
            latestLog: `邮箱池为空，跳过 job=${jobId}`,
        });
        logger.warn(`[worker-${workerId}] 邮箱池为空，跳过 job=${jobId}`);
        return {ok: false, skipped: true};
    }
    updateWorker?.({
        status: "running",
        stage: "phone_acquire",
        email: emailLease.email,
        latestLog: `已租约 ${emailLease.email}`,
    });
    logger.info(`[worker-${workerId}] [email] 已租约 ${emailLease.email}`);

    let phone = "";
    let smsCost = 0;
    let smsGrossCost = 0;
    let smsRefundCost = 0;
    try {
        const signup = await phoneSignup(config, proxyUrl, workerId, logger, signal, updateWorker);
        phone = signup.phone;
        smsCost = signup.smsCost;
        smsGrossCost = signup.smsGrossCost;
        smsRefundCost = signup.smsRefundCost;
    } catch (error) {
        if (signal?.aborted) {
            updateWorker?.({
                status: "force_paused",
                stage: "force_paused",
                email: emailLease.email,
                latestLog: `手机阶段中止，邮箱放回池: ${emailLease.email}`,
            });
            logger.warn(`[worker-${workerId}] [force-pause] 手机阶段中止，邮箱放回池: ${emailLease.email}`);
            await pool.returnToSource(emailLease);
            return {ok: false, forced: true};
        }
        updateWorker?.({
            status: "failed",
            stage: "failed",
            email: emailLease.email,
            latestLog: `手机注册失败，邮箱放回池: ${(error as Error).message}`,
            error: (error as Error).message,
        });
        logger.warn(`[worker-${workerId}] [phone] 注册失败，邮箱放回池: ${(error as Error).message}`);
        await pool.returnToSource(emailLease);
        return {ok: false};
    }

    try {
        await bindEmailViaOAuth(config, pool, emailLease, phone, proxyUrl, workerId, logger, signal, updateWorker);
        await pool.markSuccess(emailLease);
        try {
            const costRecord = await appendSuccessCostRecord(config.cost, {
                email: emailLease.email,
                phone,
                emailCost: config.cost.emailUnitCost,
                smsCost,
                smsGrossCost,
                smsRefundCost,
                currency: config.cost.currency,
            });
            logger.info(`[worker-${workerId}] [cost] email=${emailLease.email} sms_gross=${costRecord.smsGrossCost} sms_refund=${costRecord.smsRefundCost} sms=${costRecord.smsCost} email_cost=${costRecord.emailCost} total=${costRecord.totalCost} ${costRecord.currency}`);
        } catch (costError) {
            logger.warn(`[worker-${workerId}] [cost] 成本流水写入失败，不影响成功结果: ${(costError as Error).message}`);
        }
        updateWorker?.({
            status: "success",
            stage: "success",
            email: emailLease.email,
            phone,
            latestLog: `成功 phone=${phone} email=${emailLease.email}`,
            error: "",
        });
        logger.info(`[worker-${workerId}] [success] phone=${phone} email=${emailLease.email}`);
        logger.info(`[POOL-RESULT] status=ok phone=${phone} email=${emailLease.email}`);
        return {ok: true};
    } catch (error) {
        if (signal?.aborted) {
            const reason = `force_paused: ${FORCE_PAUSE_MESSAGE}`;
            updateWorker?.({
                status: "force_paused",
                stage: "force_paused",
                email: emailLease.email,
                phone,
                latestLog: reason,
                error: reason,
            });
            logger.warn(`[worker-${workerId}] [force-pause] email=${emailLease.email} reason=${reason}`);
            await pool.markFailed(emailLease, reason);
            logger.info(`[POOL-RESULT] status=force-paused phone=${phone} email=${emailLease.email}`);
            return {ok: false, forced: true};
        }
        const message = error instanceof Error ? error.message : String(error);
        const reason = isEmailTouchedError(error) ? message : `oauth_uncertain: ${message}`;
        updateWorker?.({
            status: "failed",
            stage: "failed",
            email: emailLease.email,
            phone,
            latestLog: reason,
            error: reason,
        });
        logger.warn(`[worker-${workerId}] [failed] email=${emailLease.email} reason=${reason}`);
        await pool.markFailed(emailLease, reason);
        logger.info(`[POOL-RESULT] status=failed phone=${phone} email=${emailLease.email}`);
        return {ok: false};
    }
}

export class RegisterTaskRunner {
    private snapshot = emptySnapshot();
    private pauseRequested = false;
    private forcePauseRequested = false;
    private abortController: AbortController | null = null;
    private promise: Promise<RunnerSnapshot> | null = null;
    private memoryMonitor: ReturnType<typeof setInterval> | null = null;
    private memoryGuardLevel: MemoryGuardLevel = "ok";
    private memoryConfig: AppConfig | null = null;

    constructor(private readonly logger: RegisterLogger = DEFAULT_LOGGER) {}

    start(config: AppConfig): RunnerSnapshot {
        if (this.snapshot.status === "running" || this.snapshot.status === "pausing" || this.snapshot.status === "force_pausing") {
            throw new Error("任务正在运行");
        }

        const total = config.run.runUntilEmpty ? 0 : config.run.total;
        const concurrency = config.run.runUntilEmpty
            ? config.run.concurrency
            : Math.min(config.run.concurrency, total);
        this.pauseRequested = false;
        this.forcePauseRequested = false;
        this.memoryGuardLevel = "ok";
        this.memoryConfig = config;
        this.abortController = new AbortController();
        this.snapshot = {
            ...emptySnapshot(),
            status: "running",
            total,
            concurrency,
            concurrencyMode: config.run.concurrencyMode,
            runUntilEmpty: config.run.runUntilEmpty,
            currentConcurrency: config.run.concurrencyMode === "adaptive" ? 0 : concurrency,
            targetConcurrency: concurrency,
            maxConcurrency: concurrency,
            adaptiveReason: config.run.concurrencyMode === "adaptive" ? "warmup" : "fixed",
            adaptiveTargetSmsRpsUtilization: config.run.concurrencyMode === "adaptive" ? config.run.adaptiveTargetSmsRpsUtilization : 0,
            startedAt: new Date().toISOString(),
            memory: runtimeMemorySnapshot(config),
            workers: config.run.concurrencyMode === "adaptive"
                ? []
                : Array.from({length: concurrency}, (_, index) => emptyWorkerSnapshot(index + 1)),
        };

        this.startMemoryMonitor(config);
        this.promise = this.run(config)
            .catch((error) => {
                this.snapshot.status = "failed";
                this.snapshot.lastError = error instanceof Error ? error.stack || error.message : String(error);
                this.logger.error(`[FreeRegister] 致命错误: ${this.snapshot.lastError}`);
                return this.snapshot;
            })
            .finally(() => {
                this.stopMemoryMonitor();
                this.snapshot.memory = runtimeMemorySnapshot(config);
                this.snapshot.endedAt = new Date().toISOString();
                this.snapshot.activeWorkers = 0;
                this.snapshot.currentConcurrency = 0;
                for (const worker of this.snapshot.workers) {
                    if (worker.status === "running") {
                        this.updateWorker(worker.workerId, {
                            status: this.forcePauseRequested ? "force_paused" : "idle",
                            stage: this.forcePauseRequested ? "force_paused" : "idle",
                            latestLog: this.forcePauseRequested ? "已强制暂停" : "已停止",
                        });
                    }
                }
            });

        return this.getSnapshot();
    }

    pause(): RunnerSnapshot {
        if (this.snapshot.status === "running") {
            this.pauseRequested = true;
            this.snapshot.status = "pausing";
            this.logger.warn("[FreeRegister] 收到暂停请求：不再派发新任务，等待已开始任务结束");
        }
        return this.getSnapshot();
    }

    forcePause(): RunnerSnapshot {
        if (this.snapshot.status === "running" || this.snapshot.status === "pausing") {
            this.pauseRequested = true;
            this.forcePauseRequested = true;
            this.snapshot.status = "force_pausing";
            this.logger.warn("[FreeRegister] 收到强制暂停请求：立即中止当前任务");
            this.abortController?.abort();
        }
        return this.getSnapshot();
    }

    async wait(): Promise<RunnerSnapshot> {
        return this.promise ?? this.getSnapshot();
    }

    getSnapshot(): RunnerSnapshot {
        this.snapshot.memory = runtimeMemorySnapshot(this.memoryConfig ?? undefined);
        const throughput = computeRunnerThroughput(this.snapshot);
        return {
            ...this.snapshot,
            ...throughput,
            workers: this.snapshot.workers.map(withElapsed),
        };
    }

    private startMemoryMonitor(config: AppConfig): void {
        this.stopMemoryMonitor();
        this.memoryMonitor = setInterval(() => {
            this.checkMemoryGuard(config);
        }, MEMORY_MONITOR_INTERVAL_MS);
        this.memoryMonitor.unref?.();
    }

    private stopMemoryMonitor(): void {
        if (!this.memoryMonitor) return;
        clearInterval(this.memoryMonitor);
        this.memoryMonitor = null;
    }

    private checkMemoryGuard(config: AppConfig): void {
        const memory = runtimeMemorySnapshot(config);
        this.snapshot.memory = memory;
        if (memory.level === "ok") return;

        if (memory.level === "hard" && this.memoryGuardLevel !== "hard") {
            this.memoryGuardLevel = "hard";
            this.pauseRequested = true;
            this.forcePauseRequested = true;
            if (this.snapshot.status === "running" || this.snapshot.status === "pausing") {
                this.snapshot.status = "force_pausing";
            }
            this.logger.error(
                `[FreeRegister] 内存达到硬阈值，强制暂停: used=${memory.guardUsedMb}MB rss=${memory.rssMb}MB heap=${memory.heapUsedMb}/${memory.heapLimitMb}MB limit=${memory.hardLimitMb}MB`,
            );
            this.abortController?.abort();
            return;
        }

        if (memory.level === "soft" && this.memoryGuardLevel === "ok") {
            this.memoryGuardLevel = "soft";
            this.pauseRequested = true;
            if (this.snapshot.status === "running") {
                this.snapshot.status = "pausing";
            }
            this.logger.warn(
                `[FreeRegister] 内存达到软阈值，停止派发新任务并等待当前任务结束: used=${memory.guardUsedMb}MB rss=${memory.rssMb}MB heap=${memory.heapUsedMb}/${memory.heapLimitMb}MB limit=${memory.softLimitMb}MB`,
            );
        }
    }

    private updateWorker(workerId: number, patch: Partial<Omit<WorkerSnapshot, "workerId" | "elapsedMs">>): void {
        const index = workerId - 1;
        const existing = this.snapshot.workers[index] ?? emptyWorkerSnapshot(workerId);
        const next = {
            ...existing,
            ...patch,
            workerId,
            updatedAt: new Date().toISOString(),
        };
        this.snapshot.workers[index] = withElapsed(next);
    }

    private refreshAdaptiveControl(config: AppConfig, baselineGuardUsedMb: number, previousRpsEwma: number): number {
        const memory = runtimeMemorySnapshot(config);
        this.snapshot.memory = memory;
        const pressure = heroSmsPressureSnapshot(config);
        const rpsEwma = previousRpsEwma <= 0
            ? pressure.utilization
            : (previousRpsEwma * (1 - ADAPTIVE_EWMA_ALPHA)) + (pressure.utilization * ADAPTIVE_EWMA_ALPHA);
        const maxConcurrency = estimateAdaptiveMaxConcurrency({
            memory,
            baselineGuardUsedMb,
            currentConcurrency: Math.max(1, this.snapshot.currentConcurrency),
            absoluteMax: ADAPTIVE_ABSOLUTE_MAX_CONCURRENCY,
        });
        const targetUtil = config.run.adaptiveTargetSmsRpsUtilization;
        const decision = computeAdaptiveTargetConcurrency({
            currentConcurrency: this.snapshot.currentConcurrency,
            targetConcurrency: this.snapshot.targetConcurrency || this.snapshot.concurrency || 1,
            maxConcurrency,
            memoryLevel: memory.level,
            rpsEwma,
            targetSmsRpsUtilization: targetUtil,
            pendingTotal: pressure.pendingTotal,
            totalRpsLimit: pressure.totalLimit,
            oldestPendingMs: pressure.oldestPendingMs,
            controlIntervalMs: config.run.adaptiveControlIntervalMs,
        });

        this.snapshot.targetConcurrency = decision.targetConcurrency;
        this.snapshot.maxConcurrency = maxConcurrency;
        this.snapshot.adaptiveReason = decision.reason;
        this.snapshot.adaptiveSmsRps = pressure.totalRps;
        this.snapshot.adaptiveSmsRpsLimit = pressure.totalLimit;
        this.snapshot.adaptiveSmsRpsUtilization = Math.round(rpsEwma * 10000) / 10000;
        this.snapshot.adaptiveTargetSmsRpsUtilization = targetUtil;
        this.snapshot.adaptiveSlotWaiters = pressure.pendingTotal;
        return rpsEwma;
    }

    private async runAdaptiveWorkers(config: AppConfig, runWorkerSafely: WorkerLoop, runState: WorkerRunState): Promise<void> {
        const activeWorkers = new Map<number, Promise<void>>();
        const baselineGuardUsedMb = this.snapshot.memory.guardUsedMb || runtimeMemorySnapshot(config).guardUsedMb;
        const controlIntervalMs = Math.max(1000, config.run.adaptiveControlIntervalMs);
        let nextWorkerId = 0;
        let rpsEwma = 0;
        let nextControlAt = 0;
        let lastReason = "";

        const spawnWorker = (): void => {
            const workerId = nextWorkerId + 1;
            nextWorkerId = workerId;
            this.updateWorker(workerId, {
                status: "idle",
                stage: "idle",
                jobId: 0,
                email: "",
                phone: "",
                latestLog: "自适应 warm-up，等待派发",
            });
            const promise = runWorkerSafely(workerId, true)
                .finally(() => {
                    activeWorkers.delete(workerId);
                    this.snapshot.currentConcurrency = activeWorkers.size;
                });
            activeWorkers.set(workerId, promise);
            this.snapshot.currentConcurrency = activeWorkers.size;
        };

        for (;;) {
            this.checkMemoryGuard(config);
            const now = Date.now();
            if (now >= nextControlAt) {
                const previousTarget = this.snapshot.targetConcurrency;
                rpsEwma = this.refreshAdaptiveControl(config, baselineGuardUsedMb, rpsEwma);
                nextControlAt = now + controlIntervalMs;
                runState.retireRequests = Math.max(0, this.snapshot.currentConcurrency - this.snapshot.targetConcurrency);
                if (this.snapshot.adaptiveReason !== lastReason || this.snapshot.targetConcurrency !== previousTarget) {
                    lastReason = this.snapshot.adaptiveReason;
                    this.logger.info(
                        `[adaptive] target=${this.snapshot.targetConcurrency} current=${this.snapshot.currentConcurrency} max=${this.snapshot.maxConcurrency} sms_rps=${this.snapshot.adaptiveSmsRps}/${this.snapshot.adaptiveSmsRpsLimit} waiters=${this.snapshot.adaptiveSlotWaiters} reason=${this.snapshot.adaptiveReason}`,
                    );
                }
            }

            const noMoreFixedJobs = !config.run.runUntilEmpty && this.snapshot.nextJob > this.snapshot.total;
            const canSpawn =
                !this.pauseRequested &&
                !this.forcePauseRequested &&
                !runState.sourceEmpty &&
                !noMoreFixedJobs &&
                activeWorkers.size < this.snapshot.targetConcurrency;
            if (canSpawn) {
                const spawnCount = Math.min(ADAPTIVE_WARMUP_BATCH, this.snapshot.targetConcurrency - activeWorkers.size);
                for (let index = 0; index < spawnCount; index += 1) {
                    spawnWorker();
                }
            }

            if (activeWorkers.size === 0) {
                if (runState.sourceEmpty || this.pauseRequested || this.forcePauseRequested || noMoreFixedJobs) {
                    break;
                }
                if (this.snapshot.targetConcurrency <= 0) {
                    break;
                }
            }

            await sleepMs(ADAPTIVE_WARMUP_INTERVAL_MS);
        }

        await Promise.all(activeWorkers.values());
        this.snapshot.currentConcurrency = 0;
    }

    private async run(config: AppConfig): Promise<RunnerSnapshot> {
        const pool = new EmailPool(config.emailPool);
        const mode = config.run.runUntilEmpty ? "until-empty" : "fixed-total";
        const totalLabel = config.run.runUntilEmpty ? "until-empty" : String(this.snapshot.total);
        this.logger.info(`[FreeRegister] mode=${mode} total=${totalLabel} concurrency=${this.snapshot.concurrency} proxies=${config.proxies.length}`);
        this.checkMemoryGuard(config);
        this.logger.info(
            `[FreeRegister] memory rss=${this.snapshot.memory.rssMb}MB heap=${this.snapshot.memory.heapUsedMb}/${this.snapshot.memory.heapLimitMb}MB soft=${this.snapshot.memory.softLimitMb}MB hard=${this.snapshot.memory.hardLimitMb}MB`,
        );

        const runState: WorkerRunState = {sourceEmpty: false, retireRequests: 0};

        const worker = async (workerId: number, adaptive: boolean): Promise<void> => {
            for (;;) {
                if (adaptive && runState.sourceEmpty) {
                    this.updateWorker(workerId, {
                        status: "idle",
                        stage: "idle",
                        jobId: 0,
                        email: "",
                        phone: "",
                        latestLog: "邮箱池为空，停止 worker",
                    });
                    return;
                }
                if (this.pauseRequested || this.forcePauseRequested) {
                    this.updateWorker(workerId, {
                        status: this.forcePauseRequested ? "force_paused" : "paused",
                        stage: this.forcePauseRequested ? "force_paused" : "idle",
                        jobId: 0,
                        email: "",
                        phone: "",
                        latestLog: this.forcePauseRequested ? "强制暂停" : "暂停，不再派发新任务",
                    });
                    return;
                }
                this.checkMemoryGuard(config);
                if (this.pauseRequested || this.forcePauseRequested) {
                    continue;
                }
                const jobId = this.snapshot.nextJob;
                if (!config.run.runUntilEmpty && jobId > this.snapshot.total) {
                    this.updateWorker(workerId, {
                        status: "idle",
                        stage: "idle",
                        jobId: 0,
                        email: "",
                        phone: "",
                        latestLog: "没有更多任务",
                    });
                    return;
                }
                this.snapshot.nextJob += 1;

                this.snapshot.activeWorkers += 1;
                try {
                    const result = await runOne(
                        config,
                        pool,
                        jobId,
                        workerId,
                        this.logger,
                        this.abortController?.signal,
                        (patch) => this.updateWorker(workerId, patch),
                    );
                    if (result.forced) {
                        return;
                    }
                    if (result.ok) {
                        this.snapshot.okCount += 1;
                    } else if (result.skipped) {
                        this.snapshot.skippedCount += 1;
                        if (config.run.runUntilEmpty) {
                            runState.sourceEmpty = true;
                            this.updateWorker(workerId, {
                                status: "idle",
                                stage: "idle",
                                jobId: 0,
                                email: "",
                                phone: "",
                                latestLog: "邮箱池为空，停止 worker",
                            });
                            return;
                        }
                    } else {
                        this.snapshot.failedCount += 1;
                    }
                } finally {
                    this.snapshot.activeWorkers = Math.max(0, this.snapshot.activeWorkers - 1);
                }
                if (adaptive && runState.retireRequests > 0 && !this.pauseRequested && !this.forcePauseRequested && !runState.sourceEmpty) {
                    runState.retireRequests = Math.max(0, runState.retireRequests - 1);
                    this.updateWorker(workerId, {
                        status: "idle",
                        stage: "idle",
                        jobId: 0,
                        email: "",
                        phone: "",
                        latestLog: "自适应缩容，完成当前 job 后退出",
                    });
                    return;
                }
            }
        };

        const runWorkerSafely = async (workerId: number, adaptive: boolean): Promise<void> => {
            try {
                await worker(workerId, adaptive);
            } catch (error) {
                if (this.forcePauseRequested && isForcePauseError(error)) {
                    return;
                }
                this.snapshot.failedCount += 1;
                this.updateWorker(workerId, {
                    status: "failed",
                    stage: "failed",
                    latestLog: error instanceof Error ? error.message : String(error),
                    error: error instanceof Error ? error.stack || error.message : String(error),
                });
                this.logger.error(`[worker-${workerId}] 未处理错误: ${error instanceof Error ? error.stack || error.message : String(error)}`);
            }
        };

        if (config.run.concurrencyMode === "adaptive") {
            await this.runAdaptiveWorkers(config, runWorkerSafely, runState);
        } else {
            await Promise.all(Array.from({length: this.snapshot.concurrency}, (_, index) => runWorkerSafely(index + 1, false)));
        }

        this.snapshot.status = this.forcePauseRequested ? "force_paused" : (this.pauseRequested ? "paused" : "completed");
        if (config.run.runUntilEmpty && this.snapshot.status === "completed") {
            this.logger.info("[FreeRegister] 邮箱池已空，持续运行任务结束");
        }
        const statusText = this.snapshot.status === "force_paused" ? "已强制暂停" : (this.snapshot.status === "paused" ? "已暂停" : "完成");
        this.logger.info(`\n[FreeRegister] ${statusText} ok=${this.snapshot.okCount} failed=${this.snapshot.failedCount} skipped=${this.snapshot.skippedCount}`);
        return this.getSnapshot();
    }
}

export async function runRegisterBatch(config: AppConfig, logger: RegisterLogger = DEFAULT_LOGGER): Promise<RunnerSnapshot> {
    const runner = new RegisterTaskRunner(logger);
    runner.start(config);
    return await runner.wait();
}
