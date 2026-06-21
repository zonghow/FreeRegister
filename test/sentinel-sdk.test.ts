import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {SENTINEL_SDK_PATCH_HOOK, validateSentinelSdkSource} from "../src/sentinel-sdk.js";

test("current sdk.js contains the VM patch hook", async () => {
    const source = await readFile(path.resolve(process.cwd(), "sdk.js"), "utf8");
    assert.doesNotThrow(() => validateSentinelSdkSource(source));
    assert.ok(source.includes(SENTINEL_SDK_PATCH_HOOK));
});

test("rejects incompatible sdk source", () => {
    assert.throws(() => validateSentinelSdkSource("var SentinelSDK = {};"), /patch hook/);
});
