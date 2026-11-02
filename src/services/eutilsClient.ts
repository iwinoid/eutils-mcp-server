import {
  ALLOWED_REDIRECT_SUFFIX,
  BASE_URL,
  DEFAULT_TOOL,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  MAX_RETRIES,
  POST_THRESHOLD_UIDS,
  POST_THRESHOLD_URL_LENGTH,
  REQUEST_TIMEOUT_MS,
} from '../constants.js';
import { EUtilsError, type QueryParams } from '../types.js';
import { type Clock, createRateLimiter, systemClock, type TokenBucket } from './rateLimiter.js';
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export interface EUtilsClientOptions {
  apiKey?: string | undefined;
  email?: string | undefined;
  tool?: string | undefined;
  fetchImpl?: FetchLike | undefined;
  limiter?: TokenBucket | undefined;
  clock?: Clock | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
}
export interface EUtilsRequest {
  endpoint: string;
  params: QueryParams;
  method?: 'GET' | 'POST' | undefined;
  accept?: string | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
}
export interface EUtilsResponse {
  status: number;
  contentType: string;
  text: string;
  json?: unknown;
}
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
export function redact(text: string, apiKey?: string | undefined): string {
  let out = text.replace(/([?&]|^)api_key=[^&\s"']*/gi, '$1api_key=***');
  if (apiKey && apiKey.length > 0) {
    out = out.split(apiKey).join('***');
  }
  return out;
}
export function isAllowedHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return parsed.hostname === 'ncbi.nlm.nih.gov' || parsed.hostname.endsWith(ALLOWED_REDIRECT_SUFFIX);
  } catch {
    return false;
  }
}
export function embeddedError(json: unknown): string | undefined {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return undefined;
  const value = (json as Record<string, unknown>)['error'];
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return undefined;
}
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return await response.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new EUtilsError(
          'upstream',
          `NCBI response exceeded the ${Math.round(maxBytes / 1024 / 1024)} MB ceiling and was abandoned.`,
          'Reduce retmax, narrow the query with filters, or fetch fewer UIDs per call.',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}
