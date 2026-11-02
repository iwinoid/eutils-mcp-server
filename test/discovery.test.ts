import { describe, expect, it } from 'vitest';
import { EutilsError } from '../src/types.js';
import { createHarness, json, text } from './toolHarness.js';

function networkFailure(): never {
  throw new EutilsError('network', 'EGQuery redirected', 'Retry later.');
}

describe('EGQuery fallback accounting', () => {
  it('separates failed databases from databases with no matches', async () => {
    const harness = createHarness((req) => {
      if (req.endpoint === 'egquery.fcgi') return networkFailure();
      if (req.params['db'] === 'pubmed') return json({ esearchresult: { count: '5' } });
      return networkFailure();
    });

    const result = await harness.call('eutils_egquery', { term: 'cancer', response_format: 'json' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.degraded).toBe(true);
    expect(result.structuredContent.databases_searched).toBe(1);
    expect(result.structuredContent.databases_with_hits).toBe(1);
    expect(result.structuredContent.hits.map((entry: { db: string }) => entry.db)).toEqual(['pubmed']);
    expect(result.structuredContent.empty_databases).toEqual([]);
    expect(result.structuredContent.failed_databases).toHaveLength(11);
  });

  it('fails the tool when every fallback database fails', async () => {
    const harness = createHarness((req) => {
      if (req.endpoint === 'egquery.fcgi') return networkFailure();
      return networkFailure();
    });

    const result = await harness.call('eutils_egquery', { term: 'cancer', response_format: 'json' });
    expect(result.isError).toBe(true);
    expect(String(result.content[0]?.text)).toContain('EGQuery');
  });

  it('degrades when the real EGQuery returns a valid but empty XML body', async () => {
    const harness = createHarness((req) => {
      if (req.endpoint === 'egquery.fcgi') return text('<eGQueryResult/>', 200, 'text/xml');
      return networkFailure();
    });

    const result = await harness.call('eutils_egquery', { term: 'cancer', response_format: 'json' });
    expect(result.isError).toBe(true);
  });
});
