const DEFAULT_RATE_LIMIT_WINDOW_MS = 1000;

interface KeyRateState {
  apiKey: string;
  label: string;
  requestTimestamps: number[];
  disabled: boolean;
  disabledReason: string;
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
  disabledReason: string;
  lastRequestAt: string;
}

export interface HeroSmsRateLimitOptions {
  rpsLimit?: number;
  windowMs?: number;
}

const keyRateStates = new Map<string, KeyRateState>();

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

export function redactHeroSmsKey(apiKey: string): string {
  const tail = apiKey.slice(-4) || "empty";
  return `****${tail}`;
}

function normalizeRateLimitWindowMs(value?: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : DEFAULT_RATE_LIMIT_WINDOW_MS;
}

function normalizeRpsLimit(value?: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : 40;
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
    disabledReason: "",
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

export function disableHeroSmsApiKey(apiKey: string, reason: string, label?: string): void {
  const trimmed = String(apiKey ?? "").trim();
  if (!trimmed) return;
  const state = rateStateFor(trimmed, label || `Key ${redactHeroSmsKey(trimmed)}`);
  state.disabled = true;
  state.disabledReason = String(reason || "disabled");
}

export function enableHeroSmsApiKeyIfReason(apiKey: string, reason: string, label?: string): void {
  const trimmed = String(apiKey ?? "").trim();
  if (!trimmed) return;
  const state = rateStateFor(trimmed, label || `Key ${redactHeroSmsKey(trimmed)}`);
  if (state.disabled && state.disabledReason === reason) {
    state.disabled = false;
    state.disabledReason = "";
  }
}

export function getHeroSmsApiKeyRpsSnapshot(
  apiKey: string,
  label: string,
  options: HeroSmsRateLimitOptions = {},
): HeroSmsKeyRpsSnapshot {
  const rpsLimit = normalizeRpsLimit(options.rpsLimit);
  const windowMs = normalizeRateLimitWindowMs(options.windowMs);
  const now = Date.now();
  const state = rateStateFor(apiKey, label);
  pruneRateWindow(state, now, windowMs);
  const windowCount = state.requestTimestamps.length;
  const rps = Math.round((windowCount * 1000 / windowMs) * 100) / 100;
  return {
    index: 0,
    label,
    rps,
    rpsLimit,
    windowCount,
    windowMs,
    waitMs: windowCount >= rpsLimit ? stateWaitMs(state, now, windowMs) : 0,
    disabled: state.disabled,
    disabledReason: state.disabledReason,
    lastRequestAt: state.lastRequestAt > 0 ? new Date(state.lastRequestAt).toISOString() : "",
  };
}

export function getHeroSmsRpsStats(
  apiKeys: string[],
  options: HeroSmsRateLimitOptions = {},
): HeroSmsKeyRpsSnapshot[] {
  const normalizedApiKeys = normalizeApiKeys(apiKeys);
  return normalizedApiKeys.map((apiKey, index): HeroSmsKeyRpsSnapshot => ({
    ...getHeroSmsApiKeyRpsSnapshot(apiKey, `Key #${index + 1} ${redactHeroSmsKey(apiKey)}`, options),
    index: index + 1,
  }));
}

export async function acquireHeroSmsApiSlot(
  apiKey: string,
  label: string,
  options: HeroSmsRateLimitOptions = {},
): Promise<void> {
  const trimmed = String(apiKey ?? "").trim();
  if (!trimmed) return;
  const rpsLimit = normalizeRpsLimit(options.rpsLimit);
  const windowMs = normalizeRateLimitWindowMs(options.windowMs);
  const state = rateStateFor(trimmed, label || `Key ${redactHeroSmsKey(trimmed)}`);

  for (;;) {
    const now = Date.now();
    pruneRateWindow(state, now, windowMs);
    if (state.requestTimestamps.length < rpsLimit) {
      state.requestTimestamps.push(now);
      state.lastRequestAt = now;
      return;
    }
    await sleep(stateWaitMs(state, now, windowMs));
  }
}

export function resetHeroSmsRpsStatsForTest(): void {
  keyRateStates.clear();
}
