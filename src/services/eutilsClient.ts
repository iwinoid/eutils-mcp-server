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
import { EutilsError, type QueryParams } from '../types.js';
import { type Clock, createRateLimiter, systemClock, type TokenBucket } from './rateLimiter.js';

/** Minimal fetch shape, injected so tests never touch the network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface EutilsClientOptions {
  apiKey?: string | undefined;
  email?: string | undefined;
  tool?: string | undefined;
  fetchImpl?: FetchLike | undefined;
  limiter?: TokenBucket | undefined;
  clock?: Clock | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
}

export interface EutilsRequest {
  /** Endpoint file name, for example `esearch.fcgi`. */
  endpoint: string;
  params: QueryParams;
  /** Force a verb. Left unset, the client picks based on payload size. */
  method?: 'GET' | 'POST' | undefined;
  /** Value for the `Accept` header. */
  accept?: string | undefined;
}

export interface EutilsResponse {
  status: number;
  contentType: string;
  text: string;
  /** Present only when the response body parsed as JSON. */
  json?: unknown;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Strip the API key from anything that could be logged or returned. */
export function redact(text: string, apiKey?: string | undefined): string {
  let out = text.replace(/([?&]|^)api_key=[^&\s"']*/gi, '$1api_key=***');
  if (apiKey && apiKey.length > 0) {
    out = out.split(apiKey).join('***');
  }
  return out;
}

/** True when `url` points at an NCBI host we are willing to follow. */
export function isAllowedHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return parsed.hostname === 'ncbi.nlm.nih.gov' || parsed.hostname.endsWith(ALLOWED_REDIRECT_SUFFIX);
  } catch {
    return false;
  }
}

/**
 * Detect an error delivered inside an HTTP 200 body.
 *
 * NCBI signals rate limiting this way: `{"error":"API rate limit exceeded"}`.
 * The status code alone is not enough.
 */
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
        throw new EutilsError(
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

function sleepWithClock(clock: Clock, ms: number): Promise<void> {
  return clock.sleep(ms);
}

function backoffMs(attempt: number): number {
  const base = 500 * 2 ** attempt;
  return base + Math.floor(Math.random() * 250);
}

/**
 * The single egress point for every E-utilities call.
 *
 * Owns URL construction, GET/POST selection, redirect validation, rate
 * limiting, retries, size limits, and credential redaction. No tool may
 * build a request without it.
 */
export class EutilsClient {
  private readonly limiter: TokenBucket;
  private readonly clock: Clock;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly options: EutilsClientOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.limiter = options.limiter ?? createRateLimiter(options.apiKey, this.clock);
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? MAX_RETRIES;
  }

  /** Requests per second this client is allowed to issue. */
  get ratePerSecond(): number {
    return this.limiter.ratePerSecond;
  }

  /** True when an API key is configured, so callers can size batches accordingly. */
  get hasApiKey(): boolean {
    return typeof this.options.apiKey === 'string' && this.options.apiKey.length > 0;
  }

  /** Build the full parameter set, adding credentials and identity. */
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

  /**
   * Choose GET or POST.
   *
   * GET is used while the request stays small. Long UID lists overflow the
   * URL, which NCBI answers with HTTP 414, so they are sent as a form body.
   */
  private chooseMethod(endpoint: string, params: QueryParams, forced?: 'GET' | 'POST'): 'GET' | 'POST' {
    if (forced) return forced;
    const search = this.buildParams(params);
    const urlLength = BASE_URL.length + endpoint.length + 1 + search.toString().length;
    const uidCount = params['id'] ? String(params['id']).split(',').length : 0;
    if (urlLength > POST_THRESHOLD_URL_LENGTH || uidCount > POST_THRESHOLD_UIDS) return 'POST';
    return 'GET';
  }

  /** Follow redirects manually, validating every hop's host. */
  private async fetchFollowingRedirects(initialUrl: string, init: RequestInit): Promise<Response> {
    let url = initialUrl;
    let response = await this.fetchImpl(url, { ...init, redirect: 'manual' });

    for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
      if (response.status < 300 || response.status >= 400) return response;

      const location = response.headers.get('location');
      if (!location) return response;

      const next = new URL(location, url).toString();
      if (!isAllowedHost(next)) {
        throw new EutilsError(
          'network',
          `Refused a redirect to a non-NCBI host.`,
          'This is a safety guard. Report it if it blocks a legitimate request.',
        );
      }
      url = next;
      try {
        response = await this.fetchImpl(url, { ...init, redirect: 'manual' });
      } catch {
        // NCBI's EGQuery endpoint currently 301s to an internal
        // service-mesh host that is absent from public DNS. Name it, so the
        // caller can degrade instead of reporting a bare "fetch failed".
        throw new EutilsError(
          'network',
          `NCBI redirected this request to ${new URL(url).host}, which is not reachable from the public internet.`,
          'This is an upstream NCBI problem rather than a local one. Retry later, or use a different E-utilities endpoint.',
        );
      }
    }

    throw new EutilsError(
      'network',
      `Exceeded ${MAX_REDIRECTS} redirects from NCBI.`,
      'Retry later. If it persists, the endpoint may have moved.',
    );
  }

