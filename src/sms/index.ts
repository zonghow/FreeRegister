import { ActivationBroker } from "./activation-broker.js";
import { createHeroSmsProvider } from "./heroSMS.js";
import type { HeroSmsActivation, HeroSmsProvider, HeroSmsVerificationCode } from "./heroSMS.js";

type HeroSMSBrokerOption = {
  apiKey: string;
  proxyUrl?: string;
  countries: number[];
  acquirePriority: "country" | "price_low" | "price_high";
  minPrice: number;
  maxPrice: number;
  priceStep: number;
  pollIntervalMs: number;
  autoReleaseOnTimeout: boolean;
}

interface AcquireCandidate {
  country: number;
  maxPrice: number;
}

function roundPrice(value: number): number {
  return Math.round(value * 10000) / 10000;
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

  const heroProvider = createHeroSmsProvider({
    apiKey: option.apiKey,
    proxyUrl: option.proxyUrl,
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
  });

  let cursor = 0;

  const wrappedProvider: HeroSmsProvider = {
    ...heroProvider,
    async requestActivation(): Promise<HeroSmsActivation> {
      let lastErr: unknown = null;
      for (let off = 0; off < plan.length; off += 1) {
        const index = (cursor + off) % plan.length;
        const candidate = plan[index];
        try {
          console.log(`[heroSMS] 尝试取号 priority=${option.acquirePriority} country=${candidate.country} maxPrice<=${candidate.maxPrice} (${off + 1}/${plan.length})`);
          const activation = await heroProvider.requestPhoneNumber({
            service: "dr",
            country: candidate.country,
            maxPrice: candidate.maxPrice,
            fixedPrice: false,
          });
          cursor = index;
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
  };

  return new ActivationBroker(wrappedProvider);
};
