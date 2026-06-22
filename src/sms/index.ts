import { ActivationBroker } from "./activation-broker.js";
import { createHeroSmsProvider } from "./heroSMS.js";
import type {
  HeroSmsActivation,
  HeroSmsNumberRequestOptions,
  HeroSmsProvider,
  HeroSmsVerificationCode,
} from "./heroSMS.js";
import {
  disableHeroSmsApiKey,
  getHeroSmsApiKeyRpsSnapshot,
  redactHeroSmsKey,
  resetHeroSmsRpsStatsForTest as resetHeroSmsRateLimitStatsForTest,
} from "./heroSmsRateLimit.js";
export {
  disableHeroSmsApiKey,
  enableHeroSmsApiKeyIfReason,
  getHeroSmsRpsStats,
} from "./heroSmsRateLimit.js";

export type HeroSmsApiKeyStrategy = "round_robin" | "fill_first";

type HeroSMSBrokerOption = {
  apiKeys: string[];
  apiKeyStrategy: HeroSmsApiKeyStrategy;
  rpsLimit: number;
  proxyUrl?: string;
  countries: number[];
  acquirePriority: "country" | "price_low" | "price_high";
  minPrice: number;
  maxPrice: number;
  priceStep: number;
  pollIntervalMs: number;
  autoReleaseOnTimeout: boolean;
  baseUrl?: string;
  timeoutMs?: number;
  rateLimitWindowMs?: number;
}

interface AcquireCandidate {
  country: number;
  maxPrice: number;
}

interface KeyAccount {
  index: number;
  apiKey: string;
  label: string;
  provider: HeroSmsProvider;
  disabled: boolean;
}

const keySetCursors = new Map<string, number>();

function roundPrice(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
}

function normalizeApiKeys(apiKeys: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of apiKeys) {
    const apiKey = String(item ?? "").trim();
    if (!apiKey || seen.has(apiKey)) continue;
    seen.add(apiKey);
    normalized.push(apiKey);
  }
  return normalized;
}

function isBadKeyError(error: unknown): boolean {
  return String((error as Error)?.message ?? error).toUpperCase().includes("BAD_KEY");
}

function isInsufficientBalanceError(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error).toUpperCase();
  return (
    message.includes("NO_BALANCE") ||
    message.includes("NO_MONEY") ||
    message.includes("NO_FUNDS") ||
    message.includes("LOW_BALANCE") ||
    message.includes("ZERO_BALANCE") ||
    message.includes("EMPTY_BALANCE") ||
    message.includes("NOT_ENOUGH") ||
    message.includes("NOT ENOUGH") ||
    message.includes("INSUFFICIENT_BALANCE") ||
    message.includes("INSUFFICIENT FUNDS") ||
    message.includes("INSUFFICIENT_FUNDS") ||
    (message.includes("INSUFFICIENT") && (message.includes("BALANCE") || message.includes("FUNDS") || message.includes("MONEY")))
  );
}

function keyDisableReasonForError(error: unknown): string {
  if (isBadKeyError(error)) return "bad_key";
  if (isInsufficientBalanceError(error)) return "no_balance";
  return "";
}

function normalizeRateLimitWindowMs(value?: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : 1000;
}

function keySetId(apiKeys: string[]): string {
  return apiKeys.join("\0");
}

function accountRateSnapshot(account: KeyAccount, rpsLimit: number, windowMs: number) {
  return getHeroSmsApiKeyRpsSnapshot(account.apiKey, account.label, {rpsLimit, windowMs});
}

export function resetHeroSmsRpsStatsForTest(): void {
  resetHeroSmsRateLimitStatsForTest();
  keySetCursors.clear();
}

export function buildHeroSmsPriceTiers(minPrice: number, maxPrice: number, priceStep: number): number[] {
  const min = Number.isFinite(minPrice) && minPrice > 0 ? minPrice : maxPrice;
  const max = Number.isFinite(maxPrice) && maxPrice > 0 ? maxPrice : min;
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  const step = Number.isFinite(priceStep) && priceStep > 0 ? priceStep : high - low || high;
  const tiers: number[] = [];
  for (let price = low; price <= high + 1e-9; price += step) {
    tiers.push(roundPrice(price));
    if (tiers.length > 200) break;
  }
  if (!tiers.includes(roundPrice(high))) {
    tiers.push(roundPrice(high));
  }
  return [...new Set(tiers)].sort((a, b) => a - b);
}

