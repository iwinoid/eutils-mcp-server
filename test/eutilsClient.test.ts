import { describe, expect, it } from 'vitest';
import {
  EutilsClient,
  embeddedError,
  isAllowedHost,
  redact,
  type FetchLike,
} from '../src/services/eutilsClient.js';
import { TokenBucket } from '../src/services/rateLimiter.js';
import { EutilsError } from '../src/types.js';
import { FakeClock, jsonResponse, redirectResponse, textResponse, type RecordedCall } from './helpers.js';

/** Client wired to a scripted fetch, with a fake clock so retries are instant. */
function makeClient(
  handler: (url: string, init: RequestInit, call: number) => Promise<Response>,
  overrides: { apiKey?: string; email?: string; maxRetries?: number } = {},
): { client: EutilsClient; calls: RecordedCall[] } {
  const clock = new FakeClock();
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  const client = new EutilsClient({
    ...overrides,
    fetchImpl,
    clock,
    limiter: new TokenBucket(1000, 1000, clock),
  });
  return { client, calls };
}

describe('redact', () => {
  it('masks api_key in a query string', () => {
    expect(redact('https://x/y?db=pubmed&api_key=SECRET123&x=1')).not.toContain('SECRET123');
  });

  it('masks a bare occurrence of the key', () => {
    expect(redact('failure with SECRET123 inside', 'SECRET123')).toBe('failure with *** inside');
  });

  it('leaves text without a key alone', () => {
    expect(redact('nothing to hide')).toBe('nothing to hide');
  });
});

describe('isAllowedHost', () => {
  it('accepts the primary eutils host', () => {
    expect(isAllowedHost('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi')).toBe(true);
  });

  it('accepts the redirect host egquery actually uses', () => {
    expect(isAllowedHost('https://ext-http-eutils.linkerd.ncbi.nlm.nih.gov/gquery')).toBe(true);
  });

  it('rejects an unrelated host', () => {
    expect(isAllowedHost('https://evil.example.com/steal')).toBe(false);
  });

  it('rejects a lookalike suffix', () => {
    expect(isAllowedHost('https://ncbi.nlm.nih.gov.evil.com/')).toBe(false);
  });

  it('rejects plain http', () => {
    expect(isAllowedHost('http://eutils.ncbi.nlm.nih.gov/')).toBe(false);
  });

  it('rejects a malformed url', () => {
    expect(isAllowedHost('not a url')).toBe(false);
  });
});

describe('embeddedError', () => {
  it('detects the rate-limit body NCBI returns with HTTP 200', () => {
    expect(embeddedError({ error: 'API rate limit exceeded', count: '11' })).toBe('API rate limit exceeded');
  });

  it('ignores a normal payload', () => {
    expect(embeddedError({ esearchresult: { count: '1' } })).toBeUndefined();
  });

  it('ignores a blank error field', () => {
    expect(embeddedError({ error: '   ' })).toBeUndefined();
  });

  it('ignores non-objects', () => {
    expect(embeddedError('nope')).toBeUndefined();
    expect(embeddedError(null)).toBeUndefined();
  });
});

