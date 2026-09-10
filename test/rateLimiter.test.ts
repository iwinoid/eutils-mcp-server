import { describe, expect, it } from 'vitest';
import { createRateLimiter, TokenBucket } from '../src/services/rateLimiter.js';
import { FakeClock } from './helpers.js';

describe('TokenBucket', () => {
  it('serves the initial burst without sleeping', async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(3, 3, clock);

    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();

    expect(clock.sleeps).toEqual([]);
  });

  it('waits for a refill once the burst is spent', async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(3, 3, clock);

    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();

    // One token at 3/s costs 334ms (ceil of 1000/3).
    expect(clock.sleeps).toEqual([334]);
    expect(clock.now()).toBe(334);
  });

  it('does not sleep when time passed between calls', async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(3, 3, clock);

    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();

    clock.advance(1000);
    await bucket.acquire();

    expect(clock.sleeps).toEqual([]);
  });

  it('never exceeds the burst capacity after a long idle period', async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(3, 3, clock);

    clock.advance(60_000);
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();

    expect(clock.sleeps).toHaveLength(1);
  });
});

describe('createRateLimiter', () => {
  it('allows 3 requests per second without an API key', () => {
    expect(createRateLimiter(undefined, new FakeClock()).ratePerSecond).toBe(3);
  });

  it('allows 10 requests per second with an API key', () => {
    expect(createRateLimiter('abc123', new FakeClock()).ratePerSecond).toBe(10);
  });

  it('treats an empty API key as absent', () => {
    expect(createRateLimiter('', new FakeClock()).ratePerSecond).toBe(3);
  });
});
