import { ActivationBroker } from "./activation-broker.js";
import { createHeroSmsProvider } from "./heroSMS.js";
import type { HeroSmsActivation, HeroSmsProvider, HeroSmsVerificationCode } from "./heroSMS.js";

type HeroSMSBrokerOption = {
  apiKey: string;
  country: number;
  countries?: number[]; // 多国支持(可选);为空时回退到 country 单国
  maxPrice: number;
  pollAttempts: number;
  pollIntervalMs: number;
  // 价格阶梯(从低到高)。如果没设置,就用 maxPrice 单点
  priceTiers?: number[];
}

/**
 * 阶梯价格 + 多国 broker。
 * 取号顺序:tier 从低到高,每个 tier 内依次试每个 country。
 * 每次调用 API 时 maxPrice 固定使用 heroSMSMaxPrice,tier 值仅控制遍历阶梯。
 *
 *   tiers=[0.04, 0.05]  countries=[48, 31]
 *   → 试 country=48 tier=0.04 (maxPrice=heroSMSMaxPrice)
 *   → 没号 → 试 country=31 tier=0.04
 *   → 没号 → 试 country=48 tier=0.05
 *   → 没号 → 试 country=31 tier=0.05
 *   → 全部失败抛错
 *
 * 一旦取到号,会缓存命中的 (tier, country) 组合,下一轮直接从该位置开始,避免重复试空仓。
 */
export const createSMSBroker = (option: HeroSMSBrokerOption) => {
  const tiers = (option.priceTiers && option.priceTiers.length)
    ? [...option.priceTiers].sort((a, b) => a - b)
    : [option.maxPrice];

  const countries = (option.countries && option.countries.length)
    ? [...option.countries]
    : [option.country];

  const heroProvider = createHeroSmsProvider({
    apiKey: option.apiKey,
    defaultRequestOptions: {
      service: "dr",
      country: countries[0],
      maxPrice: option.maxPrice,
      fixedPrice: false,
    },
    defaultWaitForCodeOptions: {
      markReady: false,
      completeOnCode: false,
      pollAttempts: option.pollAttempts,
      pollIntervalMs: option.pollIntervalMs,
    },
  });

  let cursorTier = 0;
  let cursorCountry = 0;

  const wrappedProvider: HeroSmsProvider = {
    ...heroProvider,
    async requestActivation(): Promise<HeroSmsActivation> {
      let lastErr: unknown = null;
      // 从上一轮命中点开始,先试当前 (tier, country),不行再扫整个矩阵
      for (let ti = cursorTier; ti < tiers.length; ti += 1) {
        const tier = tiers[ti];
        // tier 内从 cursorCountry 开始(命中点),其余轮询
        for (let off = 0; off < countries.length; off += 1) {
          const ci = (cursorCountry + off) % countries.length;
          const country = countries[ci];
          try {
            console.log(`[heroSMS] 尝试取号 country=${country} tier>=${tier} maxPrice<=${option.maxPrice} (tier ${ti + 1}/${tiers.length})`);
            const activation = await heroProvider.requestPhoneNumber({
              service: "dr",
              country,
              maxPrice: option.maxPrice,
              fixedPrice: false,
            });
            cursorTier = ti;
            cursorCountry = ci;
            console.log(`[heroSMS] 取号成功 country=${country} phone=+${activation.phoneNumber} cost=${activation.activationCost ?? '?'}`);
            return activation;
          } catch (err) {
            lastErr = err;
            const msg = String((err as Error)?.message ?? err).toUpperCase();
            // NO_NUMBERS / BAD_PRICE / WRONG_MAX_PRICE 都尝试下一个 country / 升档
            if (
              msg.includes("NO_NUMBERS") ||
              msg.includes("NO_NUMBER") ||
              msg.includes("BAD_PRICE") ||
              msg.includes("WRONG_MAX_PRICE") ||
              msg.includes("BAD_KEY")
            ) {
              console.warn(`[heroSMS] country=${country} tier=${tier} 跳过 (${(err as Error).message.slice(0, 80)})`);
              continue;
            }
            throw err;
          }
        }
        // tier 内所有 country 都没号,升档前重置 cursorCountry
        cursorCountry = 0;
      }
      throw lastErr ?? new Error(`HeroSMS 所有国家+价位都没号 (countries=[${countries.join(',')}], tiers=[${tiers.join(',')}])`);
    },
  };

  return new ActivationBroker(wrappedProvider);
};
