import { describe, expect, it } from 'vitest';
import { EUtilsError } from '../src/types.js';
import { createHarness, json, text } from './toolHarness.js';
function networkFailure(): never {
  throw new EUtilsError('network', 'EGQuery redirected', 'Retry later.');
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
function einfoBody(): unknown {
  return {
    einforesult: {
      dbinfo: [
        {
          dbname: 'pubmed',
          menuname: 'PubMed',
          description: 'PubMed bibliographic record',
          dbbuild: 'Build-2026.09.10.13.11',
          count: '41133096',
          lastupdate: '2026/09/10 13:11',
          fieldlist: [
            {
              name: 'ALL',
              fullname: 'All Fields',
              description: 'All terms from all searchable fields',
              termcount: '',
              istruncatable: 'Y',
              israngable: 'Y',
            },
            {
              name: 'UID',
              fullname: 'UID',
              description: 'Unique number assigned to publication',
              termcount: '',
              istruncatable: 'N',
              israngable: 'N',
            },
            { name: 'TITL', fullname: 'Title', description: 'Words in title of publication' },
          ],
          linklist: [],
        },
      ],
    },
  };
}
describe('EInfo version 2.0 field flags', () => {
  it('sends version=2.0 and parses the new flags', async () => {
    const harness = createHarness(() => json(einfoBody()));
    const result = await harness.call('eutils_einfo', {
      db: 'pubmed',
      version: '2.0',
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.params['version']).toBe('2.0');
    expect(result.structuredContent.fields[0]).toMatchObject({
      is_truncatable: true,
      is_rangeable: true,
    });
    expect(result.structuredContent.fields[1]).toMatchObject({
      is_truncatable: false,
      is_rangeable: false,
    });
    expect(result.structuredContent.fields[2].is_truncatable).toBeUndefined();
    expect(result.structuredContent.fields[2].is_rangeable).toBeUndefined();
  });
  it('omits version by default', async () => {
    const harness = createHarness(() => json(einfoBody()));
    await harness.call('eutils_einfo', { db: 'pubmed', response_format: 'json' });
    expect(harness.calls[0]?.params['version']).toBeUndefined();
  });
  it('rejects an unknown database without a request', async () => {
    const harness = createHarness(() => json(einfoBody()));
    const result = await harness.call('eutils_einfo', { db: 'notarealdb', response_format: 'json' });
    expect(result.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });
});
