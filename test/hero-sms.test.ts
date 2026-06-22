import assert from "node:assert/strict";
import {createServer} from "node:http";
import type {AddressInfo} from "node:net";
import test from "node:test";
import {HeroSmsActivationReleasedError, createHeroSmsProvider, fixedHeroSmsPollAttempts, normalizeHeroSmsBalance, normalizeHeroSmsCountries} from "../src/sms/heroSMS.js";
import {
  buildHeroSmsAcquirePlan,
  buildHeroSmsPriceTiers,
  createSMSBroker,
  disableHeroSmsApiKey,
  enableHeroSmsApiKeyIfReason,
  getHeroSmsRpsStats,
  resetHeroSmsRpsStatsForTest,
} from "../src/sms/index.js";

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("parses HeroSMS balance responses", () => {
  assert.equal(normalizeHeroSmsBalance("ACCESS_BALANCE:12.345").amount, 12.345);
  assert.equal(normalizeHeroSmsBalance("ACCESS_BALANCE:12,34").amount, 12.34);
  assert.equal(normalizeHeroSmsBalance({balance: "9.50"}).amount, 9.5);
  assert.equal(normalizeHeroSmsBalance({data: {amount: 7}}).amount, 7);
});

test("rejects unknown HeroSMS balance payloads", () => {
  assert.throws(() => normalizeHeroSmsBalance({status: "ok"}), /getBalance/);
});

test("builds HeroSMS price tiers", () => {
  assert.deepEqual(buildHeroSmsPriceTiers(0.03, 0.05, 0.01), [0.03, 0.04, 0.05]);
  assert.deepEqual(buildHeroSmsPriceTiers(0.05, 0.03, 0.02), [0.03, 0.05]);
});

test("builds HeroSMS acquire plan by priority", () => {
  assert.deepEqual(buildHeroSmsAcquirePlan({
    countries: [33, 52],
    acquirePriority: "country",
    minPrice: 0.03,
    maxPrice: 0.04,
    priceStep: 0.01,
  }), [
    {country: 33, maxPrice: 0.03},
    {country: 33, maxPrice: 0.04},
    {country: 52, maxPrice: 0.03},
    {country: 52, maxPrice: 0.04},
  ]);

  assert.deepEqual(buildHeroSmsAcquirePlan({
    countries: [33, 52],
    acquirePriority: "price_high",
    minPrice: 0.03,
    maxPrice: 0.04,
    priceStep: 0.01,
  }), [
    {country: 33, maxPrice: 0.04},
    {country: 52, maxPrice: 0.04},
    {country: 33, maxPrice: 0.03},
    {country: 52, maxPrice: 0.03},
  ]);
});

test("uses fixed HeroSMS poll attempts that exceed two minutes", () => {
  assert.equal(fixedHeroSmsPollAttempts(3000), 42);
  assert.equal(fixedHeroSmsPollAttempts(5000), 26);
});

test("loads HeroSMS countries from API payload", async () => {
  const calls: URL[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    calls.push(url);

    if (url.searchParams.get("action") === "getCountries") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        value: [
          {id: 33, chn: "哥伦比亚", eng: "Colombia"},
          {id: 187, title: "USA"},
        ],
      }));
      return;
    }

    res.statusCode = 400;
    res.end("BAD_ACTION");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const provider = createHeroSmsProvider({
    apiKey: "",
    baseUrl: `http://127.0.0.1:${address.port}/handler_api.php`,
    timeoutMs: 1000,
  });

  try {
    const countries = (await provider.getCountries()).sort((left, right) => left.id - right.id);

    assert.deepEqual(countries.map((country) => ({id: country.id, label: country.label})), [
      {id: 33, label: "哥伦比亚 (Colombia)"},
      {id: 187, label: "USA"},
    ]);
    assert.equal(calls[0].searchParams.get("api_key"), null);
  } finally {
    await closeServer(server);
  }
});

test("normalizes HeroSMS country object maps", () => {
  assert.deepEqual(
    normalizeHeroSmsCountries({
      52: {chn: "泰国", eng: "Thailand"},
      33: {label: "Colombia"},
    }).map((country) => ({id: country.id, label: country.label})).sort((left, right) => left.id - right.id),
    [
      {id: 33, label: "Colombia"},
      {id: 52, label: "泰国 (Thailand)"},
    ],
  );
});

