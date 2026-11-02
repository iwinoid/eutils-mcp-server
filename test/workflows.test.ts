import { describe, expect, it } from 'vitest';
import { createHarness, json, text } from './toolHarness.js';
describe('link_then_fetch', () => {
  it('prefers the canonical dbfrom_dbto link and reports bounded counts', async () => {
    const harness = createHarness((req) => {
      if (req.endpoint === 'epost.fcgi') {
        return text(
          '<ePostResult><WebEnv>MCID_X</WebEnv><QueryKey>1</QueryKey></ePostResult>',
          200,
          'text/xml',
        );
      }
      if (req.endpoint === 'elink.fcgi') {
        return json({
          linksets: [
            {
              linksetdbhistories: [
                { dbto: 'protein', linkname: 'gene_protein_refs', querykey: '2' },
                { dbto: 'protein', linkname: 'gene_protein', querykey: '3' },
              ],
              webenv: 'MCID_Y',
            },
          ],
        });
      }
      if (req.endpoint === 'efetch.fcgi') return text('>NP_005537.3 example\nMAAA');
      return text('unexpected', 500);
    });
    const result = await harness.call('eutils_link_then_fetch', {
      dbfrom: 'gene',
      db: 'protein',
      uids: ['7173'],
      retmax: 20,
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.source_total).toBe(1);
    expect(result.structuredContent.requested).toBe(20);
    expect(result.structuredContent.retrieved).toBe(1);
    expect(result.structuredContent.linkname).toBe('gene_protein');
    expect(result.structuredContent.history.query_key).toBe('3');
    expect(result.structuredContent.rettype).toBe('fasta');
    expect(result.structuredContent.retmode).toBe('text');
    const efetch = harness.calls.find((call) => call.endpoint === 'efetch.fcgi');
    expect(efetch!.params).toMatchObject({ rettype: 'fasta', retmode: 'text' });
  });
});
function searchJson(count: number): unknown {
  return {
    esearchresult: {
      count: String(count),
      idlist: [],
      webenv: 'MCID_S',
      querykey: '1',
      querytranslation: '',
      translationset: [],
    },
  };
}
function elinkJson(dbto: string): unknown {
  return {
    linksets: [
      {
        linksetdbhistories: [{ dbto, linkname: 'pubmed_' + dbto, querykey: '2' }],
        webenv: 'MCID_L',
      },
    ],
  };
}
describe('search_then_fetch format defaults', () => {
  it.each(['pmc', 'gene'])('sends no format parameters for %s and does not throw', async (db) => {
    const harness = createHarness((req) => {
      if (req.endpoint === 'esearch.fcgi') return json(searchJson(3));
      if (req.endpoint === 'efetch.fcgi') return text('<records />');
      return text('unexpected', 500);
    });
    const result = await harness.call('eutils_search_then_fetch', {
      db,
      term: 'example',
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    const efetch = harness.calls.find((call) => call.endpoint === 'efetch.fcgi');
    expect(efetch!.params).not.toHaveProperty('rettype');
    expect(efetch!.params).not.toHaveProperty('retmode');
    expect(result.structuredContent.rettype).toBe('default');
    expect(result.structuredContent.retmode).toBe('default');
    expect(result.structuredContent.retrieved).toBe(3);
  });
  it('keeps the PubMed abstract default', async () => {
    const harness = createHarness((req) => {
      if (req.endpoint === 'esearch.fcgi') return json(searchJson(2));
      if (req.endpoint === 'efetch.fcgi') return text('Abstract text');
      return text('unexpected', 500);
    });
    const result = await harness.call('eutils_search_then_fetch', {
      db: 'pubmed',
      term: 'example',
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    const efetch = harness.calls.find((call) => call.endpoint === 'efetch.fcgi');
    expect(efetch!.params).toMatchObject({ rettype: 'abstract', retmode: 'text' });
    expect(result.structuredContent.rettype).toBe('abstract');
    expect(result.structuredContent.retmode).toBe('text');
  });
});
describe('link_then_fetch format defaults', () => {
  it('sends no format parameters for a PMC target and does not throw', async () => {
    const harness = createHarness((req) => {
      if (req.endpoint === 'epost.fcgi') {
        return text('<ePostResult><WebEnv>MCID_X</WebEnv><QueryKey>1</QueryKey></ePostResult>');
      }
      if (req.endpoint === 'elink.fcgi') return json(elinkJson('pmc'));
      if (req.endpoint === 'efetch.fcgi') return text('<pmc-articleset />');
      return text('unexpected', 500);
    });
    const result = await harness.call('eutils_link_then_fetch', {
      dbfrom: 'pubmed',
      db: 'pmc',
      uids: ['31452104'],
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    const efetch = harness.calls.find((call) => call.endpoint === 'efetch.fcgi');
    expect(efetch!.params).not.toHaveProperty('rettype');
    expect(efetch!.params).not.toHaveProperty('retmode');
    expect(result.structuredContent.rettype).toBe('default');
    expect(result.structuredContent.retmode).toBe('default');
  });
  it('maps an explicit PMC text request to MEDLINE', async () => {
    const harness = createHarness((req) => {
      if (req.endpoint === 'epost.fcgi') {
        return text('<ePostResult><WebEnv>MCID_X</WebEnv><QueryKey>1</QueryKey></ePostResult>');
      }
      if (req.endpoint === 'elink.fcgi') return json(elinkJson('pmc'));
      if (req.endpoint === 'efetch.fcgi') return text('PMID- 1');
      return text('unexpected', 500);
    });
    const result = await harness.call('eutils_link_then_fetch', {
      dbfrom: 'pubmed',
      db: 'pmc',
      uids: ['31452104'],
      retmode: 'text',
      response_format: 'json',
    });
    expect(result.isError).toBeFalsy();
    const efetch = harness.calls.find((call) => call.endpoint === 'efetch.fcgi');
    expect(efetch!.params).toMatchObject({ rettype: 'medline', retmode: 'text' });
    expect(result.structuredContent.rettype).toBe('medline');
  });
});
