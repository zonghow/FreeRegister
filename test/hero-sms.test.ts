import assert from "node:assert/strict";
import test from "node:test";
import {normalizeHeroSmsBalance} from "../src/sms/heroSMS.js";

test("parses HeroSMS balance responses", () => {
  assert.equal(normalizeHeroSmsBalance("ACCESS_BALANCE:12.345").amount, 12.345);
  assert.equal(normalizeHeroSmsBalance("ACCESS_BALANCE:12,34").amount, 12.34);
  assert.equal(normalizeHeroSmsBalance({balance: "9.50"}).amount, 9.5);
  assert.equal(normalizeHeroSmsBalance({data: {amount: 7}}).amount, 7);
});

test("rejects unknown HeroSMS balance payloads", () => {
  assert.throws(() => normalizeHeroSmsBalance({status: "ok"}), /getBalance/);
});
