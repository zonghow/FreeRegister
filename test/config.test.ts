import assert from "node:assert/strict";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {applyCliOverrides, heroSmsProxyForWorker, loadConfig, parseToml, proxyForWorker} from "../src/config.js";

test("parses required toml shapes", () => {
    const parsed = parseToml(`
[run]
total = 100
concurrency = 10
use_browser_sentinel = true
run_until_empty = true

[proxies]
urls = ["socks5://a", "http://b"]

[hero_sms]
countries = [33, 52]
acquire_priority = "price_high"
min_price = 0.04
max_price = 0.08
price_step = 0.02
auto_release_on_timeout = true
`);

    assert.equal(parsed.run.total, 100);
    assert.equal(parsed.run.concurrency, 10);
    assert.equal(parsed.run.use_browser_sentinel, true);
    assert.equal(parsed.run.run_until_empty, true);
    assert.deepEqual(parsed.proxies.urls, ["socks5://a", "http://b"]);
    assert.deepEqual(parsed.hero_sms.countries, [33, 52]);
    assert.equal(parsed.hero_sms.acquire_priority, "price_high");
    assert.equal(parsed.hero_sms.auto_release_on_timeout, true);
});

test("loads config defaults and applies cli overrides", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "free-register-config-"));
    try {
        const configPath = path.join(dir, "config.toml");
        await writeFile(configPath, `
[run]
total = 2
concurrency = 1
max_phone_tries = 7
run_until_empty = false
memory_soft_limit_mb = 7000
memory_hard_limit_mb = 8000

[openai]
default_password = "pw"
save_auth_json = true

[hero_sms]
api_key = "hero"
use_proxy = true
countries = [33, 52]
acquire_priority = "price_low"
min_price = 0.04
max_price = 0.08
price_step = 0.02
poll_attempts = 1
poll_interval_ms = 3000
max_phone_tries = 9
auto_release_on_timeout = false

[proxies]
urls = ["socks5://one", "socks5://two"]

[cpa_json]
dir = "custom-cpa"

[sentinel_sdk]
url = "https://example.com/sdk.js"
file = "custom-sdk.js"
`);

        const loaded = loadConfig(configPath);
        const overridden = applyCliOverrides(loaded, ["--total", "5", "--concurrency", "3"]);
        const untilEmpty = applyCliOverrides(loaded, ["--run-until-empty"]);

        assert.equal(overridden.run.total, 5);
        assert.equal(overridden.run.concurrency, 3);
        assert.equal(overridden.run.maxPhoneTries, 7);
        assert.equal(overridden.run.memorySoftLimitMb, 7000);
        assert.equal(overridden.run.memoryHardLimitMb, 8000);
        assert.equal(overridden.heroSMS.useProxy, true);
        assert.deepEqual(overridden.heroSMS.countries, [33, 52]);
        assert.equal(overridden.heroSMS.acquirePriority, "price_low");
        assert.equal(overridden.heroSMS.minPrice, 0.04);
        assert.equal(overridden.heroSMS.maxPrice, 0.08);
        assert.equal(overridden.heroSMS.priceStep, 0.02);
        assert.equal(Object.prototype.hasOwnProperty.call(overridden.heroSMS, "pollAttempts"), false);
        assert.equal(overridden.heroSMS.maxPhoneTries, 9);
        assert.equal(overridden.heroSMS.autoReleaseOnTimeout, false);
        assert.equal(untilEmpty.run.runUntilEmpty, true);
        assert.equal(overridden.openai.defaultPassword, "pw");
        assert.equal(overridden.openai.saveAuthJson, true);
        assert.equal(proxyForWorker(overridden, 0), "socks5://one");
        assert.equal(proxyForWorker(overridden, 1), "socks5://two");
        assert.equal(proxyForWorker(overridden, 2), "socks5://one");
        assert.equal(heroSmsProxyForWorker(overridden, 0), "socks5://one");
        assert.equal(heroSmsProxyForWorker({...overridden, heroSMS: {...overridden.heroSMS, useProxy: false}}, 0), "");
        assert.equal(overridden.cpaJson.dir, path.join(dir, "custom-cpa"));
        assert.equal(overridden.sentinelSdk.url, "https://example.com/sdk.js");
        assert.equal(overridden.sentinelSdk.file, "custom-sdk.js");
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test("applies docker-oriented env overrides", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "free-register-config-env-"));
    const previousEnv = {
        FREE_REGISTER_HERO_SMS_API_KEY: process.env.FREE_REGISTER_HERO_SMS_API_KEY,
        FREE_REGISTER_EMAIL_POOL_DIR: process.env.FREE_REGISTER_EMAIL_POOL_DIR,
        FREE_REGISTER_SENTINEL_SDK_FILE: process.env.FREE_REGISTER_SENTINEL_SDK_FILE,
        FREE_REGISTER_DEFAULT_PASSWORD: process.env.FREE_REGISTER_DEFAULT_PASSWORD,
        FREE_REGISTER_SAVE_AUTH_JSON: process.env.FREE_REGISTER_SAVE_AUTH_JSON,
        FREE_REGISTER_RUN_UNTIL_EMPTY: process.env.FREE_REGISTER_RUN_UNTIL_EMPTY,
        FREE_REGISTER_CPA_JSON_DIR: process.env.FREE_REGISTER_CPA_JSON_DIR,
    };

    function restoreEnv(): void {
        for (const [key, value] of Object.entries(previousEnv)) {
            if (value == null) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }

    try {
        const configPath = path.join(dir, "config.toml");
        const poolDir = path.join(dir, "pool");
        await writeFile(configPath, `
[hero_sms]
api_key = "from-file"

[proxies]
urls = ["socks5://from-file"]
`);

        process.env.FREE_REGISTER_HERO_SMS_API_KEY = "from-env";
        process.env.FREE_REGISTER_EMAIL_POOL_DIR = poolDir;
        process.env.FREE_REGISTER_SENTINEL_SDK_FILE = "/data/sdk.js";
        process.env.FREE_REGISTER_DEFAULT_PASSWORD = "env-password";
        process.env.FREE_REGISTER_SAVE_AUTH_JSON = "true";
        process.env.FREE_REGISTER_RUN_UNTIL_EMPTY = "true";
        process.env.FREE_REGISTER_CPA_JSON_DIR = "/data/cpa_json";

        const loaded = loadConfig(configPath);

        assert.deepEqual(loaded.proxies, ["socks5://from-file"]);
        assert.equal(loaded.heroSMS.apiKey, "from-env");
        assert.equal(loaded.openai.defaultPassword, "env-password");
        assert.equal(loaded.openai.saveAuthJson, true);
        assert.equal(loaded.run.runUntilEmpty, true);
        assert.equal(loaded.defaultPassword, "env-password");
        assert.equal(loaded.cpaJson.dir, "/data/cpa_json");
        assert.equal(loaded.sentinelSdk.file, "/data/sdk.js");
        assert.equal(loaded.emailPool.source, path.join(poolDir, "email.txt"));
        assert.equal(loaded.emailPool.lock, path.join(poolDir, ".email.lock"));
    } finally {
        restoreEnv();
        await rm(dir, {recursive: true, force: true});
    }
});

test("loads legacy hero sms country and price tiers", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "free-register-config-legacy-"));
    try {
        const configPath = path.join(dir, "config.toml");
        await writeFile(configPath, `
[run]
max_phone_tries = 6

[hero_sms]
country = 52
price_tiers = [0.03, 0.05]
max_price = 0.08
`);

        const loaded = loadConfig(configPath);

        assert.deepEqual(loaded.heroSMS.countries, [52]);
        assert.equal(loaded.heroSMS.minPrice, 0.03);
        assert.equal(loaded.heroSMS.maxPrice, 0.08);
        assert.equal(loaded.heroSMS.maxPhoneTries, 6);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});
