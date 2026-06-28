import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {AppConfig} from "../src/config.js";
import {
    computeAdaptiveTargetConcurrency,
    computeRunnerThroughput,
    estimateAdaptiveMaxConcurrency,
    estimateAdaptiveSmsRpsConcurrencyCap,
    filterVisibleWorkerSnapshots,
    RegisterTaskRunner,
    shouldStopPhoneRetryForPause,
    type RunnerStatus,
    type WorkerSnapshot,
} from "../src/runner.js";

function snapshot(status: RunnerStatus, startedAt: string, endedAt: string, okCount: number) {
    return {status, startedAt, endedAt, okCount};
}

function testConfig(dir: string): AppConfig {
    return {
        run: {
            total: 100,
            concurrency: 5,
            concurrencyMode: "fixed",
            maxPhoneTries: 20,
            useBrowserSentinel: false,
            runUntilEmpty: false,
            successAfterEmailOtp: false,
            adaptiveTargetSmsRpsUtilization: 0.9,
            adaptiveControlIntervalMs: 1000,
            memorySoftLimitMb: 0,
            memoryHardLimitMb: 0,
        },
        openai: {
            defaultPassword: "pw",
            saveAuthJson: false,
        },
        heroSMS: {
            apiKey: "test-key",
            apiKeys: ["test-key"],
            apiKeyStrategy: "round_robin",
            rpsLimit: 40,
            proxyStrategy: "direct",
            proxyUrls: [],
            useProxy: false,
            countries: [33],
            acquirePriority: "country",
            minPrice: 0.03,
            maxPrice: 0.05,
            priceStep: 0.01,
            pollIntervalMs: 3000,
            maxPhoneTries: 20,
            autoReleaseOnTimeout: true,
        },
        emailPool: {
            source: path.join(dir, "email.txt"),
            success: path.join(dir, "email.success.txt"),
            inflight: path.join(dir, "email.inflight.txt"),
            failed: path.join(dir, "email.failed.txt"),
            lock: path.join(dir, ".email.lock"),
        },
        cpaJson: {
            dir: path.join(dir, "cpa_json"),
        },
        cost: {
            emailUnitCost: 0.01,
            currency: "USD",
            successLedger: path.join(dir, "cost.success.jsonl"),
            lock: path.join(dir, ".cost.lock"),
        },
        proxy: {
            mode: "pool",
            urls: [],
            phoneCountryTemplate: "",
            countryCodeUrl: "",
            countryCodeCache: path.join(dir, "country_code.json"),
        },
        proxies: [],
        sentinelBrowser: {
            path: "",
        },
        sentinelSdk: {
            url: "",
            file: path.join(dir, "sdk.js"),
        },
        defaultProxyUrl: "",
        defaultPassword: "pw",
    };
}

test("runner throughput uses current time while task is active", () => {
    const startedAt = "2026-06-23T00:00:00.000Z";
    const nowMs = Date.parse("2026-06-23T00:00:10.000Z");

    assert.deepEqual(
        computeRunnerThroughput(snapshot("running", startedAt, "", 2), nowMs),
        {activeRunElapsedMs: 10_000, avgSuccessIntervalMs: 5_000},
    );
    assert.deepEqual(
        computeRunnerThroughput(snapshot("pausing", startedAt, "2026-06-23T00:00:05.000Z", 4), nowMs),
        {activeRunElapsedMs: 10_000, avgSuccessIntervalMs: 2_500},
    );
});

test("runner throughput freezes after task stops", () => {
    const startedAt = "2026-06-23T00:00:00.000Z";
    const endedAt = "2026-06-23T00:01:00.000Z";
    const laterMs = Date.parse("2026-06-23T00:10:00.000Z");

    for (const status of ["completed", "paused", "force_paused", "failed"] as RunnerStatus[]) {
        assert.deepEqual(
            computeRunnerThroughput(snapshot(status, startedAt, endedAt, 3), laterMs),
            {activeRunElapsedMs: 60_000, avgSuccessIntervalMs: 20_000},
        );
    }
});

test("runner throughput handles empty and zero-success snapshots", () => {
    const nowMs = Date.parse("2026-06-23T00:00:10.000Z");

    assert.deepEqual(
        computeRunnerThroughput(snapshot("idle", "", "", 0), nowMs),
        {activeRunElapsedMs: 0, avgSuccessIntervalMs: 0},
    );
    assert.deepEqual(
        computeRunnerThroughput(snapshot("running", "2026-06-23T00:00:00.000Z", "", 0), nowMs),
        {activeRunElapsedMs: 10_000, avgSuccessIntervalMs: 0},
    );
});

test("adaptive max concurrency is estimated from memory headroom", () => {
    assert.equal(
        estimateAdaptiveMaxConcurrency({
            memory: {guardUsedMb: 200, softLimitMb: 1000, hardLimitMb: 1200},
            baselineGuardUsedMb: 100,
            currentConcurrency: 10,
            absoluteMax: 1000,
        }),
        56,
    );
    assert.equal(
        estimateAdaptiveMaxConcurrency({
            memory: {guardUsedMb: 900, softLimitMb: 1000, hardLimitMb: 1200},
            baselineGuardUsedMb: 100,
            currentConcurrency: 10,
            absoluteMax: 20,
        }),
        11,
    );
});

