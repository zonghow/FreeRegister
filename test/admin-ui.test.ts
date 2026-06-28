import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function adminSource(): Promise<string> {
    return readFile(path.resolve(process.cwd(), "src/admin-server.ts"), "utf8");
}

test("sms config UI hides advanced HeroSMS fields", async () => {
    const source = await adminSource();

    assert.match(source, /<span>待使用<\/span><button id="openImportModalBtn" type="button" class="secondary">导入<\/button>/);
    assert.match(source, /<h2>任务<\/h2>/);
    assert.doesNotMatch(source, /<h2>任务与邮箱<\/h2>/);
    assert.doesNotMatch(source, />导入邮箱<\/button>/);
    assert.match(source, /header \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\)/);
    assert.match(source, /\.runner-status-main \{[^}]*justify-self: center;[^}]*font-size: 15px/);
    assert.match(source, /<span id="runnerStatus" class="status runner-status-main">idle<\/span>/);
    assert.match(source, /class="row header-actions"/);
    assert.match(source, /id="successCostMeta"/);
    assert.match(source, /id="successRunMeta"/);
    assert.match(source, /<span>成功<\/span><button id="exportBtn" type="button" class="secondary">导出<\/button>/);
    assert.doesNotMatch(source, /导出成功邮箱与 CPA JSON/);
    assert.match(source, /#successCostMeta\s*\{[^}]*white-space:\s*pre-line/);
    assert.match(source, /avgSuccessIntervalMs/);
    assert.match(source, /本轮/);
    assert.match(source, /均时/);
    assert.match(source, /concurrencyMode/);
    assert.match(source, /targetConcurrency/);
    assert.match(source, /adaptiveReason/);
    assert.match(source, /pendingTotal/);
    assert.match(source, /<h2>运行模式<\/h2>/);
    assert.match(source, /<h2>接码配置<\/h2>/);
    assert.match(source, /<h2>配置操作<\/h2>/);
    assert.match(source, /id="runConcurrencyMode"/);
    assert.match(source, /id="successAfterEmailOtp"/);
    assert.match(source, /邮箱 OTP 后成功/);
    assert.match(source, /id="proxyMode"/);
    assert.match(source, /id="phoneCountryTemplate"/);
    assert.match(source, /手机号国家代理模板/);
    assert.match(source, /smsConfigDirty:\s*false/);
    assert.match(source, /function markSmsConfigDirty\(\)/);
    assert.match(source, /if \(!state\.smsConfigDirty\) \{/);
    assert.match(source, /fillProxyForm\(proxy\)/);
    assert.match(source, /id="saveSmsConfigBtn"/);
    assert.doesNotMatch(source, /id="saveRunConfigBtn"/);
    assert.doesNotMatch(source, /\/api\/run-config/);
    assert.doesNotMatch(source, /保存接码配置/);
    assert.match(source, /concurrency_mode/);
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
    assert.match(source, /logsFollowTail:\s*true/);
    assert.match(source, /id="copyLogsBtn" type="button" class="secondary" hidden>复制<\/button>/);
    assert.match(source, /\$\("copyLogsBtn"\)\.hidden = !state\.logsExpanded/);
    assert.match(source, /async function copyVisibleLogs\(\)/);
    assert.match(source, /navigator\.clipboard\.writeText\(text\)/);
    assert.match(source, /\$\("copyLogsBtn"\)\.onclick = copyVisibleLogs/);
    assert.match(source, /function updateLogFollowTail\(\)/);
    assert.match(source, /\$\("logs"\)\.addEventListener\("scroll", updateLogFollowTail, \{passive: true\}\)/);
    assert.match(source, /if \(shouldFollowTail\) \{/);
    assert.match(source, /logBox\.scrollTop = previousScrollTop/);
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
    assert.match(payloadSource, /concurrencyMode\s*:/);
    assert.match(payloadSource, /successAfterEmailOtp\s*:/);
    assert.match(payloadSource, /proxyMode\s*:/);
    assert.match(payloadSource, /phoneCountryTemplate\s*:/);
    assert.match(payloadSource, /apiKeyStrategy\s*:/);
    assert.match(valuesSource, /api_key_strategy\s*:/);
    for (const hiddenTomlKey of ["api_key", "api_keys", "rps_limit", "proxy_urls", "poll_interval_ms", "auto_release_on_timeout"]) {
        assert.doesNotMatch(valuesSource, new RegExp(`${hiddenTomlKey}\\s*:`));
    }
});

test("sms config save persists only visible run mode fields", async () => {
    const source = await adminSource();
    const handlerStart = source.indexOf("pathname === \"/api/sms-config\" && req.method === \"PUT\"");
    const handlerEnd = source.indexOf("pathname === \"/api/email/import\"", handlerStart);
    const handlerSource = source.slice(handlerStart, handlerEnd);
    const runValuesStart = handlerSource.indexOf("const runValues = {");
    const runValuesEnd = handlerSource.indexOf("};", runValuesStart);
    const runValuesSource = handlerSource.slice(runValuesStart, runValuesEnd);

    assert.match(runValuesSource, /concurrency_mode\s*:/);
    assert.match(runValuesSource, /success_after_email_otp\s*:/);
    assert.match(runValuesSource, /runConcurrencyModeFromBody/);
    assert.match(handlerSource, /upsertTomlSection\(content,\s*"run",\s*runValues\)/);
    assert.match(handlerSource, /const proxyValues = \{/);
    assert.match(handlerSource, /phone_country_template\s*:/);
    assert.match(handlerSource, /upsertTomlSection\(\s*upsertTomlSection\(content,\s*"run",\s*runValues\),\s*"proxies",\s*proxyValues,\s*\)/);
    for (const untouchedKey of ["total", "concurrency:", "adaptive_target_sms_rps_utilization", "adaptive_control_interval_ms"]) {
        assert.doesNotMatch(runValuesSource, new RegExp(untouchedKey));
    }
});

test("admin sessions persist without storing raw cookie tokens", async () => {
    const source = await adminSource();

    assert.match(source, /const SESSION_PERSIST_FILE = "\.admin-sessions\.json"/);
    assert.match(source, /function sessionStorePath\(\)/);
    assert.match(source, /FREE_REGISTER_SESSION_FILE/);
    assert.match(source, /function hashSessionToken\(token: string\)/);
    assert.match(source, /sessions\.set\(hashSessionToken\(token\), Date\.now\(\) \+ SESSION_TTL_MS\)/);
    assert.match(source, /await loadPersistentSessions\(\)/);
    assert.match(source, /tokenHash/);
    assert.doesNotMatch(source, /sessions\.set\(token, Date\.now\(\) \+ SESSION_TTL_MS\)/);
});
