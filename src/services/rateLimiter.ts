import { RATE_LIMIT_WITH_KEY, RATE_LIMIT_WITHOUT_KEY } from '../constants.js';

/** Injectable time source, so rate-limit behaviour is testable without waiting. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Token bucket shared by every outbound request, including internal batches.
 *
 * NCBI allows 3 requests/second per IP without an API key and 10 with one.
 * Exceeding the limit gets the whole IP blocked, so all traffic funnels
 * through a single bucket.
 */
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

  /** Resolve once a token is available, sleeping when the bucket is empty. */
  async acquire(): Promise<void> {
    for (;;) {
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
      await this.clock.sleep(waitMs);
    }
  }
}

/**
 * Build the bucket appropriate to the credentials in play.
 *
 * An API key raises the ceiling from 3 to 10 requests/second.
 */
export function createRateLimiter(apiKey: string | undefined, clock: Clock = systemClock): TokenBucket {
  const rate = apiKey ? RATE_LIMIT_WITH_KEY : RATE_LIMIT_WITHOUT_KEY;
  return new TokenBucket(rate, rate, clock);
}
