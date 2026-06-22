import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function adminSource(): Promise<string> {
    return readFile(path.resolve(process.cwd(), "src/admin-server.ts"), "utf8");
}

test("sms config UI hides advanced HeroSMS fields", async () => {
    const source = await adminSource();

    assert.match(source, /id="smsApiKeyStrategy"/);
    assert.doesNotMatch(source, /id="smsApiKey"/);
    assert.doesNotMatch(source, /id="smsProxyUrls"/);
    assert.doesNotMatch(source, /id="smsPollIntervalMs"/);
    assert.doesNotMatch(source, /id="smsPollAttempts"/);
    assert.doesNotMatch(source, /id="smsAutoRelease"/);
    assert.doesNotMatch(source, /HeroSMS API Key/);
    assert.doesNotMatch(source, /HeroSMS 专用代理/);
    assert.doesNotMatch(source, /轮询间隔 ms/);
    assert.doesNotMatch(source, /最多轮询/);
    assert.doesNotMatch(source, /超时处理/);
});

test("sms config save payload preserves hidden config fields", async () => {
    const source = await adminSource();
    const payloadStart = source.indexOf("function smsPayloadFromForm()");
    const payloadEnd = source.indexOf("function openImportModal()", payloadStart);
    const payloadSource = source.slice(payloadStart, payloadEnd);
    const valuesStart = source.indexOf("const values = {", source.indexOf("pathname === \"/api/sms-config\" && req.method === \"PUT\""));
    const valuesEnd = source.indexOf("};", valuesStart);
    const valuesSource = source.slice(valuesStart, valuesEnd);

    for (const hiddenField of ["apiKey", "proxyUrls", "pollIntervalMs", "autoReleaseOnTimeout"]) {
        assert.doesNotMatch(payloadSource, new RegExp(`${hiddenField}\\s*:`));
    }
    assert.match(payloadSource, /apiKeyStrategy\s*:/);
    assert.match(valuesSource, /api_key_strategy\s*:/);
    for (const hiddenTomlKey of ["api_key", "api_keys", "rps_limit", "proxy_urls", "poll_interval_ms", "auto_release_on_timeout"]) {
        assert.doesNotMatch(valuesSource, new RegExp(`${hiddenTomlKey}\\s*:`));
    }
});
