import { describe, expect, it } from 'vitest';
import { createHarness, json } from './toolHarness.js';

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