  /** Perform one logical E-utilities request, with rate limiting and retries. */
  async request(req: EutilsRequest): Promise<EutilsResponse> {
    const method = this.chooseMethod(req.endpoint, req.params, req.method);
    const search = this.buildParams(req.params);
    const url = `${BASE_URL}${req.endpoint}`;
    const accept = req.accept ?? 'application/json, text/xml, text/plain, */*';

    let lastError: EutilsError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await this.limiter.acquire();

      const init: RequestInit =
        method === 'POST'
          ? {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded', accept },
              body: search.toString(),
              signal: AbortSignal.timeout(this.timeoutMs),
            }
          : {
              method: 'GET',
              headers: { accept },
              signal: AbortSignal.timeout(this.timeoutMs),
            };

      const target = method === 'POST' ? url : `${url}?${search.toString()}`;

      try {
        const response = await this.fetchFollowingRedirects(target, init);
        const contentType = response.headers.get('content-type') ?? '';
        const text = await readCapped(response, MAX_RESPONSE_BYTES);

        if (RETRYABLE_STATUS.has(response.status)) {
          lastError = this.mapStatus(response.status, text);
          if (attempt < this.maxRetries) {
            await sleepWithClock(this.clock, backoffMs(attempt));
            continue;
          }
          throw lastError;
        }

        if (response.status === 414) {
          // URL too long: re-issue the same request as a form POST.
          if (method === 'GET') {
            return await this.request({ ...req, method: 'POST' });
          }
          throw new EutilsError(
            'validation',
            'NCBI rejected the request as too large even over POST.',
            `Split the UID list into chunks of ${200} or fewer and retry.`,
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
        if (error instanceof EutilsError) {
          if (error.kind === 'timeout' && attempt < this.maxRetries) {
            lastError = error;
            await sleepWithClock(this.clock, backoffMs(attempt));
            continue;
          }
          throw error;
        }
        const mapped = this.mapThrown(error);
        lastError = mapped;
        if (attempt < this.maxRetries) {
          await sleepWithClock(this.clock, backoffMs(attempt));
          continue;
        }
        throw mapped;
      }
    }

    throw lastError ?? new EutilsError('network', 'Request failed after retries.', 'Retry later.');
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

  private mapStatus(status: number, body: string): EutilsError {
    if (status === 429) {
      return new EutilsError(
        'rate_limit',
        'NCBI rate limit exceeded.',
        this.hasApiKey
          ? 'Slow down. Requests are already capped at 10 per second; reduce retmax or wait a few seconds.'
          : 'Wait a few seconds, or set NCBI_API_KEY to raise the ceiling from 3 to 10 requests per second.',
      );
    }
    if (status === 404) {
      return new EutilsError(
        'not_found',
        'NCBI returned 404 for this request.',
        'Check the database name and UID values.',
      );
    }
    if (status >= 500) {
      return new EutilsError(
        'upstream',
        `NCBI returned HTTP ${status}.`,
        'This is usually transient. Retry shortly; if it persists the endpoint may be under maintenance.',
      );
    }
    const detail = redact(body.slice(0, 300), this.options.apiKey).trim();
    return new EutilsError(
      'upstream',
      `NCBI returned HTTP ${status}${detail ? `: ${detail}` : '.'}`,
      'Check the parameter values against eutils_einfo for this database.',
    );
  }

  private mapEmbeddedError(message: string): EutilsError {
    const clean = redact(message, this.options.apiKey);
    if (/rate limit/i.test(clean)) {
      return new EutilsError(
        'rate_limit',
        'NCBI reported: API rate limit exceeded.',
        this.hasApiKey
          ? 'Reduce request frequency and retry.'
          : 'Set NCBI_API_KEY to raise the ceiling from 3 to 10 requests per second.',
      );
    }
    if (/invalid|not found|cannot|failed/i.test(clean)) {
      return new EutilsError(
        'validation',
        `NCBI reported: ${clean}`,
        'Verify the database and UID values, and use eutils_einfo to check field names.',
      );
    }
    return new EutilsError('upstream', `NCBI reported: ${clean}`, 'Adjust the request and retry.');
  }

  private mapThrown(error: unknown): EutilsError {
    if (error instanceof Error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        return new EutilsError(
          'timeout',
          `NCBI did not answer within ${this.timeoutMs / 1000} seconds.`,
          'Reduce retmax or narrow the query, then retry.',
        );
      }
      return new EutilsError(
        'network',
        `Could not reach NCBI: ${redact(error.message, this.options.apiKey)}`,
        'Check network connectivity and retry.',
      );
    }
    return new EutilsError('network', 'Could not reach NCBI.', 'Check network connectivity and retry.');
  }
}

/** Build a client from environment variables, warning when identity is missing. */
export function createClientFromEnv(overrides: EutilsClientOptions = {}): EutilsClient {
  const email = process.env['NCBI_EMAIL'];
  const apiKey = process.env['NCBI_API_KEY'];
  const tool = process.env['NCBI_TOOL'];

  return new EutilsClient({
    ...(apiKey ? { apiKey } : {}),
    ...(email ? { email } : {}),
    ...(tool ? { tool } : {}),
    ...overrides,
  });
}
