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
  });
});
