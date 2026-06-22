import { ActivationBroker } from "./activation-broker.js";
import { createHeroSmsProvider } from "./heroSMS.js";
import type {
  HeroSmsActivation,
  HeroSmsNumberRequestOptions,
  HeroSmsProvider,
  HeroSmsVerificationCode,
} from "./heroSMS.js";

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

const DEFAULT_RATE_LIMIT_WINDOW_MS = 1000;

interface KeyRateState {
  apiKey: string;
  label: string;
  requestTimestamps: number[];
  disabled: boolean;
  lastRequestAt: number;
}

export interface HeroSmsKeyRpsSnapshot {
  index: number;
  label: string;
  rps: number;
  rpsLimit: number;
  windowCount: number;
  windowMs: number;
  waitMs: number;
  disabled: boolean;
  lastRequestAt: string;
}

const keyRateStates = new Map<string, KeyRateState>();
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

function redactHeroSmsKey(apiKey: string): string {
  const tail = apiKey.slice(-4) || "empty";
  return `****${tail}`;
}

function isBadKeyError(error: unknown): boolean {
  return String((error as Error)?.message ?? error).toUpperCase().includes("BAD_KEY");
}

function rateStateFor(apiKey: string, label: string): KeyRateState {
  const existing = keyRateStates.get(apiKey);
  if (existing) {
    existing.label = label;
    return existing;
  }
  const created: KeyRateState = {
    apiKey,
    label,
    requestTimestamps: [],
    disabled: false,
    lastRequestAt: 0,
  };
  keyRateStates.set(apiKey, created);
  return created;
}

function pruneRateWindow(state: KeyRateState, now: number, windowMs: number): void {
  while (state.requestTimestamps.length && now - state.requestTimestamps[0] >= windowMs) {
    state.requestTimestamps.shift();
  }
}

function stateWaitMs(state: KeyRateState, now: number, windowMs: number): number {
  pruneRateWindow(state, now, windowMs);
  const oldest = state.requestTimestamps[0];
  return oldest == null ? 1 : Math.max(1, windowMs - (now - oldest));
}

function normalizeRateLimitWindowMs(value?: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : DEFAULT_RATE_LIMIT_WINDOW_MS;
}

function normalizeRpsLimit(value?: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : 40;
}

function keySetId(apiKeys: string[]): string {
  return apiKeys.join("\0");
}

function accountRateState(account: KeyAccount): KeyRateState {
  return rateStateFor(account.apiKey, account.label);
}

export function getHeroSmsRpsStats(
  apiKeys: string[],
  options: {rpsLimit?: number; windowMs?: number} = {},
): HeroSmsKeyRpsSnapshot[] {
  const normalizedApiKeys = normalizeApiKeys(apiKeys);
  const rpsLimit = normalizeRpsLimit(options.rpsLimit);
  const windowMs = normalizeRateLimitWindowMs(options.windowMs);
  const now = Date.now();

  return normalizedApiKeys.map((apiKey, index): HeroSmsKeyRpsSnapshot => {
    const label = `Key #${index + 1} ${redactHeroSmsKey(apiKey)}`;
    const state = rateStateFor(apiKey, label);
    pruneRateWindow(state, now, windowMs);
    const windowCount = state.requestTimestamps.length;
    const rps = Math.round((windowCount * 1000 / windowMs) * 100) / 100;
    return {
      index: index + 1,
      label,
      rps,
      rpsLimit,
      windowCount,
      windowMs,
      waitMs: windowCount >= rpsLimit ? stateWaitMs(state, now, windowMs) : 0,
      disabled: state.disabled,
      lastRequestAt: state.lastRequestAt > 0 ? new Date(state.lastRequestAt).toISOString() : "",
    };
  });
}

export function resetHeroSmsRpsStatsForTest(): void {
  keyRateStates.clear();
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
    return accounts.filter((account) => !account.disabled && !accountRateState(account).disabled);
  }

  async function selectAccount(): Promise<KeyAccount> {
    for (;;) {
      const availableAccounts = activeAccounts();
      if (!availableAccounts.length) {
        throw new Error("HeroSMS 所有 API key 均不可用");
      }

      const now = Date.now();
      for (const account of availableAccounts) {
        pruneRateWindow(accountRateState(account), now, rateLimitWindowMs);
      }

      if (option.apiKeyStrategy === "fill_first") {
        const selected = accounts.find((account) => {
          const state = accountRateState(account);
          return !account.disabled && !state.disabled && state.requestTimestamps.length < rpsLimit;
        });
        if (selected) {
          const state = accountRateState(selected);
          state.requestTimestamps.push(now);
          state.lastRequestAt = now;
          return selected;
        }
      } else {
        const cursor = keySetCursors.get(selectionKey) ?? 0;
        for (let offset = 0; offset < accounts.length; offset += 1) {
          const index = (cursor + offset) % accounts.length;
          const selected = accounts[index];
          if (!selected) continue;
          const state = accountRateState(selected);
          if (selected.disabled || state.disabled || state.requestTimestamps.length >= rpsLimit) continue;
          keySetCursors.set(selectionKey, (index + 1) % accounts.length);
          state.requestTimestamps.push(now);
          state.lastRequestAt = now;
          return selected;
        }
      }

      const waitMs = Math.min(
        ...availableAccounts.map((account) => stateWaitMs(accountRateState(account), now, rateLimitWindowMs)),
      );
      console.warn(`[heroSMS] 所有 API key 均达到 getNumberV2 RPS 限制，等待 ${waitMs}ms`);
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
        if (!isBadKeyError(error)) {
          throw error;
        }
        account.disabled = true;
        accountRateState(account).disabled = true;
        console.warn(`[heroSMS] ${account.label} 返回 BAD_KEY，已在当前进程停用`);
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
            msg.includes("BAD_KEY")
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
