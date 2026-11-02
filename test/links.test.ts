import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createHarness, json, text } from './toolHarness.js';
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const loadJson = (name: string): unknown => JSON.parse(readFileSync(join(fixtures, name), 'utf8'));
describe('ELink defaults', () => {
  it('reports stored link groups separately from linked UID totals', async () => {
    const harness = createHarness(() =>
      json({
        linksets: [
          {
            linksetdbhistories: [{ dbto: 'pmc', linkname: 'pubmed_pmc_refs', querykey: '5' }],
            webenv: 'MCID_Y',
          },
        ],
      }),
    );
    const result = await harness.call('eutils_elink', {
      dbfrom: 'pubmed',
      db: 'pmc',
      uids: ['31452104'],
      cmd: 'neighbor_history',
      response_format: 'json',
    });
    expect(result.structuredContent.total_linked).toBe(0);
    expect(result.structuredContent.stored_groups).toBe(1);
    expect(result.structuredContent.histories).toHaveLength(1);
  });
  it('rejects a citation list over the per-call ceiling before any request', async () => {
    const harness = createHarness(() => json({}));
    const citations = Array.from({ length: 201 }, (_, index) => 'journal|2000|1|1|author|K' + index + '|');
    const result = await harness.call('eutils_ecitmatch', { citations, response_format: 'json' });
    expect(result.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });
  it('sends db=dbfrom when db is omitted, so it checks the same database', async () => {
    const harness = createHarness(() => json({ linksets: [] }));
    const result = await harness.call('eutils_elink', {
      dbfrom: 'gene',
      uids: ['7173'],
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]!.params['db']).toBe('gene');
    expect(harness.calls[0]!.params['dbfrom']).toBe('gene');
  });
});
describe('ELink command policy', () => {
  it('sends no db for acheck when db is omitted', async () => {
    const harness = createHarness(() => json(loadJson('elink-acheck.json')));
    const result = await harness.call('eutils_elink', {
      dbfrom: 'protein',
      uids: ['15718680'],
      cmd: 'acheck',
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]!.params['db']).toBeUndefined();
    expect(harness.calls[0]!.params['dbfrom']).toBe('protein');
    expect(harness.calls[0]!.params['cmd']).toBe('acheck');
  });
  it('sends db as the acheck target filter when it is given', async () => {
    const harness = createHarness(() => json(loadJson('elink-acheck.json')));
    await harness.call('eutils_elink', {
      dbfrom: 'protein',
      db: 'cdd',
      uids: ['15718680'],
      cmd: 'acheck',
      response_format: 'json',
    });
    expect(harness.calls[0]!.params['db']).toBe('cdd');
  });
  it('sends no db for lcheck and parses the checks', async () => {
    const harness = createHarness(() => json(loadJson('elink-lcheck.json')));
    const result = await harness.call('eutils_elink', {
      dbfrom: 'protein',
      uids: ['15718680', '157427902'],
      cmd: 'lcheck',
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    expect(harness.calls[0]!.params).not.toHaveProperty('db');
    expect(result.structuredContent.link_checks).toHaveLength(2);
  });
  it('rejects db on lcheck before any request', async () => {
    const harness = createHarness(() => json({ linksets: [] }));
    const result = await harness.call('eutils_elink', {
      dbfrom: 'protein',
      db: 'pubmed',
      uids: ['15718680'],
      cmd: 'lcheck',
    });
    expect(result.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });
  it('accepts db=dbfrom on ncheck but does not send it', async () => {
    const harness = createHarness(() => json(loadJson('elink-ncheck.json')));
    const result = await harness.call('eutils_elink', {
      dbfrom: 'nuccore',
      db: 'nuccore',
      uids: ['21614549'],
      cmd: 'ncheck',
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    expect(harness.calls[0]!.params).not.toHaveProperty('db');
    expect(result.structuredContent.link_checks).toHaveLength(2);
    expect(result.structuredContent.link_checks[0].has_neighbor).toBe(true);
  });
  it('rejects a different db on ncheck before any request', async () => {
    const harness = createHarness(() => json({ linksets: [] }));
    const result = await harness.call('eutils_elink', {
      dbfrom: 'nuccore',
      db: 'protein',
      uids: ['21614549'],
      cmd: 'ncheck',
    });
    expect(result.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });
  it('sends no db for llinks or prlinks and parses provider URLs', async () => {
    const llinks = createHarness(() => json(loadJson('elink-llinks.json')));
    const llinksResult = await llinks.call('eutils_elink', {
      dbfrom: 'pubmed',
      uids: ['19880848'],
      cmd: 'llinks',
      response_format: 'json',
    });
    expect(llinksResult.isError).toBeFalsy();
    expect(llinks.calls[0]!.params).not.toHaveProperty('db');
    expect(llinksResult.structuredContent.provider_links).toHaveLength(1);
    const prlinks = createHarness(() => json(loadJson('elink-prlinks.json')));
    const prlinksResult = await prlinks.call('eutils_elink', {
      dbfrom: 'pubmed',
      uids: ['19880848'],
      cmd: 'prlinks',
      response_format: 'json',
    });
    expect(prlinksResult.isError).toBeFalsy();
    expect(prlinks.calls[0]!.params).not.toHaveProperty('db');
    expect(prlinksResult.structuredContent.provider_links[0].urls[0].provider_abbr).toBe('PMC');
  });
  it('rejects db on llinks and prlinks before any request', async () => {
    for (const cmd of ['llinks', 'prlinks']) {
      const harness = createHarness(() => json({ linksets: [] }));
      const result = await harness.call('eutils_elink', {
        dbfrom: 'pubmed',
        db: 'pmc',
        uids: ['19880848'],
        cmd,
      });
      expect(result.isError).toBe(true);
      expect(harness.calls).toHaveLength(0);
    }
  });
  it('sends linkname with a neighbor command', async () => {
    const harness = createHarness(() => json(loadJson('elink-links.json')));
    const result = await harness.call('eutils_elink', {
      dbfrom: 'pubmed',
      uids: ['31452104'],
      linkname: 'pubmed_pmc_refs',
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    expect(harness.calls[0]!.params['linkname']).toBe('pubmed_pmc_refs');
  });
  it('rejects linkname for acheck before any request', async () => {
    const harness = createHarness(() => json({ linksets: [] }));
    const result = await harness.call('eutils_elink', {
      dbfrom: 'pubmed',
      uids: ['19880848'],
      cmd: 'acheck',
      linkname: 'pubmed_pmc',
    });
    expect(result.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });
  it('rejects an invalid linkname before any request', async () => {
    const harness = createHarness(() => json({ linksets: [] }));
    const result = await harness.call('eutils_elink', {
      dbfrom: 'pubmed',
      uids: ['1'],
      linkname: 'pubmed_pmc&db=evil',
    });
    expect(result.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });
  it('sends term for a same-database neighbor_score', async () => {
    const harness = createHarness(() => json(loadJson('elink-neighbor-score.json')));
    const result = await harness.call('eutils_elink', {
      dbfrom: 'pubmed',
      uids: ['20210808'],
      cmd: 'neighbor_score',
      term: 'review[filter]',
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    expect(harness.calls[0]!.params['term']).toBe('review[filter]');
    expect(harness.calls[0]!.params['db']).toBe('pubmed');
  });
  it('rejects term when the explicit db crosses databases', async () => {
    const harness = createHarness(() => json({ linksets: [] }));
    const result = await harness.call('eutils_elink', {
      dbfrom: 'pubmed',
      db: 'pmc',
      uids: ['20210808'],
      term: 'review[filter]',
    });
    expect(result.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });
  it('rejects term for acheck before any request', async () => {
    const harness = createHarness(() => json({ linksets: [] }));
    const result = await harness.call('eutils_elink', {
      dbfrom: 'pubmed',
      uids: ['19880848'],
      cmd: 'acheck',
      term: 'review[filter]',
    });
    expect(result.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });
  it('sends holding only for llinks', async () => {
    const harness = createHarness(() => json(loadJson('elink-llinks.json')));
    const result = await harness.call('eutils_elink', {
      dbfrom: 'pubmed',
      uids: ['19880848'],
      cmd: 'llinks',
      holding: 'CTgov',
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    expect(harness.calls[0]!.params['holding']).toBe('CTgov');
  });
  it('rejects holding outside llinks before any request', async () => {
    const harness = createHarness(() => json({ linksets: [] }));
    const result = await harness.call('eutils_elink', {
      dbfrom: 'pubmed',
      uids: ['19880848'],
      holding: 'CTgov',
    });
    expect(result.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });
  it('sends idtype=acc and rejects other values before any request', async () => {
    const harness = createHarness(() => json(loadJson('elink-links.json')));
    const accepted = await harness.call('eutils_elink', {
      dbfrom: 'protein',
      uids: ['15718680'],
      idtype: 'acc',
      response_format: 'json',
    });
    expect(accepted.isError).toBeFalsy();
    expect(harness.calls[0]!.params['idtype']).toBe('acc');
    const rejectedHarness = createHarness(() => json({ linksets: [] }));
    const rejected = await rejectedHarness.call('eutils_elink', {
      dbfrom: 'protein',
      uids: ['15718680'],
      idtype: 'gi',
    });
    expect(rejected.isError).toBe(true);
    expect(rejectedHarness.calls).toHaveLength(0);
  });
  it('rejects neighbor_score with a different explicit db before any request', async () => {
    const harness = createHarness(() => json({ linksets: [] }));
    const result = await harness.call('eutils_elink', {
      dbfrom: 'pubmed',
      db: 'pmc',
      uids: ['20210808'],
      cmd: 'neighbor_score',
    });
    expect(result.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });
  it('does not expose llinkslib or a retmode input', () => {
    const harness = createHarness(() => json({ linksets: [] }));
    const schema = harness.configs.get('eutils_elink').inputSchema;
    expect(schema.safeParse({ dbfrom: 'pubmed', uids: ['1'], cmd: 'llinkslib' }).success).toBe(false);
    const keys = Object.keys(schema.shape);
    expect(keys).not.toContain('retmode');
    expect(keys).not.toContain('rettype');
  });
});
describe('ELink output', () => {
  it('returns acheck available links in structured content', async () => {
    const harness = createHarness(() => json(loadJson('elink-acheck.json')));
    const result = await harness.call('eutils_elink', {
      dbfrom: 'protein',
      uids: ['15718680'],
      cmd: 'acheck',
      response_format: 'json',
    });
    expect(result.structuredContent.available_links).toHaveLength(2);
    expect(result.structuredContent.groups).toEqual([]);
    expect(result.structuredContent.available_links[0].dbto).toBe('bioproject');
  });
  it('renders acheck markdown instead of the no-links message', async () => {
    const harness = createHarness(() => json(loadJson('elink-acheck.json')));
    const result = await harness.call('eutils_elink', {
      dbfrom: 'protein',
      uids: ['15718680'],
      cmd: 'acheck',
    });
    const markdown = result.content[0].text;
    expect(markdown).toContain('Available links');
    expect(markdown).toContain('protein_bioproject');
    expect(markdown).toContain('bioproject');
    expect(markdown).not.toContain('No links found');
  });
  it('renders lcheck checks instead of the no-links message', async () => {
    const harness = createHarness(() => json(loadJson('elink-lcheck.json')));
    const result = await harness.call('eutils_elink', {
      dbfrom: 'protein',
      uids: ['15718680', '157427902'],
      cmd: 'lcheck',
    });
    const markdown = result.content[0].text;
    expect(markdown).toContain('LinkOut checks');
    expect(markdown).toContain('15718680');
    expect(markdown).not.toContain('No links found');
  });
  it('exposes neighbor_score scores aligned with ids', async () => {
    const harness = createHarness(() => json(loadJson('elink-neighbor-score.json')));
    const result = await harness.call('eutils_elink', {
      dbfrom: 'pubmed',
      uids: ['20210808'],
      cmd: 'neighbor_score',
      response_format: 'json',
    });
    expect(result.structuredContent.groups[0].ids).toEqual(['20210809', '20210810']);
    expect(result.structuredContent.groups[0].scores).toEqual([100, 50]);
    expect(result.structuredContent.total_linked).toBe(2);
  });
  it('says no links only when every result is empty', async () => {
    const harness = createHarness(() => json({ linksets: [] }));
    const result = await harness.call('eutils_elink', {
      dbfrom: 'gene',
      uids: ['7173'],
    });
    expect(result.content[0].text).toContain('No links found');
    expect(result.structuredContent.groups).toEqual([]);
  });
});
describe('ECitMatch request', () => {
  it('sends rettype=xml with retmode=xml and CR-joined bdata', async () => {
    const harness = createHarness(() => text('science|1987|235|182|palmenberg ac|Art2|3026048'));
    const result = await harness.call('eutils_ecitmatch', {
      citations: ['science|1987|235|182|palmenberg ac|Art2|', 'a|1|2|3|p|K1|'],
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]!.endpoint).toBe('ecitmatch.cgi');
    expect(harness.calls[0]!.params['rettype']).toBe('xml');
    expect(harness.calls[0]!.params['retmode']).toBe('xml');
    expect(harness.calls[0]!.params['db']).toBe('pubmed');
    const bdata = String(harness.calls[0]!.params['bdata']);
    expect(bdata.split('\r')).toHaveLength(2);
  });
});