describe('EutilsClient request building', () => {
  it('sends tool, email, and api_key on every request', async () => {
    const { client, calls } = makeClient(async () => jsonResponse({ ok: true }), {
      apiKey: 'KEY1',
      email: 'dev@example.com',
    });

    await client.request({ endpoint: 'esearch.fcgi', params: { db: 'pubmed', term: 'cancer' } });

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('tool')).toBe('eutils-mcp-server');
    expect(url.searchParams.get('email')).toBe('dev@example.com');
    expect(url.searchParams.get('api_key')).toBe('KEY1');
    expect(url.searchParams.get('db')).toBe('pubmed');
  });

  it('omits email and api_key when they are not configured', async () => {
    const { client, calls } = makeClient(async () => jsonResponse({ ok: true }));

    await client.request({ endpoint: 'esearch.fcgi', params: { db: 'pubmed', term: 'x' } });

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.has('email')).toBe(false);
    expect(url.searchParams.has('api_key')).toBe(false);
  });

  it('encodes a query containing spaces and brackets', async () => {
    const { client, calls } = makeClient(async () => jsonResponse({ ok: true }));

    await client.request({
      endpoint: 'esearch.fcgi',
      params: { db: 'pubmed', term: 'mouse[orgn] AND cancer' },
    });

    expect(new URL(calls[0]!.url).searchParams.get('term')).toBe('mouse[orgn] AND cancer');
  });

  it('uses GET for a small request', async () => {
    const { client, calls } = makeClient(async () => jsonResponse({ ok: true }));
    await client.request({ endpoint: 'esearch.fcgi', params: { db: 'pubmed', term: 'x' } });
    expect(calls[0]!.init.method).toBe('GET');
  });

  it('switches to POST for a long UID list', async () => {
    const { client, calls } = makeClient(async () => jsonResponse({ ok: true }));
    const ids = Array.from({ length: 300 }, (_, i) => String(i + 1)).join(',');

    await client.request({ endpoint: 'esummary.fcgi', params: { db: 'pubmed', id: ids } });

    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.url).not.toContain('?');
    expect(String(calls[0]!.init.body)).toContain('id=');
  });

  it('retries a 414 as a POST without consuming a retry', async () => {
    const { client, calls } = makeClient(async (_url, init) =>
      init.method === 'POST' ? jsonResponse({ ok: true }) : textResponse('too long', 414),
    );

    const result = await client.request({ endpoint: 'esummary.fcgi', params: { db: 'pubmed', id: '1,2' } });

    expect(calls).toHaveLength(2);
    expect(calls[1]!.init.method).toBe('POST');
    expect(result.status).toBe(200);
  });

  it('parses a JSON body when the content type says json', async () => {
    const { client } = makeClient(async () => jsonResponse({ esearchresult: { count: '5' } }));
    const result = await client.request({ endpoint: 'esearch.fcgi', params: { db: 'pubmed', term: 'x' } });
    expect(result.json).toEqual({ esearchresult: { count: '5' } });
  });

  it('leaves json undefined for a plain-text body', async () => {
    const { client } = makeClient(async () => textResponse('>NP_005537.3 protein'));
    const result = await client.request({ endpoint: 'efetch.fcgi', params: { db: 'protein', id: '1' } });
    expect(result.json).toBeUndefined();
    expect(result.text).toContain('NP_005537.3');
  });
});

describe('EutilsClient redirects', () => {
  it('follows the egquery redirect to the second NCBI host', async () => {
    const { client, calls } = makeClient(async (_url, _init, call) =>
      call === 1
        ? redirectResponse('https://ext-http-eutils.linkerd.ncbi.nlm.nih.gov/gquery?term=x')
        : textResponse('<eGQueryResult/>', 200, 'text/xml'),
    );

    const result = await client.request({ endpoint: 'egquery.fcgi', params: { term: 'x' } });

    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain('ext-http-eutils.linkerd.ncbi.nlm.nih.gov');
    expect(result.status).toBe(200);
  });

  it('refuses a redirect to a non-NCBI host', async () => {
    const { client, calls } = makeClient(async () => redirectResponse('https://evil.example.com/steal'));

    await expect(client.request({ endpoint: 'egquery.fcgi', params: { term: 'x' } })).rejects.toBeInstanceOf(
      EutilsError,
    );

    expect(calls).toHaveLength(1);
  });
});

