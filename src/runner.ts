import {proxyForWorker, redactProxy, type AppConfig} from "./config.js";
import {EmailPool, type EmailLease} from "./email-pool.js";
import {generateRandomDeviceProfile} from "./device-profile.js";
import {createHotmailProvider} from "./mail/hotmail.js";
import {OpenAIClient} from "./openai.js";
import {createSMSBroker} from "./sms/index.js";

export interface JobResult {
    ok: boolean;
    skipped?: boolean;
}

export interface RegisterLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

export type RunnerStatus = "idle" | "running" | "pausing" | "paused" | "completed" | "failed";

export interface RunnerSnapshot {
    status: RunnerStatus;
    total: number;
    concurrency: number;
    runUntilEmpty: boolean;
    nextJob: number;
    activeWorkers: number;
    okCount: number;
    failedCount: number;
    skippedCount: number;
    startedAt: string;
    endedAt: string;
    lastError: string;
}

const DEFAULT_LOGGER: RegisterLogger = {
    info: (message) => console.log(message),
    warn: (message) => console.warn(message),
    error: (message) => console.error(message),
};

function emptySnapshot(): RunnerSnapshot {
    return {
        status: "idle",
        total: 0,
        concurrency: 0,
        runUntilEmpty: false,
        nextJob: 1,
        activeWorkers: 0,
        okCount: 0,
        failedCount: 0,
        skippedCount: 0,
        startedAt: "",
        endedAt: "",
        lastError: "",
    };
}

