import { describe, expect, it } from 'vitest';
import { createHarness, json } from './toolHarness.js';

describe('ELink defaults', () => {
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