test("auto releases HeroSMS activation after poll timeout", async () => {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const action = url.searchParams.get("action") ?? "";
    calls.push(`${action}:${url.searchParams.get("status") ?? ""}:${url.searchParams.get("id") ?? ""}`);

    if (action === "getActiveActivations") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({status: "success", data: []}));
      return;
    }

    if (action === "getStatusV2" || action === "getStatus") {
      res.end("STATUS_WAIT_CODE");
      return;
    }

    if (action === "setStatus") {
      res.end("ACCESS_CANCEL");
      return;
    }

    res.statusCode = 400;
    res.end("BAD_ACTION");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const provider = createHeroSmsProvider({
    apiKey: "test-key",
    baseUrl: `http://127.0.0.1:${address.port}/handler_api.php`,
    timeoutMs: 1000,
    cancelAndWithdrawMinAgeMs: 0,
  });

  try {
    await assert.rejects(
      provider.waitForVerificationCode("activation-1", {
        pollIntervalMs: 1,
        autoReleaseOnTimeout: true,
      }),
      (error) => {
        assert.ok(error instanceof HeroSmsActivationReleasedError);
        assert.equal(error.activationId, "activation-1");
        assert.match(error.message, /已自动释放号码/);
        return true;
      },
    );

    assert.equal(calls.filter((call) => call === "setStatus:8:activation-1").length, 1);
  } finally {
    await closeServer(server);
  }
});

test("waits until HeroSMS activation is old enough before auto release", async () => {
  const calls: string[] = [];
  const startedAt = Date.now();
  let releaseAt = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const action = url.searchParams.get("action") ?? "";
    calls.push(action);

    if (action === "getActiveActivations") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({status: "success", data: []}));
      return;
    }

    if (action === "getStatusV2" || action === "getStatus") {
      res.end("STATUS_WAIT_CODE");
      return;
    }

    if (action === "setStatus") {
      releaseAt = Date.now();
      res.end("ACCESS_CANCEL");
      return;
    }

    res.statusCode = 400;
    res.end("BAD_ACTION");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const provider = createHeroSmsProvider({
    apiKey: "test-key",
    baseUrl: `http://127.0.0.1:${address.port}/handler_api.php`,
    timeoutMs: 1000,
    cancelAndWithdrawMinAgeMs: 50,
  });

  try {
    await assert.rejects(
      provider.waitForVerificationCode("activation-early", {
        pollIntervalMs: 10,
        autoReleaseOnTimeout: true,
      }),
      HeroSmsActivationReleasedError,
    );

    assert.ok(releaseAt - startedAt >= 45);
    assert.equal(calls.filter((call) => call === "setStatus").length, 1);
  } finally {
    await closeServer(server);
  }
});

test("aborts HeroSMS verification wait", async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const action = url.searchParams.get("action") ?? "";

    if (action === "getActiveActivations") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({status: "success", data: []}));
      return;
    }

    if (action === "getStatusV2" || action === "getStatus") {
      res.end("STATUS_WAIT_CODE");
      return;
    }

    res.statusCode = 400;
    res.end("BAD_ACTION");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const provider = createHeroSmsProvider({
    apiKey: "test-key",
    baseUrl: `http://127.0.0.1:${address.port}/handler_api.php`,
    timeoutMs: 1000,
  });
  const controller = new AbortController();

  try {
    const waitPromise = provider.waitForVerificationCode("activation-2", {
      pollIntervalMs: 10000,
      signal: controller.signal,
    });
    controller.abort();

    await assert.rejects(waitPromise, /aborted/);
  } finally {
    await closeServer(server);
  }
});

test("round robin HeroSMS keys for getNumberV2 requests", async () => {
  resetHeroSmsRpsStatsForTest();
  const getNumberKeys: string[] = [];
  const releaseKeys: string[] = [];
  let nextActivation = 1;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const action = url.searchParams.get("action") ?? "";
    const apiKey = url.searchParams.get("api_key") ?? "";

    if (action === "getNumberV2") {
      getNumberKeys.push(apiKey);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({activationId: `activation-${nextActivation++}`, phoneNumber: `57350000000${nextActivation}`}));
      return;
    }

    if (action === "setStatus") {
      releaseKeys.push(apiKey);
      res.end("ACCESS_READY");
      return;
    }

    res.statusCode = 400;
    res.end("BAD_ACTION");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const broker = createSMSBroker({
    apiKeys: ["key-a", "key-b"],
    apiKeyStrategy: "round_robin",
    rpsLimit: 100,
    baseUrl: `http://127.0.0.1:${address.port}/handler_api.php`,
    timeoutMs: 1000,
    countries: [33],
    acquirePriority: "country",
    minPrice: 0.01,
    maxPrice: 0.01,
    priceStep: 0.01,
    pollIntervalMs: 1,
    autoReleaseOnTimeout: false,
  });

  try {
    for (let index = 0; index < 3; index += 1) {
      await broker.getActivation();
      await broker.markAsFailed(true);
    }

    assert.deepEqual(getNumberKeys, ["key-a", "key-b", "key-a"]);
    assert.deepEqual(releaseKeys, ["key-a", "key-b", "key-a"]);
  } finally {
    await closeServer(server);
  }
});

