import { describe, expect, it } from 'vitest';
import { createHarness, text } from './toolHarness.js';

describe('MCP cancellation wiring', () => {
  it('passes the request signal to the E-utilities client', async () => {
    const harness = createHarness(() => text('>NP_005537.3 example'));
    const controller = new AbortController();
    await harness.call(
      'eutils_efetch',
      { db: 'protein', uids: ['NP_005537.3'], rettype: 'fasta', response_format: 'markdown' },
      controller.signal,
    );
    expect(harness.calls[0]!.signal).toBe(controller.signal);
  });
});