describe('EutilsClient errors', () => {
  it('treats an HTTP 200 carrying an error body as a failure', async () => {
    const { client } = makeClient(async () =>
      jsonResponse({ error: 'API rate limit exceeded', count: '11' }, 200),
    );

    await expect(
      client.request({ endpoint: 'esearch.fcgi', params: { db: 'pubmed', term: 'x' } }),
    ).rejects.toMatchObject({ kind: 'rate_limit' });
  });

  it('retries a 429 and then reports rate_limit', async () => {
    const { client, calls } = makeClient(async () => textResponse('slow down', 429), { maxRetries: 2 });

    await expect(
      client.request({ endpoint: 'esearch.fcgi', params: { db: 'pubmed', term: 'x' } }),
    ).rejects.toMatchObject({ kind: 'rate_limit' });

    expect(calls).toHaveLength(3);
  });

  it('retries a 503 and succeeds on the next attempt', async () => {
    const { client, calls } = makeClient(async (_url, _init, call) =>
      call === 1 ? textResponse('unavailable', 503) : jsonResponse({ ok: true }),
    );

    const result = await client.request({ endpoint: 'esearch.fcgi', params: { db: 'pubmed', term: 'x' } });

    expect(calls).toHaveLength(2);
    expect(result.status).toBe(200);
  });

  it('does not retry a 400', async () => {
    const { client, calls } = makeClient(async () => textResponse('bad request', 400));

    await expect(
      client.request({ endpoint: 'esearch.fcgi', params: { db: 'pubmed', term: 'x' } }),
    ).rejects.toBeInstanceOf(EutilsError);

    expect(calls).toHaveLength(1);
  });

  it('never leaks the API key through an error message', async () => {
    const { client } = makeClient(async () => textResponse('rejected api_key=SECRET123', 400), {
      apiKey: 'SECRET123',
    });

    try {
      await client.request({ endpoint: 'esearch.fcgi', params: { db: 'pubmed', term: 'x' } });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain('SECRET123');
      expect((error as Error).message).toContain('***');
    }
  });

  it('maps a network failure to a network error', async () => {
    const { client } = makeClient(
      async () => {
        throw new TypeError('fetch failed');
      },
      { maxRetries: 0 },
    );

    await expect(
      client.request({ endpoint: 'esearch.fcgi', params: { db: 'pubmed', term: 'x' } }),
    ).rejects.toMatchObject({ kind: 'network' });
  });

  it('maps a timeout to a timeout error', async () => {
    const { client } = makeClient(
      async () => {
        const error = new Error('timed out');
        error.name = 'TimeoutError';
        throw error;
      },
      { maxRetries: 0 },
    );

    await expect(
      client.request({ endpoint: 'esearch.fcgi', params: { db: 'pubmed', term: 'x' } }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('abandons a response larger than the ceiling', async () => {
    const huge = 'x'.repeat(6 * 1024 * 1024);
    const { client } = makeClient(async () => textResponse(huge), { maxRetries: 0 });

    await expect(
      client.request({ endpoint: 'efetch.fcgi', params: { db: 'protein', id: '1' } }),
    ).rejects.toMatchObject({ kind: 'upstream' });
  });
});

describe('EutilsClient capabilities', () => {
  it('reports the rate ceiling implied by the credentials', () => {
    const clock = new FakeClock();
    const bare = new EutilsClient({ clock, limiter: new TokenBucket(3, 3, clock) });
    const keyed = new EutilsClient({ apiKey: 'k', clock, limiter: new TokenBucket(10, 10, clock) });

    expect(bare.ratePerSecond).toBe(3);
    expect(bare.hasApiKey).toBe(false);
    expect(keyed.ratePerSecond).toBe(10);
    expect(keyed.hasApiKey).toBe(true);
  });

  it('rate limits every attempt, including retries', async () => {
    const clock = new FakeClock();
    const calls: number[] = [];
    const fetchImpl: FetchLike = async () => {
      calls.push(clock.now());
      return calls.length === 1 ? textResponse('retry', 503) : jsonResponse({ ok: true });
    };
    const client = new EutilsClient({
      fetchImpl,
      clock,
      limiter: new TokenBucket(3, 1, clock),
      maxRetries: 1,
    });

    await client.request({ endpoint: 'esearch.fcgi', params: { db: 'pubmed', term: 'x' } });

    // The first call consumes the only token; the retry must wait for a refill.
    expect(calls).toHaveLength(2);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(334);
  });
});
