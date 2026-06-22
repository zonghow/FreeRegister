import assert from "node:assert/strict";
import test from "node:test";
import {
    computeAdaptiveTargetConcurrency,
    computeRunnerThroughput,
    estimateAdaptiveMaxConcurrency,
    filterVisibleWorkerSnapshots,
    type RunnerStatus,
    type WorkerSnapshot,
} from "../src/runner.js";

function snapshot(status: RunnerStatus, startedAt: string, endedAt: string, okCount: number) {
    return {status, startedAt, endedAt, okCount};
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
