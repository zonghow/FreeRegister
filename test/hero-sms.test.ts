import assert from "node:assert/strict";
import {createServer} from "node:http";
import type {AddressInfo} from "node:net";
import test from "node:test";
import {HeroSmsActivationReleasedError, createHeroSmsProvider, fixedHeroSmsPollAttempts, normalizeHeroSmsBalance, normalizeHeroSmsCountries} from "../src/sms/heroSMS.js";
import {buildHeroSmsAcquirePlan, buildHeroSmsPriceTiers} from "../src/sms/index.js";

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
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
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
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
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
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
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
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