function cancelledError(): EUtilsError {
  return new EUtilsError(
    'cancelled',
    'The request was cancelled by the client.',
    'No action is needed; the host cancelled this tool call.',
  );
}
function attemptSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
function sleepFor(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return clock.sleep(ms);
  if (signal.aborted) return Promise.reject(cancelledError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(cancelledError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
function backoffMs(attempt: number): number {
  const base = 500 * 2 ** attempt;
  return base + Math.floor(Math.random() * 250);
}
export class EUtilsClient {
  private readonly limiter: TokenBucket;
  private readonly clock: Clock;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  constructor(private readonly options: EUtilsClientOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.limiter = options.limiter ?? createRateLimiter(options.apiKey, this.clock);
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? MAX_RETRIES;
  }
  get ratePerSecond(): number {
    return this.limiter.ratePerSecond;
  }
  get hasApiKey(): boolean {
    return typeof this.options.apiKey === 'string' && this.options.apiKey.length > 0;
  }
  private buildParams(params: QueryParams): URLSearchParams {
    const search = new URLSearchParams();
    search.set('tool', this.options.tool ?? DEFAULT_TOOL);
    if (this.options.email) search.set('email', this.options.email);
    if (this.options.apiKey) search.set('api_key', this.options.apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      search.set(key, String(value));
    }
    return search;
  }
  private chooseMethod(endpoint: string, params: QueryParams, forced?: 'GET' | 'POST'): 'GET' | 'POST' {
    if (forced) return forced;
    const search = this.buildParams(params);
    const urlLength = BASE_URL.length + endpoint.length + 1 + search.toString().length;
    const uidCount = params['id'] ? String(params['id']).split(',').length : 0;
    if (urlLength > POST_THRESHOLD_URL_LENGTH || uidCount > POST_THRESHOLD_UIDS) return 'POST';
    return 'GET';
  }
  private async fetchFollowingRedirects(
    initialUrl: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    let url = initialUrl;
    let response = await this.fetchImpl(url, { ...init, redirect: 'manual' });
    for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get('location');
      if (!location) return response;
      const next = new URL(location, url).toString();
      if (!isAllowedHost(next)) {
        throw new EUtilsError(
          'network',
          `Refused a redirect to a non-NCBI host.`,
          'This is a safety guard. Report it if it blocks a legitimate request.',
        );
      }
      url = next;
      try {
        response = await this.fetchImpl(url, { ...init, redirect: 'manual' });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new EUtilsError(
          'network',
          `NCBI redirected this request to ${new URL(url).host}, which is not reachable from the public internet.`,
          'This is an upstream NCBI problem rather than a local one. Retry later, or use a different E-utilities endpoint.',
        );
      }
    }
    throw new EUtilsError(
      'network',
      `Exceeded ${MAX_REDIRECTS} redirects from NCBI.`,
      'Retry later. If it persists, the endpoint may have moved.',
    );
  }
  async request(req: EUtilsRequest): Promise<EUtilsResponse> {
    const method = this.chooseMethod(req.endpoint, req.params, req.method);
    const search = this.buildParams(req.params);
    const url = BASE_URL + req.endpoint;
    const accept = req.accept ?? 'application/json, text/xml, text/plain, */*';
    const signal = req.signal;
    const timeoutMs = req.timeoutMs ?? this.timeoutMs;
    const maxRetries = req.maxRetries ?? this.maxRetries;
    if (signal?.aborted) throw cancelledError();
    let lastError: EUtilsError | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        await this.limiter.acquire(signal);
      } catch (error) {
        if (signal?.aborted) throw cancelledError();
        throw this.mapThrown(error, signal, timeoutMs);
      }
      if (signal?.aborted) throw cancelledError();
      const init: RequestInit =
        method === 'POST'
          ? {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded', accept },
              body: search.toString(),
              signal: attemptSignal(signal, timeoutMs),
            }
          : {
              method: 'GET',
              headers: { accept },
              signal: attemptSignal(signal, timeoutMs),
            };
      const target = method === 'POST' ? url : url + '?' + search.toString();
      try {
        const response = await this.fetchFollowingRedirects(target, init, signal);
        const contentType = response.headers.get('content-type') ?? '';
        const text = await readCapped(response, MAX_RESPONSE_BYTES);
        if (RETRYABLE_STATUS.has(response.status)) {
          lastError = this.mapStatus(response.status, text);
          if (attempt < maxRetries) {
            await sleepFor(this.clock, backoffMs(attempt), signal);
            continue;
          }
          throw lastError;
        }
        if (response.status === 414) {
          if (method === 'GET') {
            return await this.request({ ...req, method: 'POST' });
          }
          throw new EUtilsError(
            'validation',
            'NCBI rejected the request as too large even over POST.',
            'Split the UID list into chunks of 200 or fewer and retry.',
          );
        }
        if (response.status >= 400) {
          throw this.mapStatus(response.status, text);
        }
        const json = this.tryParseJson(text, contentType);
        const embedded = embeddedError(json);
        if (embedded) {
          throw this.mapEmbeddedError(embedded);
        }
        return { status: response.status, contentType, text, ...(json === undefined ? {} : { json }) };
      } catch (error) {
        if (signal?.aborted) throw cancelledError();
        if (error instanceof EUtilsError) {
          if (error.kind === 'timeout' && attempt < maxRetries) {
            lastError = error;
            await sleepFor(this.clock, backoffMs(attempt), signal);
            continue;
          }
          throw error;
        }
        const mapped = this.mapThrown(error, signal, timeoutMs);
        if (mapped.kind === 'cancelled') throw mapped;
        lastError = mapped;
        if (attempt < maxRetries) {
          await sleepFor(this.clock, backoffMs(attempt), signal);
          continue;
        }
        throw mapped;
      }
    }
    throw lastError ?? new EUtilsError('network', 'Request failed after retries.', 'Retry later.');
  }
  private tryParseJson(text: string, contentType: string): unknown {
    const looksJson = contentType.includes('json') || text.trimStart().startsWith('{');
    if (!looksJson) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }
  private mapStatus(status: number, body: string): EUtilsError {
    if (status === 429) {
      return new EUtilsError(
        'rate_limit',
        'NCBI rate limit exceeded.',
        this.hasApiKey
          ? 'Slow down. Requests are already capped at 10 per second; reduce retmax or wait a few seconds.'
          : 'Wait a few seconds, or set NCBI_API_KEY to raise the ceiling from 3 to 10 requests per second.',
      );
    }
    if (status === 404) {
      return new EUtilsError(
        'not_found',
        'NCBI returned 404 for this request.',
        'Check the database name and UID values.',
      );
    }
    if (status >= 500) {
      return new EUtilsError(
        'upstream',
        `NCBI returned HTTP ${status}.`,
        'This is usually transient. Retry shortly; if it persists the endpoint may be under maintenance.',
      );
    }
    const detail = redact(body.slice(0, 300), this.options.apiKey).trim();
    return new EUtilsError(
      'upstream',
      `NCBI returned HTTP ${status}${detail ? `: ${detail}` : '.'}`,
      'Check the parameter values against eutils_einfo for this database.',
    );
  }
  private mapEmbeddedError(message: string): EUtilsError {
    const clean = redact(message, this.options.apiKey);
    if (/rate limit/i.test(clean)) {
      return new EUtilsError(
        'rate_limit',
        'NCBI reported: API rate limit exceeded.',
        this.hasApiKey
          ? 'Reduce request frequency and retry.'
          : 'Set NCBI_API_KEY to raise the ceiling from 3 to 10 requests per second.',
      );
    }
    if (/invalid|not found|cannot|failed/i.test(clean)) {
      return new EUtilsError(
        'validation',
        `NCBI reported: ${clean}`,
        'Verify the database and UID values, and use eutils_einfo to check field names.',
      );
    }
    return new EUtilsError('upstream', `NCBI reported: ${clean}`, 'Adjust the request and retry.');
  }
  private mapThrown(error: unknown, signal?: AbortSignal, timeoutMs: number = this.timeoutMs): EUtilsError {
    if (signal?.aborted) return cancelledError();
    if (error instanceof Error) {
      if (error.name === 'AbortError') return cancelledError();
      if (error.name === 'TimeoutError') {
        return new EUtilsError(
          'timeout',
          `NCBI did not answer within ${timeoutMs / 1000} seconds.`,
          'Reduce retmax or narrow the query, then retry.',
        );
      }
      return new EUtilsError(
        'network',
        `Could not reach NCBI: ${redact(error.message, this.options.apiKey)}`,
        'Check network connectivity and retry.',
      );
    }
    return new EUtilsError('network', 'Could not reach NCBI.', 'Check network connectivity and retry.');
  }
}
export function createClientFromEnv(overrides: EUtilsClientOptions = {}): EUtilsClient {
  const email = process.env['NCBI_EMAIL'];
  const apiKey = process.env['NCBI_API_KEY'];
  const tool = process.env['NCBI_TOOL'];
  return new EUtilsClient({
    ...(apiKey ? { apiKey } : {}),
    ...(email ? { email } : {}),
    ...(tool ? { tool } : {}),
    ...overrides,
  });
}
