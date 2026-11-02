import type { Clock } from '../src/services/rateLimiter.js';
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
  advance(ms: number): void {
    this.current += ms;
  }
}
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
