import assert from "node:assert/strict";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {CostConfig} from "../src/config.js";
import {
    appendSuccessCostRecord,
    removeSuccessCostRecords,
    successCostLinesForEmails,
    summarizeSuccessCosts,
} from "../src/cost.js";

function configForDir(dir: string): CostConfig {
    return {
        emailUnitCost: 0.05,
        currency: "USD",
        successLedger: path.join(dir, "cost.success.jsonl"),
        lock: path.join(dir, ".cost.lock"),
    };
}

function fakeLine(email: string): string {
    return `${email}----password----clientId----refreshToken`;
}

test("success cost ledger appends and summarizes current success pool", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "free-register-cost-"));
    try {
        const config = configForDir(dir);
        await appendSuccessCostRecord(config, {
            email: "a@example.com",
            phone: "+1001",
            emailCost: 0.05,
            smsGrossCost: 0.75,
            smsRefundCost: 0.3,
            time: "2026-06-22T00:00:00.000Z",
        });
        await appendSuccessCostRecord(config, {
            email: "b@example.com",
            phone: "+1002",
            emailCost: 0.05,
            smsCost: 0.25,
            time: "2026-06-22T00:00:01.000Z",
        });

        const summary = await summarizeSuccessCosts(config, [
            fakeLine("a@example.com"),
            fakeLine("b@example.com"),
            fakeLine("legacy@example.com"),
        ]);

        assert.equal(summary.count, 3);
        assert.equal(summary.ledgerCount, 2);
        assert.equal(summary.estimatedCount, 1);
        assert.equal(summary.emailTotal, 0.15);
        assert.equal(summary.smsGrossTotal, 1);
        assert.equal(summary.smsRefundTotal, 0.3);
        assert.equal(summary.smsTotal, 0.7);
        assert.equal(summary.total, 0.85);
        assert.equal(summary.average, 0.283333);
        assert.equal(summary.currency, "USD");
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test("success cost records can be exported and removed by email", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "free-register-cost-remove-"));
    try {
        const config = configForDir(dir);
        await Promise.all([
            appendSuccessCostRecord(config, {email: "a@example.com", phone: "+1001", smsCost: 0.45}),
            appendSuccessCostRecord(config, {email: "b@example.com", phone: "+1002", smsCost: 0.5}),
        ]);

        const exported = await successCostLinesForEmails(config, ["b@example.com"]);
        assert.equal(exported.length, 1);
        assert.match(exported[0] ?? "", /"email":"b@example.com"/);

        assert.deepEqual(await removeSuccessCostRecords(config, ["b@example.com"]), {removed: 1});
        const remainingRaw = await readFile(config.successLedger, "utf8");
        assert.match(remainingRaw, /"email":"a@example.com"/);
        assert.doesNotMatch(remainingRaw, /"email":"b@example.com"/);

        const summary = await summarizeSuccessCosts(config, [
            fakeLine("a@example.com"),
            fakeLine("b@example.com"),
        ]);
        assert.equal(summary.ledgerCount, 1);
        assert.equal(summary.estimatedCount, 1);
        assert.equal(summary.emailTotal, 0.1);
        assert.equal(summary.smsGrossTotal, 0.45);
        assert.equal(summary.smsRefundTotal, 0);
        assert.equal(summary.smsTotal, 0.45);
        assert.equal(summary.total, 0.55);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});