test("fill-first HeroSMS keys until the first key hits shared account API RPS limit", async () => {
  resetHeroSmsRpsStatsForTest();
  const getNumberKeys: string[] = [];
  let nextActivation = 1;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const action = url.searchParams.get("action") ?? "";
    const apiKey = url.searchParams.get("api_key") ?? "";

    if (action === "getNumberV2") {
      getNumberKeys.push(apiKey);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({activationId: `fill-${nextActivation++}`, phoneNumber: `57351000000${nextActivation}`}));
      return;
    }

    if (action === "setStatus") {
      res.end("ACCESS_READY");
      return;
    }

    res.statusCode = 400;
    res.end("BAD_ACTION");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const broker = createSMSBroker({
    apiKeys: ["key-a", "key-b"],
    apiKeyStrategy: "fill_first",
    rpsLimit: 2,
    rateLimitWindowMs: 50,
    baseUrl: `http://127.0.0.1:${address.port}/handler_api.php`,
    timeoutMs: 1000,
    countries: [33],
    acquirePriority: "country",
    minPrice: 0.01,
    maxPrice: 0.01,
    priceStep: 0.01,
    pollIntervalMs: 1,
    autoReleaseOnTimeout: false,
  });

  try {
    for (let index = 0; index < 3; index += 1) {
      await broker.getActivation();
      await broker.markAsFailed(true);
    }

    assert.deepEqual(getNumberKeys, ["key-a", "key-b", "key-a"]);
  } finally {
    await closeServer(server);
  }
});

test("waits when all HeroSMS keys hit account-level API RPS limit", async () => {
  resetHeroSmsRpsStatsForTest();
  const getNumberKeys: string[] = [];
  let nextActivation = 1;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const action = url.searchParams.get("action") ?? "";
    const apiKey = url.searchParams.get("api_key") ?? "";

    if (action === "getNumberV2") {
      getNumberKeys.push(apiKey);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({activationId: `limited-${nextActivation++}`, phoneNumber: `57352000000${nextActivation}`}));
      return;
    }

    if (action === "setStatus") {
      res.end("ACCESS_READY");
      return;
    }

    res.statusCode = 400;
    res.end("BAD_ACTION");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const broker = createSMSBroker({
    apiKeys: ["key-a", "key-b"],
    apiKeyStrategy: "round_robin",
    rpsLimit: 1,
    rateLimitWindowMs: 50,
    baseUrl: `http://127.0.0.1:${address.port}/handler_api.php`,
    timeoutMs: 1000,
    countries: [33],
    acquirePriority: "country",
    minPrice: 0.01,
    maxPrice: 0.01,
    priceStep: 0.01,
    pollIntervalMs: 1,
    autoReleaseOnTimeout: false,
  });

  try {
    const startedAt = Date.now();
    for (let index = 0; index < 3; index += 1) {
      await broker.getActivation();
      await broker.markAsFailed(true);
    }

    assert.deepEqual(getNumberKeys, ["key-a", "key-b", "key-a"]);
    assert.ok(Date.now() - startedAt >= 35);
  } finally {
    await closeServer(server);
  }
});

test("shares one HeroSMS account RPS window across getNumber and setStatus", async () => {
  resetHeroSmsRpsStatsForTest();
  const calls: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const action = url.searchParams.get("action") ?? "";
    calls.push(action);

    if (action === "getNumberV2") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({activationId: "shared-window", phoneNumber: "573570000001"}));
      return;
    }

    if (action === "setStatus") {
      res.end("ACCESS_READY");
      return;
    }

    res.statusCode = 400;
    res.end("BAD_ACTION");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const provider = createHeroSmsProvider({
    apiKey: "shared-key",
    rpsLimit: 1,
    rateLimitWindowMs: 50,
    baseUrl: `http://127.0.0.1:${address.port}/handler_api.php`,
    timeoutMs: 1000,
  });

  try {
    const startedAt = Date.now();
    const activation = await provider.requestPhoneNumber({
      service: "dr",
      country: 33,
      maxPrice: 0.01,
      fixedPrice: false,
    });
    await provider.completeActivation(activation.activationId);

    assert.deepEqual(calls, ["getNumberV2", "setStatus"]);
    assert.ok(Date.now() - startedAt >= 35);
    assert.equal(getHeroSmsRpsStats(["shared-key"], {rpsLimit: 1, windowMs: 50})[0].windowCount, 1);
  } finally {
    await closeServer(server);
  }
});