test("adaptive target scales up when HeroSMS utilization is low", () => {
    assert.deepEqual(
        computeAdaptiveTargetConcurrency({
            currentConcurrency: 10,
            targetConcurrency: 10,
            maxConcurrency: 100,
            memoryLevel: "ok",
            rpsEwma: 0.2,
            targetSmsRpsUtilization: 0.9,
            pendingTotal: 0,
            totalRpsLimit: 80,
            oldestPendingMs: 0,
            controlIntervalMs: 5000,
        }),
        {targetConcurrency: 12, reason: "rps_low_scale_up"},
    );
});

test("adaptive max concurrency is capped by HeroSMS account RPS", () => {
    assert.equal(
        estimateAdaptiveSmsRpsConcurrencyCap({
            configuredConcurrency: 10,
            totalRpsLimit: 80,
            targetSmsRpsUtilization: 0.8,
        }),
        64,
    );
    assert.equal(
        estimateAdaptiveSmsRpsConcurrencyCap({
            configuredConcurrency: 100,
            totalRpsLimit: 80,
            targetSmsRpsUtilization: 0.8,
        }),
        100,
    );
    assert.equal(
        estimateAdaptiveSmsRpsConcurrencyCap({
            configuredConcurrency: 25,
            totalRpsLimit: 0,
            targetSmsRpsUtilization: 0.8,
        }),
        25,
    );
});

test("adaptive target drains on slot backpressure and memory pressure", () => {
    assert.deepEqual(
        computeAdaptiveTargetConcurrency({
            currentConcurrency: 50,
            targetConcurrency: 50,
            maxConcurrency: 100,
            memoryLevel: "ok",
            rpsEwma: 0.7,
            targetSmsRpsUtilization: 0.9,
            pendingTotal: 30,
            totalRpsLimit: 80,
            oldestPendingMs: 500,
            controlIntervalMs: 5000,
        }),
        {targetConcurrency: 40, reason: "slot_wait_backpressure"},
    );
    assert.deepEqual(
        computeAdaptiveTargetConcurrency({
            currentConcurrency: 50,
            targetConcurrency: 50,
            maxConcurrency: 100,
            memoryLevel: "soft",
            rpsEwma: 0.2,
            targetSmsRpsUtilization: 0.9,
            pendingTotal: 0,
            totalRpsLimit: 80,
            oldestPendingMs: 0,
            controlIntervalMs: 5000,
        }),
        {targetConcurrency: 40, reason: "memory_high_drain"},
    );
});

function worker(workerId: number, status: WorkerSnapshot["status"], latestLog = ""): WorkerSnapshot {
    return {
        workerId,
        status,
        stage: status === "running" ? "phone_acquire" : "idle",
        jobId: workerId,
        email: "",
        phone: "",
        proxy: "",
        startedAt: "",
        updatedAt: "",
        elapsedMs: 0,
        latestLog,
        error: "",
    };
}

test("adaptive worker snapshots only show live workers", () => {
    const workers = [
        worker(401, "idle", "自适应缩容，完成当前 job 后退出"),
        worker(402, "running", "等待手机 OTP"),
        worker(403, "idle", "自适应缩容，完成当前 job 后退出"),
    ];

    assert.deepEqual(
        filterVisibleWorkerSnapshots(workers, "adaptive", new Set([402])).map((item) => item.workerId),
        [402],
    );
    assert.deepEqual(
        filterVisibleWorkerSnapshots(workers, "fixed").map((item) => item.workerId),
        [401, 402, 403],
    );
});

test("normal pause stops phone retry without taking the force-pause path", () => {
    assert.equal(shouldStopPhoneRetryForPause(false), false);
    assert.equal(shouldStopPhoneRetryForPause(true), true);
    assert.equal(shouldStopPhoneRetryForPause(true, AbortSignal.abort()), false);
});

test("force pause immediately makes the runner terminal", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "free-register-force-pause-"));
    const logs: string[] = [];
    const runner = new RegisterTaskRunner({
        info: (message) => logs.push(message),
        warn: (message) => logs.push(message),
        error: (message) => logs.push(message),
    });

    try {
        runner.start(testConfig(dir));
        const snapshot = runner.forcePause();

        assert.equal(snapshot.status, "force_paused");
        assert.equal(snapshot.activeWorkers, 0);
        assert.equal(snapshot.currentConcurrency, 0);
        assert.deepEqual(snapshot.workers, []);

        const waited = await runner.wait();
        assert.equal(waited.status, "force_paused");
        assert.equal(waited.activeWorkers, 0);
        assert.equal(waited.currentConcurrency, 0);
        assert.deepEqual(waited.workers, []);
    } finally {
        await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 50});
    }
});
