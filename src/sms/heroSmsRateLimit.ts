const DEFAULT_RATE_LIMIT_WINDOW_MS = 1000;

export type HeroSmsApiPriority = "high" | "low";

interface SlotWaiter {
  priority: HeroSmsApiPriority;
  requestedAt: number;
  rpsLimit: number;
  windowMs: number;
  resolve: () => void;
}

interface KeyRateState {
  apiKey: string;
  label: string;
  requestTimestamps: number[];
  waiters: SlotWaiter[];
  wakeTimer: ReturnType<typeof setTimeout> | null;
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
  pendingHigh: number;
  pendingLow: number;
  pendingTotal: number;
  oldestPendingMs: number;
}

export interface HeroSmsRateLimitOptions {
  rpsLimit?: number;
  windowMs?: number;
  priority?: HeroSmsApiPriority;
}

const keyRateStates = new Map<string, KeyRateState>();

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
    waiters: [],
    wakeTimer: null,
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

function normalizePriority(priority?: HeroSmsApiPriority): HeroSmsApiPriority {
  return priority === "high" ? "high" : "low";
}

function nextWaiterIndex(state: KeyRateState): number {
  const highIndex = state.waiters.findIndex((waiter) => waiter.priority === "high");
  return highIndex >= 0 ? highIndex : 0;
}

function pendingCounts(state: KeyRateState, now = Date.now()) {
  let pendingHigh = 0;
  let pendingLow = 0;
  let oldestPendingAt = 0;
  for (const waiter of state.waiters) {
    if (waiter.priority === "high") {
      pendingHigh += 1;
    } else {
      pendingLow += 1;
    }
    oldestPendingAt = oldestPendingAt > 0 ? Math.min(oldestPendingAt, waiter.requestedAt) : waiter.requestedAt;
  }
  return {
    pendingHigh,
    pendingLow,
    pendingTotal: pendingHigh + pendingLow,
    oldestPendingMs: oldestPendingAt > 0 ? Math.max(0, now - oldestPendingAt) : 0,
  };
}

function scheduleQueueWake(state: KeyRateState, waitMs: number): void {
  if (state.wakeTimer) {
    return;
  }
  state.wakeTimer = setTimeout(() => {
    state.wakeTimer = null;
    processQueue(state);
  }, Math.max(1, waitMs));
  state.wakeTimer.unref?.();
}

function processQueue(state: KeyRateState): void {
  if (state.wakeTimer) {
    clearTimeout(state.wakeTimer);
    state.wakeTimer = null;
  }

  for (;;) {
    if (!state.waiters.length) {
      return;
    }
    const waiterIndex = nextWaiterIndex(state);
    const waiter = state.waiters[waiterIndex];
    if (!waiter) {
      return;
    }
    const now = Date.now();
    pruneRateWindow(state, now, waiter.windowMs);
    if (state.requestTimestamps.length < waiter.rpsLimit) {
      state.waiters.splice(waiterIndex, 1);
      state.requestTimestamps.push(now);
      state.lastRequestAt = now;
      waiter.resolve();
      continue;
    }
    scheduleQueueWake(state, stateWaitMs(state, now, waiter.windowMs));
    return;
  }
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
  const pending = pendingCounts(state, now);
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
    ...pending,
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
  const priority = normalizePriority(options.priority);
  const state = rateStateFor(trimmed, label || `Key ${redactHeroSmsKey(trimmed)}`);

  await new Promise<void>((resolve) => {
    state.waiters.push({
      priority,
      requestedAt: Date.now(),
      rpsLimit,
      windowMs,
      resolve,
    });
    processQueue(state);
  });
}

export function resetHeroSmsRpsStatsForTest(): void {
  for (const state of keyRateStates.values()) {
    if (state.wakeTimer) {
      clearTimeout(state.wakeTimer);
      state.wakeTimer = null;
    }
  }
  keyRateStates.clear();
}
