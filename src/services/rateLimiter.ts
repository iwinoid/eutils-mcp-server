import { RATE_LIMIT_WITH_KEY, RATE_LIMIT_WITHOUT_KEY } from '../constants.js';
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  constructor(
    readonly ratePerSecond: number,
    private readonly capacity: number = ratePerSecond,
    private readonly clock: Clock = systemClock,
  ) {
    this.tokens = capacity;
    this.lastRefill = clock.now();
  }
  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const now = this.clock.now();
      const elapsedSeconds = Math.max(0, now - this.lastRefill) / 1000;
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.ratePerSecond);
      this.lastRefill = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      const waitMs = Math.max(1, Math.ceil((deficit / this.ratePerSecond) * 1000));
      await sleepWithSignal(this.clock, waitMs, signal);
    }
  }
}
function abortError(): Error {
  const error = new Error('The request was cancelled.');
  error.name = 'AbortError';
  return error;
}
function sleepWithSignal(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return clock.sleep(ms);
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
export function createRateLimiter(apiKey: string | undefined, clock: Clock = systemClock): TokenBucket {
  const rate = apiKey ? RATE_LIMIT_WITH_KEY : RATE_LIMIT_WITHOUT_KEY;
  return new TokenBucket(rate, rate, clock);
}