export function buildHeroSmsAcquirePlan(option: Pick<HeroSMSBrokerOption, "countries" | "acquirePriority" | "minPrice" | "maxPrice" | "priceStep">): AcquireCandidate[] {
  const countries = option.countries.length ? option.countries : [33];
  const lowToHigh = buildHeroSmsPriceTiers(option.minPrice, option.maxPrice, option.priceStep);
  const priceTiers = option.acquirePriority === "price_high" ? [...lowToHigh].reverse() : lowToHigh;
  const plan: AcquireCandidate[] = [];

  if (option.acquirePriority === "country") {
    for (const country of countries) {
      for (const maxPrice of priceTiers) {
        plan.push({country, maxPrice});
      }
    }
    return plan;
  }

  for (const maxPrice of priceTiers) {
    for (const country of countries) {
      plan.push({country, maxPrice});
    }
  }
  return plan;
}

export const createSMSBroker = (option: HeroSMSBrokerOption) => {
  const plan = buildHeroSmsAcquirePlan(option);
  const countries = option.countries.length ? option.countries : [33];
  const apiKeys = normalizeApiKeys(option.apiKeys);
  if (!apiKeys.length) {
    throw new Error("HeroSMS api_keys 未配置");
  }

  const rpsLimit = Number.isInteger(option.rpsLimit) && option.rpsLimit > 0 ? option.rpsLimit : 40;
  const rateLimitWindowMs = normalizeRateLimitWindowMs(option.rateLimitWindowMs);
  const selectionKey = keySetId(apiKeys);
  const accountByActivationId = new Map<string, KeyAccount>();
  const accounts = apiKeys.map((apiKey, index): KeyAccount => ({
    index,
    apiKey,
    label: `Key #${index + 1} ${redactHeroSmsKey(apiKey)}`,
    provider: createHeroSmsProvider({
      apiKey,
      proxyUrl: option.proxyUrl,
      baseUrl: option.baseUrl,
      timeoutMs: option.timeoutMs,
      rpsLimit,
      rateLimitWindowMs,
      rateLimitLabel: `Key #${index + 1} ${redactHeroSmsKey(apiKey)}`,
      defaultRequestOptions: {
        service: "dr",
        country: countries[0],
        maxPrice: option.maxPrice,
        fixedPrice: false,
      },
      defaultWaitForCodeOptions: {
        markReady: false,
        completeOnCode: false,
        pollIntervalMs: option.pollIntervalMs,
        autoReleaseOnTimeout: option.autoReleaseOnTimeout,
      },
    }),
    disabled: false,
  }));

  function activeAccounts(): KeyAccount[] {
    return accounts.filter((account) => !account.disabled && !accountRateSnapshot(account, rpsLimit, rateLimitWindowMs).disabled);
  }

  async function selectAccount(): Promise<KeyAccount> {
    for (;;) {
      const availableAccounts = activeAccounts();
      if (!availableAccounts.length) {
        throw new Error("HeroSMS 所有 API key 均不可用");
      }

      if (option.apiKeyStrategy === "fill_first") {
        const selected = accounts.find((account) => {
          const snapshot = accountRateSnapshot(account, rpsLimit, rateLimitWindowMs);
          return !account.disabled && !snapshot.disabled && snapshot.windowCount < rpsLimit;
        });
        if (selected) {
          return selected;
        }
      } else {
        const cursor = keySetCursors.get(selectionKey) ?? 0;
        for (let offset = 0; offset < accounts.length; offset += 1) {
          const index = (cursor + offset) % accounts.length;
          const selected = accounts[index];
          if (!selected) continue;
          const snapshot = accountRateSnapshot(selected, rpsLimit, rateLimitWindowMs);
          if (selected.disabled || snapshot.disabled || snapshot.windowCount >= rpsLimit) continue;
          keySetCursors.set(selectionKey, (index + 1) % accounts.length);
          return selected;
        }
      }

      const waitMs = Math.min(
        ...availableAccounts.map((account) => accountRateSnapshot(account, rpsLimit, rateLimitWindowMs).waitMs || 1),
      );
      console.warn(`[heroSMS] 所有 API key 均达到账号级 API RPS 限制，等待 ${waitMs}ms`);
      await sleep(waitMs);
    }
  }

  function accountForActivation(activationId: string | number): KeyAccount {
    const normalizedActivationId = String(activationId ?? "").trim();
    const account = accountByActivationId.get(normalizedActivationId);
    if (!account) {
      throw new Error(`HeroSMS activation 未绑定 API key: activationId=${normalizedActivationId}`);
    }
    return account;
  }

  async function requestPhoneNumberWithSelectedKey(options: HeroSmsNumberRequestOptions): Promise<HeroSmsActivation> {
    let lastErr: unknown = null;
    for (;;) {
      const account = await selectAccount();
      try {
        const activation = await account.provider.requestPhoneNumber(options);
        accountByActivationId.set(activation.activationId, account);
        console.log(`[heroSMS] 使用 ${account.label} 取号成功`);
        return activation;
      } catch (error) {
        lastErr = error;
        const disableReason = keyDisableReasonForError(error);
        if (!disableReason) {
          throw error;
        }
        account.disabled = true;
        disableHeroSmsApiKey(account.apiKey, disableReason, account.label);
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[heroSMS] ${account.label} 返回 ${disableReason}，已在当前进程停用 (${message.slice(0, 100)})`);
        if (!activeAccounts().length) {
          throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
        }
      }
    }
  }

  let planCursor = 0;

  const wrappedProvider: HeroSmsProvider = {
    ...accounts[0].provider,
    async requestActivation(): Promise<HeroSmsActivation> {
      let lastErr: unknown = null;
      for (let off = 0; off < plan.length; off += 1) {
        const index = (planCursor + off) % plan.length;
        const candidate = plan[index];
        try {
          console.log(`[heroSMS] 尝试取号 priority=${option.acquirePriority} country=${candidate.country} maxPrice<=${candidate.maxPrice} (${off + 1}/${plan.length})`);
          const activation = await requestPhoneNumberWithSelectedKey({
            service: "dr",
            country: candidate.country,
            maxPrice: candidate.maxPrice,
            fixedPrice: false,
          });
          planCursor = index;
          console.log(`[heroSMS] 取号成功 country=${candidate.country} phone=+${activation.phoneNumber} cost=${activation.activationCost ?? '?'}`);
          return activation;
        } catch (err) {
          lastErr = err;
          const msg = String((err as Error)?.message ?? err).toUpperCase();
          if (
            msg.includes("NO_NUMBERS") ||
            msg.includes("NO_NUMBER") ||
            msg.includes("BAD_PRICE") ||
            msg.includes("WRONG_MAX_PRICE") ||
            msg.includes("BAD_KEY") ||
            isInsufficientBalanceError(err)
          ) {
            console.warn(`[heroSMS] country=${candidate.country} maxPrice=${candidate.maxPrice} 跳过 (${(err as Error).message.slice(0, 80)})`);
            continue;
          }
          throw err;
        }
      }
      throw lastErr ?? new Error(`HeroSMS 所有国家+价格组合都没号 (countries=[${countries.join(',')}], prices=[${plan.map((item) => item.maxPrice).join(',')}])`);
    },

    async requestAnotherSms(activationId: string): Promise<string> {
      return accountForActivation(activationId).provider.requestAnotherSms(activationId);
    },

    async waitForVerificationCode(activationId: string, waitOptions): Promise<HeroSmsVerificationCode> {
      try {
        return await accountForActivation(activationId).provider.waitForVerificationCode(activationId, waitOptions);
      } catch (error) {
        if ((error as {releaseActivation?: unknown})?.releaseActivation) {
          accountByActivationId.delete(String(activationId));
        }
        throw error;
      }
    },

    async completeActivation(activationId: string): Promise<string> {
      try {
        return await accountForActivation(activationId).provider.completeActivation(activationId);
      } finally {
        accountByActivationId.delete(String(activationId));
      }
    },

    async cancelAndWithdraw(activationId: string): Promise<string> {
      try {
        return await accountForActivation(activationId).provider.cancelAndWithdraw(activationId);
      } finally {
        accountByActivationId.delete(String(activationId));
      }
    },

    async cancelActivation(activationId: string): Promise<string> {
      try {
        return await accountForActivation(activationId).provider.cancelActivation(activationId);
      } finally {
        accountByActivationId.delete(String(activationId));
      }
    },
  };

  return new ActivationBroker(wrappedProvider);
};
