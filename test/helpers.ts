import type { Clock } from '../src/services/rateLimiter.js';

/**
 * Clock that advances only when something sleeps.
 *
 * Lets rate-limit tests assert exact wait behaviour without real delays.
 */
export class FakeClock implements Clock {
  private current = 0;
  readonly sleeps: number[] = [];

  now(): number {
    return this.current;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.current += ms;
  }

  /** Move time forward without sleeping, to simulate idle gaps. */
  advance(ms: number): void {
    this.current += ms;
  }
}

/** Collect the URLs and init objects a mocked fetch receives. */
export interface RecordedCall {
  url: string;
  init: RequestInit;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function textResponse(body: string, status = 200, contentType = 'text/plain'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

export function redirectResponse(location: string, status = 301): Response {
  return new Response(null, { status, headers: { location } });
}
