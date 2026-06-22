import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {EmailPool, emailFromLine} from "../src/email-pool.js";

async function makeTempPool() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "free-register-pool-"));
    const pool = new EmailPool({
        source: "email.txt",
        success: "email.success.txt",
        inflight: "email.inflight.txt",
        failed: "email.failed.txt",
        lock: ".email.lock",
    }, dir);
    return {dir, pool};
}

function fakeLine(index: number): string {
    return `user${index}@outlook.com----pw${index}----client${index}----refresh${index}`;
}

async function lines(filePath: string): Promise<string[]> {
    try {
        const raw = await readFile(filePath, "utf8");
        return raw.split(/\r?\n/).filter(Boolean).filter((line) => !line.startsWith("#"));
    } catch {
        return [];
    }
}

test("leases unique emails under concurrency", async () => {
    const {dir, pool} = await makeTempPool();
    try {
        await writeFile(path.join(dir, "email.txt"), Array.from({length: 100}, (_, index) => fakeLine(index)).join("\n") + "\n");
        const leases = await Promise.all(Array.from({length: 50}, () => pool.leaseEmail()));
        const emails = leases.map((lease) => lease?.email).filter(Boolean);

        assert.equal(emails.length, 50);
        assert.equal(new Set(emails).size, 50);
        assert.equal((await lines(path.join(dir, "email.txt"))).length, 50);
        assert.equal((await lines(path.join(dir, "email.inflight.txt"))).length, 50);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test("success moves the updated full credential line", async () => {
    const {dir, pool} = await makeTempPool();
    try {
        await writeFile(path.join(dir, "email.txt"), fakeLine(1) + "\n");
        const lease = await pool.leaseEmail();
        assert.ok(lease);

        const updated = "user1@outlook.com----pw1----client1----refresh-updated";
        await pool.updateLeaseLine(lease.email, updated);
        await pool.markSuccess(lease);

        assert.deepEqual(await lines(path.join(dir, "email.txt")), []);
        assert.deepEqual(await lines(path.join(dir, "email.inflight.txt")), []);
        assert.deepEqual(await lines(path.join(dir, "email.success.txt")), [updated]);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test("phone-stage failure returns lease to source", async () => {
    const {dir, pool} = await makeTempPool();
    try {
        const original = fakeLine(2);
        await writeFile(path.join(dir, "email.txt"), original + "\n");
        const lease = await pool.leaseEmail();
        assert.ok(lease);

        await pool.returnToSource(lease);

        assert.equal(emailFromLine((await lines(path.join(dir, "email.txt")))[0]), "user2@outlook.com");
        assert.deepEqual(await lines(path.join(dir, "email.inflight.txt")), []);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test("post-oauth uncertainty moves lease to failed once", async () => {
    const {dir, pool} = await makeTempPool();
    try {
        await writeFile(path.join(dir, "email.txt"), fakeLine(3) + "\n");
        const lease = await pool.leaseEmail();
        assert.ok(lease);

        await pool.markFailed(lease, "oauth_uncertain");
        await pool.markFailed(lease, "oauth_uncertain duplicate");

        assert.deepEqual(await lines(path.join(dir, "email.txt")), []);
        assert.deepEqual(await lines(path.join(dir, "email.inflight.txt")), []);
        assert.equal((await lines(path.join(dir, "email.failed.txt"))).length, 1);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test("returns all orphan inflight emails to source", async () => {
    const {dir, pool} = await makeTempPool();
    try {
        await writeFile(path.join(dir, "email.txt"), fakeLine(10) + "\n");
        await writeFile(path.join(dir, "email.inflight.txt"), fakeLine(1) + "\n" + fakeLine(2) + "\n");

        const result = await pool.returnInflightToSource();

        assert.deepEqual(result, {returned: 2});
        assert.deepEqual(await lines(path.join(dir, "email.txt")), [fakeLine(1), fakeLine(2), fakeLine(10)]);
        assert.deepEqual(await lines(path.join(dir, "email.inflight.txt")), []);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test("marks all orphan inflight emails as failed", async () => {
    const {dir, pool} = await makeTempPool();
    try {
        await writeFile(path.join(dir, "email.txt"), fakeLine(10) + "\n");
        await writeFile(path.join(dir, "email.inflight.txt"), fakeLine(1) + "\n" + fakeLine(2) + "\n");
        await writeFile(path.join(dir, "email.failed.txt"), "# old failure\n" + fakeLine(2) + "\n");

        const result = await pool.markInflightFailed("admin test");

        assert.deepEqual(result, {failed: 1, cleared: 2});
        assert.deepEqual(await lines(path.join(dir, "email.txt")), [fakeLine(10)]);
        assert.deepEqual(await lines(path.join(dir, "email.inflight.txt")), []);
        assert.deepEqual(await lines(path.join(dir, "email.failed.txt")), [fakeLine(2), fakeLine(1)]);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test("imports unique valid emails to source", async () => {
    const {dir, pool} = await makeTempPool();
    try {
        await writeFile(path.join(dir, "email.txt"), fakeLine(1) + "\n");

        const result = await pool.importToSource([
            fakeLine(1),
            fakeLine(2),
            "not-an-email",
            fakeLine(2),
        ].join("\n"));

        assert.deepEqual(result, {total: 4, imported: 1, duplicate: 2, invalid: 1});
        assert.deepEqual(await lines(path.join(dir, "email.txt")), [fakeLine(1), fakeLine(2)]);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test("exports and clears success lines", async () => {
    const {dir, pool} = await makeTempPool();
    try {
        await writeFile(path.join(dir, "email.success.txt"), fakeLine(1) + "\n" + fakeLine(2) + "\n");

        const exported = await pool.exportAndClearSuccess();

        assert.equal(exported, fakeLine(1) + "\n" + fakeLine(2) + "\n");
        assert.deepEqual(await lines(path.join(dir, "email.success.txt")), []);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test("clears only selected success emails", async () => {
    const {dir, pool} = await makeTempPool();
    try {
        await writeFile(path.join(dir, "email.success.txt"), fakeLine(1) + "\n" + fakeLine(2) + "\n");

        assert.deepEqual(await pool.successLines(), [fakeLine(1), fakeLine(2)]);
        await pool.clearSuccessEmails(["user1@outlook.com"]);

        assert.deepEqual(await lines(path.join(dir, "email.success.txt")), [fakeLine(2)]);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});