test("uses the bound HeroSMS key for activation status and release", async () => {
  resetHeroSmsRpsStatsForTest();
  const calls: Array<{action: string; apiKey: string}> = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const action = url.searchParams.get("action") ?? "";
    const apiKey = url.searchParams.get("api_key") ?? "";
    calls.push({action, apiKey});

    if (action === "getNumberV2") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({activationId: "route-activation", phoneNumber: "573530000001"}));
      return;
    }

    if (action === "getActiveActivations") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({status: "success", data: []}));
      return;
    }

    if (action === "getStatusV2") {
      res.end("STATUS_WAIT_CODE");
      return;
    }

    if (action === "getStatus") {
      res.end("STATUS_OK:654321");
      return;
    }

    if (action === "setStatus") {
      res.end("ACCESS_READY");
      return;
    }

    res.statusCode = 400;
    res.end("BAD_ACTION");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const broker = createSMSBroker({
    apiKeys: ["key-a", "key-b"],
    apiKeyStrategy: "round_robin",
    rpsLimit: 100,
    baseUrl: `http://127.0.0.1:${address.port}/handler_api.php`,
    timeoutMs: 1000,
    countries: [33],
    acquirePriority: "country",
    minPrice: 0.01,
    maxPrice: 0.01,
    priceStep: 0.01,
    pollIntervalMs: 1,
    autoReleaseOnTimeout: false,
  });

  try {
    const lease = await broker.getActivation();
    const verification = await lease.waitForVerificationCode();
    await broker.completeCurrentActivation();

    assert.equal(verification.code, "654321");
    assert.deepEqual(
      calls
        .filter((call) => ["getNumberV2", "getActiveActivations", "getStatusV2", "getStatus", "setStatus"].includes(call.action))
        .map((call) => `${call.action}:${call.apiKey}`),
      [
        "getNumberV2:key-a",
        "getActiveActivations:key-a",
        "getStatusV2:key-a",
        "getStatus:key-a",
        "setStatus:key-a",
      ],
    );
  } finally {
    await closeServer(server);
  }
});

test("disables BAD_KEY HeroSMS keys for the current process", async () => {
  resetHeroSmsRpsStatsForTest();
  const getNumberKeys: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const action = url.searchParams.get("action") ?? "";
    const apiKey = url.searchParams.get("api_key") ?? "";

    if (action === "getNumberV2") {
      getNumberKeys.push(apiKey);
      if (apiKey === "bad-key") {
        res.end("BAD_KEY");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({activationId: "good-activation", phoneNumber: "573540000001"}));
      return;
    }

    if (action === "setStatus") {
      res.end("ACCESS_READY");
      return;
    }

    res.statusCode = 400;
    res.end("BAD_ACTION");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const broker = createSMSBroker({
    apiKeys: ["bad-key", "good-key"],
    apiKeyStrategy: "round_robin",
    rpsLimit: 100,
    baseUrl: `http://127.0.0.1:${address.port}/handler_api.php`,
    timeoutMs: 1000,
    countries: [33],
    acquirePriority: "country",
    minPrice: 0.01,
    maxPrice: 0.01,
    priceStep: 0.01,
    pollIntervalMs: 1,
    autoReleaseOnTimeout: false,
  });

  try {
    await broker.getActivation();
    await broker.markAsFailed(true);
    await broker.getActivation();

    assert.deepEqual(getNumberKeys, ["bad-key", "good-key", "good-key"]);
  } finally {
    await closeServer(server);
  }
});