function createBroker(config: AppConfig) {
    const hero = config.heroSMS;
    if (!hero.apiKey) {
        throw new Error("缺少 [hero_sms].api_key");
    }
    return createSMSBroker({
        apiKey: hero.apiKey,
        pollAttempts: hero.pollAttempts,
        pollIntervalMs: hero.pollIntervalMs,
        maxPrice: hero.maxPrice,
        country: hero.country,
        countries: hero.countries,
        priceTiers: hero.priceTiers,
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
): Promise<{phone: string}> {
    const smsBroker = createBroker(config);
    let lastErr: unknown = null;

    for (let phoneTry = 1; phoneTry <= config.run.maxPhoneTries; phoneTry += 1) {
        logger.info(`\n[worker-${workerId}] [phone] (${phoneTry}/${config.run.maxPhoneTries}) 取号...`);
        const lease = await smsBroker.getActivation();
        const phoneNumber = `+${lease.phoneNumber}`;
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
        });

        try {
            await signupClient.authPhoneSignupHTTP(phoneNumber, async () => {
                logger.info(`[worker-${workerId}] [phone] 等待 OTP...`);
                const {code} = await lease.waitForVerificationCode();
                logger.info(`[worker-${workerId}] [phone] 收到 OTP: ${code}`);
                return code;
            });
            logger.info(`[worker-${workerId}] [phone] 注册成功 ${phoneNumber}`);
            return {phone: phoneNumber};
        } catch (error) {
            lastErr = error;
            logger.warn(`[worker-${workerId}] [phone] (${phoneTry}/${config.run.maxPhoneTries}) 失败: ${(error as Error).message}`);
            try {
                await smsBroker.markAsFailed(true);
            } catch {
                // 忽略接码平台回收失败，继续换号。
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
): Promise<void> {
    const hotmailProvider = createHotmailProvider({lease, pool, proxyUrl});
    const bindEmail = await hotmailProvider.getEmailAddress();
    logger.info(`[worker-${workerId}] [oauth] 绑定邮箱候选: ${bindEmail}`);

    const oauthClient = new OpenAIClient({
        email: phone,
        password: config.openai.defaultPassword,
        deviceProfile: generateRandomDeviceProfile(),
        manualMode: false,
        bindEmail,
        fetchAddEmailOtp: async () => {
            const startedAt = Date.now();
            logger.info(`[worker-${workerId}] [email] 等待 OTP for ${bindEmail} (after=${new Date(startedAt).toISOString()})`);
            return await hotmailProvider.getEmailVerificationCode(bindEmail, {minTimestampMs: startedAt});
        },
        proxyUrl,
        useBrowserSentinel: config.run.useBrowserSentinel,
        sentinelBrowserPath: config.sentinelBrowser.path,
        saveAuthJson: true,
        authJsonDir: config.cpaJson.dir,
    });

    const authResult = await oauthClient.authLoginHTTP();
    logger.info(`[worker-${workerId}] [oauth] 完成 phone=${phone} email=${bindEmail} cpa_json=${authResult.authFile || "not-saved"}`);
}

export async function runOne(
    config: AppConfig,
    pool: EmailPool,
    jobId: number,
    workerId: number,
    logger: RegisterLogger = DEFAULT_LOGGER,
): Promise<JobResult> {
    const proxyUrl = proxyForWorker(config, workerId - 1);
    const totalLabel = config.run.runUntilEmpty ? "until-empty" : String(config.run.total);
    logger.info(`\n========== [job ${jobId}/${totalLabel}] worker=${workerId} proxy=${redactProxy(proxyUrl)} ==========`);

    const emailLease = await pool.leaseEmail();
    if (!emailLease) {
        logger.warn(`[worker-${workerId}] 邮箱池为空，跳过 job=${jobId}`);
        return {ok: false, skipped: true};
    }
    logger.info(`[worker-${workerId}] [email] 已租约 ${emailLease.email}`);

    let phone = "";
    try {
        const signup = await phoneSignup(config, proxyUrl, workerId, logger);
        phone = signup.phone;
    } catch (error) {
        logger.warn(`[worker-${workerId}] [phone] 注册失败，邮箱放回池: ${(error as Error).message}`);
        await pool.returnToSource(emailLease);
        return {ok: false};
    }

    try {
        await bindEmailViaOAuth(config, pool, emailLease, phone, proxyUrl, workerId, logger);
        await pool.markSuccess(emailLease);
        logger.info(`[worker-${workerId}] [success] phone=${phone} email=${emailLease.email}`);
        logger.info(`[POOL-RESULT] status=ok phone=${phone} email=${emailLease.email}`);
        return {ok: true};
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = isEmailTouchedError(error) ? message : `oauth_uncertain: ${message}`;
        logger.warn(`[worker-${workerId}] [failed] email=${emailLease.email} reason=${reason}`);
        await pool.markFailed(emailLease, reason);
        logger.info(`[POOL-RESULT] status=failed phone=${phone} email=${emailLease.email}`);
        return {ok: false};
    }
}

export class RegisterTaskRunner {
    private snapshot = emptySnapshot();
    private pauseRequested = false;
    private promise: Promise<RunnerSnapshot> | null = null;

    constructor(private readonly logger: RegisterLogger = DEFAULT_LOGGER) {}

    start(config: AppConfig): RunnerSnapshot {
        if (this.snapshot.status === "running" || this.snapshot.status === "pausing") {
            throw new Error("任务正在运行");
        }

        const total = config.run.runUntilEmpty ? 0 : config.run.total;
        const concurrency = config.run.runUntilEmpty
            ? config.run.concurrency
            : Math.min(config.run.concurrency, total);
        this.pauseRequested = false;
        this.snapshot = {
            ...emptySnapshot(),
            status: "running",
            total,
            concurrency,
            runUntilEmpty: config.run.runUntilEmpty,
            startedAt: new Date().toISOString(),
        };

        this.promise = this.run(config)
            .catch((error) => {
                this.snapshot.status = "failed";
                this.snapshot.lastError = error instanceof Error ? error.stack || error.message : String(error);
                this.logger.error(`[FreeRegister] 致命错误: ${this.snapshot.lastError}`);
                return this.snapshot;
            })
            .finally(() => {
                this.snapshot.endedAt = new Date().toISOString();
                this.snapshot.activeWorkers = 0;
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

    async wait(): Promise<RunnerSnapshot> {
        return this.promise ?? this.getSnapshot();
    }

    getSnapshot(): RunnerSnapshot {
        return {...this.snapshot};
    }

    private async run(config: AppConfig): Promise<RunnerSnapshot> {
        const pool = new EmailPool(config.emailPool);
        const mode = config.run.runUntilEmpty ? "until-empty" : "fixed-total";
        const totalLabel = config.run.runUntilEmpty ? "until-empty" : String(this.snapshot.total);
        this.logger.info(`[FreeRegister] mode=${mode} total=${totalLabel} concurrency=${this.snapshot.concurrency} proxies=${config.proxies.length}`);

        async function noop(): Promise<void> {}

        const worker = async (workerId: number): Promise<void> => {
            for (;;) {
                if (this.pauseRequested) {
                    return;
                }
                const jobId = this.snapshot.nextJob;
                if (!config.run.runUntilEmpty && jobId > this.snapshot.total) {
                    return;
                }
                this.snapshot.nextJob += 1;

                this.snapshot.activeWorkers += 1;
                try {
                    const result = await runOne(config, pool, jobId, workerId, this.logger);
                    if (result.ok) {
                        this.snapshot.okCount += 1;
                    } else if (result.skipped) {
                        this.snapshot.skippedCount += 1;
                        if (config.run.runUntilEmpty) {
                            return;
                        }
                    } else {
                        this.snapshot.failedCount += 1;
                    }
                } finally {
                    this.snapshot.activeWorkers = Math.max(0, this.snapshot.activeWorkers - 1);
                }
            }
        };

        await Promise.all(Array.from({length: this.snapshot.concurrency}, (_, index) => worker(index + 1).catch(async (error) => {
            this.snapshot.failedCount += 1;
            this.logger.error(`[worker-${index + 1}] 未处理错误: ${error instanceof Error ? error.stack || error.message : String(error)}`);
            await noop();
        })));

        this.snapshot.status = this.pauseRequested ? "paused" : "completed";
        if (config.run.runUntilEmpty && this.snapshot.status === "completed") {
            this.logger.info("[FreeRegister] 邮箱池已空，持续运行任务结束");
        }
        this.logger.info(`\n[FreeRegister] ${this.snapshot.status === "paused" ? "已暂停" : "完成"} ok=${this.snapshot.okCount} failed=${this.snapshot.failedCount} skipped=${this.snapshot.skippedCount}`);
        return this.getSnapshot();
    }
}

export async function runRegisterBatch(config: AppConfig, logger: RegisterLogger = DEFAULT_LOGGER): Promise<RunnerSnapshot> {
    const runner = new RegisterTaskRunner(logger);
    runner.start(config);
    return await runner.wait();
}