test("disables no-balance HeroSMS keys and continues with the next key", async () => {
  resetHeroSmsRpsStatsForTest();
  const getNumberKeys: string[] = [];
  const releaseKeys: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const action = url.searchParams.get("action") ?? "";
    const apiKey = url.searchParams.get("api_key") ?? "";

    if (action === "getNumberV2") {
      getNumberKeys.push(apiKey);
      if (apiKey === "empty-key") {
        res.end("NO_BALANCE");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({activationId: "funded-activation", phoneNumber: "573560000001"}));
      return;
    }

    if (action === "setStatus") {
      releaseKeys.push(apiKey);
      res.end("ACCESS_READY");
      return;
    }

    res.statusCode = 400;
    res.end("BAD_ACTION");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const broker = createSMSBroker({
    apiKeys: ["empty-key", "good-key"],
    apiKeyStrategy: "round_robin",
    rpsLimit: 100,
    baseUrl: `http://127.0.0.1:${address.port}/handler_api.php`,
    timeoutMs: 1000,
    countries: [33],
    acquirePriority: "country",
    minPrice: 0.01,
    maxPrice: 0.01,
    priceStep: 0.01,
    pollIntervalMs: 1,
    autoReleaseOnTimeout: false,
  });

  try {
    await broker.getActivation();
    await broker.markAsFailed(true);

    assert.deepEqual(getNumberKeys, ["empty-key", "good-key"]);
    assert.deepEqual(releaseKeys, ["good-key"]);
    assert.deepEqual(
      getHeroSmsRpsStats(["empty-key", "good-key"], {rpsLimit: 100}).map((item) => ({
        label: item.label,
        disabled: item.disabled,
        disabledReason: item.disabledReason,
      })),
      [
        {label: "Key #1 ****-key", disabled: true, disabledReason: "no_balance"},
        {label: "Key #2 ****-key", disabled: false, disabledReason: ""},
      ],
    );
  } finally {
    await closeServer(server);
  }
});

test("re-enables only no-balance HeroSMS keys after balance refresh", () => {
  resetHeroSmsRpsStatsForTest();

  disableHeroSmsApiKey("recharge-key", "no_balance", "Key #1 ****-key");
  assert.equal(getHeroSmsRpsStats(["recharge-key"])[0].disabled, true);

  enableHeroSmsApiKeyIfReason("recharge-key", "no_balance", "Key #1 ****-key");
  assert.equal(getHeroSmsRpsStats(["recharge-key"])[0].disabled, false);

  disableHeroSmsApiKey("bad-key", "bad_key", "Key #1 ****-key");
  enableHeroSmsApiKeyIfReason("bad-key", "no_balance", "Key #1 ****-key");
  const stats = getHeroSmsRpsStats(["bad-key"])[0];
  assert.equal(stats.disabled, true);
  assert.equal(stats.disabledReason, "bad_key");
});

test("shares HeroSMS RPS stats and round-robin cursor across brokers", async () => {
  resetHeroSmsRpsStatsForTest();
  const getNumberKeys: string[] = [];
  let nextActivation = 1;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const action = url.searchParams.get("action") ?? "";
    const apiKey = url.searchParams.get("api_key") ?? "";

    if (action === "getNumberV2") {
      getNumberKeys.push(apiKey);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({activationId: `shared-${nextActivation++}`, phoneNumber: `57355000000${nextActivation}`}));
      return;
    }

    if (action === "setStatus") {
      res.end("ACCESS_READY");
      return;
    }

    res.statusCode = 400;
    res.end("BAD_ACTION");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const common = {
    apiKeys: ["key-a", "key-b"],
    apiKeyStrategy: "round_robin" as const,
    rpsLimit: 100,
    baseUrl: `http://127.0.0.1:${address.port}/handler_api.php`,
    timeoutMs: 1000,
    countries: [33],
    acquirePriority: "country" as const,
    minPrice: 0.01,
    maxPrice: 0.01,
    priceStep: 0.01,
    pollIntervalMs: 1,
    autoReleaseOnTimeout: false,
  };
  const brokerA = createSMSBroker(common);
  const brokerB = createSMSBroker(common);

  try {
    await brokerA.getActivation();
    await brokerA.markAsFailed(true);
    await brokerB.getActivation();
    await brokerB.markAsFailed(true);

    assert.deepEqual(getNumberKeys, ["key-a", "key-b"]);
    assert.deepEqual(
      getHeroSmsRpsStats(["key-a", "key-b"], {rpsLimit: 100}).map((item) => ({
        label: item.label,
        rps: item.rps,
        windowCount: item.windowCount,
        disabled: item.disabled,
      })),
      [
        {label: "Key #1 ****ey-a", rps: 2, windowCount: 2, disabled: false},
        {label: "Key #2 ****ey-b", rps: 2, windowCount: 2, disabled: false},
      ],
    );
  } finally {
    await closeServer(server);
  }
});
